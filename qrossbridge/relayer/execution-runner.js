
// QROS stablecoin execution worker.
// Separate from the existing native QMS bridge relayer.
// Initial route: QMS Testnet (19480) -> Base Sepolia (84532).

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { rpcFor } = require('../scripts/chains');

const QMS_ID = 19480;
const BASE_ID = 84532;

const QMS_ASSETS = {
  USDC: '0xDd4D61DF875cc613E1372c78827a5F4C2741bf11',
  USDT: '0x5D1386fC130143F92511bC2D18124D3E414ed429'
};

const GATEWAY_ABI = [
  'event ExecutionRequested(bytes32 indexed requestId,address indexed user,address indexed sourceAsset,address destinationAsset,uint256 sourceAmount,uint256 destinationAmount,uint256 destinationChainId,bytes32 strategyId)',
  'function destinationChainId() view returns (uint256)',
  'function relayer() view returns (address)',
  'function requests(bytes32) view returns (address user,address sourceAsset,address destinationAsset,address lp,uint256 sourceAmount,uint256 destinationAmount,bytes32 strategyId,uint8 status)',
  'function assetRoutes(address) view returns (address destinationAsset,address lp,uint16 feeBps,bool enabled)',
  'function markExecuted(bytes32 requestId)'
];

const VAULT_ABI = [
  'function sourceChainId() view returns (uint256)',
  'function relayer() view returns (address)',
  'function supportedAssets(address) view returns (bool)',
  'function processedRequests(bytes32) view returns (bool)',
  'function positions(bytes32) view returns (address user,address asset,uint256 amount,bytes32 strategyId,uint8 status)',
  'function reserveRequest(bytes32 requestId,address user,address asset,uint256 amount,bytes32 strategyId)',
  'function activatePosition(bytes32 requestId)',
  'function cancelReservation(bytes32 requestId)'
];

const STATUS = {
  GATEWAY_PENDING: 1,
  GATEWAY_ACTIVE: 2,
  GATEWAY_FAILED: 3,
  VAULT_RESERVED: 1,
  VAULT_ACTIVE: 2,
  VAULT_CLOSED: 3,
  VAULT_CANCELLED: 4
};

const sameAddress = (a, b) =>
  ethers.getAddress(a) === ethers.getAddress(b);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fileStore(file) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    save(state) {
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2));
      fs.renameSync(temp, file);
    }
  };
}

class ExecutionRunner {
  constructor(config) {
    this.root = config.root;
    this.confirmations = config.confirmations;
    this.maxRange = config.maxRange;
    this.pollMs = config.pollMs;
    this.log = message =>
      console.log(new Date().toISOString(), message);

    this.store = fileStore(
      path.join(this.root, 'execution-relayer-state.json')
    );

    this.state = this.store.load();
    this.state.lastBlock ??= Math.max(
      0,
      Number(config.deployments.qmsStartBlock) - 1
    );
    this.state.requests ??= {};

    this.qmsProvider = config.qmsProvider;
    this.baseProvider = config.baseProvider;

    this.walletQms = new ethers.Wallet(
      config.key,
      this.qmsProvider
    );

    this.walletBase = new ethers.Wallet(
      config.key,
      this.baseProvider
    );

    this.gatewayAddress = ethers.getAddress(
      config.deployments.gateway.address
    );

    this.vaultAddress = ethers.getAddress(
      config.deployments.vault.address
    );

    this.gateway = new ethers.Contract(
      this.gatewayAddress,
      GATEWAY_ABI,
      this.walletQms
    );

    this.vault = new ethers.Contract(
      this.vaultAddress,
      VAULT_ABI,
      this.walletBase
    );

    this.assets = config.assets;
    this.stopped = false;
  }

  async verifySetup() {
    const [qmsNetwork, baseNetwork] = await Promise.all([
      this.qmsProvider.getNetwork(),
      this.baseProvider.getNetwork()
    ]);

    if (Number(qmsNetwork.chainId) !== QMS_ID) {
      throw new Error('QMS RPC returned the wrong chain ID');
    }

    if (Number(baseNetwork.chainId) !== BASE_ID) {
      throw new Error('Base RPC returned the wrong chain ID');
    }

    const addresses = [
      this.gatewayAddress,
      this.vaultAddress,
      ...Object.values(QMS_ASSETS),
      ...Object.values(this.assets)
    ];

    for (const address of addresses) {
      if ((await this.qmsProvider.getCode(address)) === '0x' &&
          Object.values(QMS_ASSETS).includes(address)) {
        throw new Error(`QMS token has no contract code: ${address}`);
      }
    }

    if (await this.qmsProvider.getCode(this.gatewayAddress) === '0x') {
      throw new Error('Gateway contract not found on QMS');
    }

    if (await this.baseProvider.getCode(this.vaultAddress) === '0x') {
      throw new Error('Liquidity vault not found on Base');
    }

    for (const address of Object.values(this.assets)) {
      if (await this.baseProvider.getCode(address) === '0x') {
        throw new Error(`Base stablecoin not found: ${address}`);
      }
    }

    if (Number(await this.gateway.destinationChainId()) !== BASE_ID) {
      throw new Error('Gateway destination chain is not Base Sepolia');
    }

    if (Number(await this.vault.sourceChainId()) !== QMS_ID) {
      throw new Error('Vault source chain is not QMS Testnet');
    }

    if (!sameAddress(
      await this.gateway.relayer(),
      this.walletQms.address
    )) {
      throw new Error('Gateway relayer does not match RELAYER_KEY');
    }

    if (!sameAddress(
      await this.vault.relayer(),
      this.walletBase.address
    )) {
      throw new Error('Vault relayer does not match RELAYER_KEY');
    }

    this.log(`QMS gateway: ${this.gatewayAddress}`);
    this.log(`Base vault: ${this.vaultAddress}`);
    this.log(`Execution relayer: ${this.walletQms.address}`);
    this.log('Contract and network checks passed');
  }

  async waitForTransaction(tx, label) {
    this.log(`${label}: submitted ${tx.hash}`);

    const receipt = await tx.wait(this.confirmations);

    if (!receipt || receipt.status !== 1) {
      throw new Error(`${label}: transaction failed`);
    }

    this.log(`${label}: confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }

  async getPosition(requestId) {
    return this.vault.positions(requestId);
  }

  async processRequest(event) {
    const {
      requestId,
      user,
      sourceAsset,
      destinationAsset,
      sourceAmount,
      destinationAmount,
      destinationChainId,
      strategyId
    } = event;

    const id = requestId.toLowerCase();

    if (Number(destinationChainId) !== BASE_ID) {
      throw new Error('Request targets an unsupported destination chain');
    }

    const sourceSymbol = Object.keys(QMS_ASSETS).find(
      symbol => sameAddress(QMS_ASSETS[symbol], sourceAsset)
    );

    if (!sourceSymbol) {
      throw new Error('Request uses an unsupported QMS source asset');
    }

    const expectedDestination = this.assets[sourceSymbol];

    if (!expectedDestination ||
        !sameAddress(destinationAsset, expectedDestination)) {
      throw new Error('Source/destination stablecoin pair is not approved');
    }

    // Verify the event against the actual QMS gateway request.
    const request = await this.gateway.requests(requestId);

    if (!sameAddress(request.user, user) ||
        !sameAddress(request.sourceAsset, sourceAsset) ||
        !sameAddress(request.destinationAsset, destinationAsset) ||
        request.sourceAmount !== sourceAmount ||
        request.destinationAmount !== destinationAmount ||
        request.strategyId.toLowerCase() !== strategyId.toLowerCase()) {
      throw new Error('Execution event does not match gateway storage');
    }

    const route = await this.gateway.assetRoutes(sourceAsset);

    if (!route.enabled ||
        !sameAddress(route.destinationAsset, destinationAsset) ||
        !sameAddress(route.lp, request.lp)) {
      throw new Error('Gateway asset route verification failed');
    }

    if (!await this.vault.supportedAssets(destinationAsset)) {
      throw new Error('Destination asset is not supported by the vault');
    }

    let gatewayStatus = Number(request.status);
    let position = await this.getPosition(requestId);
    let positionStatus = Number(position.status);

    // A failed source request can only release a reservation.
    if (gatewayStatus === STATUS.GATEWAY_FAILED) {
      if (positionStatus === STATUS.VAULT_RESERVED) {
        const tx = await this.vault.cancelReservation(requestId);
        await this.waitForTransaction(tx, `Cancel ${id}`);
      }
      return;
    }

    if (gatewayStatus !== STATUS.GATEWAY_PENDING &&
        gatewayStatus !== STATUS.GATEWAY_ACTIVE) {
      throw new Error(`Unexpected gateway request status: ${gatewayStatus}`);
    }

    // Stage 1: reserve actual destination liquidity.
    if (gatewayStatus === STATUS.GATEWAY_PENDING &&
        positionStatus === 0) {
      const alreadyProcessed =
        await this.vault.processedRequests(requestId);

      if (alreadyProcessed) {
        throw new Error(
          'Vault processed request but no position exists; manual review required'
        );
      }

      const tx = await this.vault.reserveRequest(
        requestId,
        user,
        destinationAsset,
        destinationAmount,
        strategyId
      );

      await this.waitForTransaction(tx, `Reserve ${id}`);

      position = await this.getPosition(requestId);
      positionStatus = Number(position.status);

      if (positionStatus !== STATUS.VAULT_RESERVED) {
        throw new Error('Destination reservation was not confirmed');
      }
    }

    // Never settle QMS if the destination position is not reserved.
    if (gatewayStatus === STATUS.GATEWAY_PENDING) {
      if (positionStatus === STATUS.VAULT_CANCELLED) {
        throw new Error(
          'Destination reservation was cancelled; manual review required'
        );
      }

      if (positionStatus !== STATUS.VAULT_RESERVED) {
        throw new Error('Destination liquidity is not safely reserved');
      }

      // Stage 2: settle the source funds to the configured LP.
      const tx = await this.gateway.markExecuted(requestId);
      await this.waitForTransaction(tx, `Settle QMS ${id}`);

      gatewayStatus = Number(
        (await this.gateway.requests(requestId)).status
      );

      if (gatewayStatus !== STATUS.GATEWAY_ACTIVE) {
        throw new Error('QMS source settlement was not confirmed');
      }
    }

    // Stage 3: activate the already-reserved destination position.
    // If this fails, the next polling cycle retries this stage.
    if (gatewayStatus === STATUS.GATEWAY_ACTIVE) {
      position = await this.getPosition(requestId);
      positionStatus = Number(position.status);

      if (positionStatus === STATUS.VAULT_RESERVED) {
        const tx = await this.vault.activatePosition(requestId);
        await this.waitForTransaction(tx, `Activate ${id}`);

        position = await this.getPosition(requestId);
        positionStatus = Number(position.status);
      }

      if (positionStatus !== STATUS.VAULT_ACTIVE &&
          positionStatus !== STATUS.VAULT_CLOSED) {
        throw new Error(
          'QMS settled, but Base position is not active; retry required'
        );
      }

      this.log(`Execution complete: ${id}`);
    }

    this.state.requests[id] = {
      status: 'processed',
      updatedAt: new Date().toISOString()
    };

    this.store.save(this.state);
  }

  async scan() {
    const head = await this.qmsProvider.getBlockNumber();
    const safeBlock = head - this.confirmations;

    let from = Number(this.state.lastBlock) + 1;

    while (from <= safeBlock) {
      const to = Math.min(
        from + this.maxRange - 1,
        safeBlock
      );

      const logs = await this.qmsProvider.getLogs({
        address: this.gatewayAddress,
        topics: [ethers.id(
          'ExecutionRequested(bytes32,address,address,address,uint256,uint256,uint256,bytes32)'
        )],
        fromBlock: from,
        toBlock: to
      });

      logs.sort((a, b) =>
        a.blockNumber - b.blockNumber || a.index - b.index
      );

      for (const log of logs) {
        const parsed = this.gateway.interface.parseLog(log);

        const event = {
          requestId: parsed.args.requestId,
          user: parsed.args.user,
          sourceAsset: parsed.args.sourceAsset,
          destinationAsset: parsed.args.destinationAsset,
          sourceAmount: parsed.args.sourceAmount,
          destinationAmount: parsed.args.destinationAmount,
          destinationChainId: parsed.args.destinationChainId,
          strategyId: parsed.args.strategyId
        };

        try {
          await this.processRequest(event);
        } catch (error) {
          this.log(
            `Request ${event.requestId}: ${
              error.shortMessage || error.message || error
            }`
          );

          // Revisit this block on the next polling cycle.
          this.state.lastBlock = log.blockNumber - 1;
          this.store.save(this.state);
          return;
        }
      }

      this.state.lastBlock = to;
      this.store.save(this.state);
      from = to + 1;
    }
  }

  async run() {
    await this.verifySetup();

    this.log('Stablecoin execution worker started');

    while (!this.stopped) {
      try {
        await this.scan();
      } catch (error) {
        this.log(
          `Worker error: ${
            error.shortMessage || error.message || error
          }`
        );
      }

      await sleep(this.pollMs);
    }
  }

  stop() {
    this.stopped = true;
  }
}

async function main() {
  const root = path.join(__dirname, '..');

  const deploymentFile = path.join(
    root,
    'execution-deployments.json'
  );

  const stablecoinFile = path.join(
    root,
    'stablecoin-deployments.json'
  );

  if (!fs.existsSync(deploymentFile)) {
    throw new Error(
      'execution-deployments.json is missing. Deploy the execution contracts first.'
    );
  }

  if (!fs.existsSync(stablecoinFile)) {
    throw new Error('stablecoin-deployments.json is missing');
  }

  if (!process.env.RELAYER_KEY) {
    throw new Error('Set RELAYER_KEY in .env');
  }

  const deployments = JSON.parse(
    fs.readFileSync(deploymentFile, 'utf8')
  );

  const stablecoins = JSON.parse(
    fs.readFileSync(stablecoinFile, 'utf8')
  );

  if (Number(deployments.qmsChainId) !== QMS_ID ||
      Number(deployments.destinationChainId) !== BASE_ID) {
    throw new Error('Execution deployment chain IDs are invalid');
  }

  if (Number(stablecoins.chainId) !== BASE_ID) {
    throw new Error('Stablecoin deployment is not for Base Sepolia');
  }

  const assets = {};

  for (const [symbol, asset] of Object.entries(stablecoins.assets)) {
    if (!['USDC', 'USDT'].includes(symbol)) continue;

    if (Number(asset.decimals) !== 6) {
      throw new Error(`${symbol} must have 6 decimals`);
    }

    assets[symbol] = ethers.getAddress(asset.address);
  }

  if (!assets.USDC || !assets.USDT) {
    throw new Error('Both USDC and USDT addresses are required');
  }

  const qmsProvider = new ethers.JsonRpcProvider(
    rpcFor(QMS_ID),
    QMS_ID,
    { staticNetwork: true, cacheTimeout: -1 }
  );

  const baseProvider = new ethers.JsonRpcProvider(
    rpcFor(BASE_ID),
    BASE_ID,
    { staticNetwork: true, cacheTimeout: -1 }
  );

  const runner = new ExecutionRunner({
    root,
    deployments,
    assets,
    key: process.env.RELAYER_KEY,
    qmsProvider,
    baseProvider,
    confirmations: Number(
      process.env.EXECUTION_CONFIRMATIONS ||
      process.env.CONFIRMATIONS ||
      3
    ),
    maxRange: Number(process.env.MAX_LOG_RANGE || 1000),
    pollMs: Number(process.env.EXECUTION_POLL_MS || 8000)
  });

  process.on('SIGINT', () => runner.stop());
  process.on('SIGTERM', () => runner.stop());

  await runner.run();
}

main().catch(error => {
  console.error('Execution worker startup failed:', error);
  process.exitCode = 1;
});
