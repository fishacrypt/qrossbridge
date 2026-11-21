// Deploy and activate a dedicated, validator-attested stablecoin liquidity rail
// on the replacement QROS Gateway ledgers. This does not touch legacy ledgers,
// move user balances, or fund adapter liquidity.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor, HUB_ID } = require('./chains');

const ROOT = path.join(__dirname, '..');
const DEPLOYMENTS = path.join(ROOT, 'gateway-migration-deployments.json');
const OUTPUT = path.join(ROOT, 'gateway-stablecoin-deployments.json');
const BASE_ID = 84532;

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.basename(file) + '. Complete the Gateway migration deployment first.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function keyOf(value, label) {
  const key = value && !value.startsWith('0x') ? '0x' + value : value;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(label + ' must be configured in local .env.');
  return key;
}
function addr(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' is missing or invalid.');
  return ethers.getAddress(value);
}
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function artifact(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json. Run npm.cmd run compile first.');
  const value = readJson(file);
  if (!Array.isArray(value.abi) || !value.bytecode || value.bytecode === '0x') throw new Error('Invalid deployable artifact: ' + name);
  return value;
}
async function ensureCode(provider, address, label) {
  if (await provider.getCode(address) === '0x') throw new Error(label + ' has no deployed code at ' + address);
}
async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' failed.');
  console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
}
async function deployAdapter({ provider, wallet, owner, chainId, ledger, verifier, coordinator, state }) {
  const key = String(chainId);
  const previous = state.chains[key]?.adapter;
  if (previous?.address) {
    await ensureCode(provider, addr(previous.address, 'Recorded stablecoin adapter'), chains[chainId].name + ' recorded stablecoin adapter');
    console.log('  reuse stablecoin adapter: ' + previous.address);
    return previous;
  }
  const a = artifact('QrosAttestedLiquidityAdapter');
  const instance = await new ethers.ContractFactory(a.abi, a.bytecode, wallet)
    .deploy(owner, ledger, verifier, coordinator);
  const tx = instance.deploymentTransaction();
  if (!tx) throw new Error('Missing stablecoin adapter deployment transaction.');
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(chains[chainId].name + ' stablecoin adapter deployment failed.');
  const address = await instance.getAddress();
  await ensureCode(provider, address, chains[chainId].name + ' stablecoin adapter');
  const record = { address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber, owner, chainId, deployedAt: new Date().toISOString() };
  state.chains[key].adapter = record;
  writeJson(OUTPUT, state);
  console.log('  ✓ deployed stablecoin adapter: ' + address + ' [' + receipt.hash + ']');
  return record;
}

async function main() {
  const migration = readJson(DEPLOYMENTS);
  const qmsKey = keyOf(process.env.QMS_OWNER_KEY, 'QMS_OWNER_KEY');
  const baseKey = keyOf(process.env.BASE_OWNER_KEY, 'BASE_OWNER_KEY');
  const configs = [
    { id: HUB_ID, key: qmsKey, asset: addr(process.env.STABLECOIN_QMS_ADDRESS, 'STABLECOIN_QMS_ADDRESS'), treasury: addr(process.env.STABLECOIN_QMS_TREASURY, 'STABLECOIN_QMS_TREASURY') },
    { id: BASE_ID, key: baseKey, asset: addr(process.env.STABLECOIN_BASE_ADDRESS, 'STABLECOIN_BASE_ADDRESS'), treasury: addr(process.env.STABLECOIN_BASE_TREASURY, 'STABLECOIN_BASE_TREASURY') }
  ];
  if (same(configs[0].asset, configs[1].asset)) throw new Error('QMS and Base stablecoin addresses must be configured independently.');
  if (migration.project !== 'QROS Gateway Ledger Migration') throw new Error('Unexpected migration manifest.');
  const state = fs.existsSync(OUTPUT) ? readJson(OUTPUT) : {
    schemaVersion: 1,
    project: 'QROS Gateway Stablecoin Settlement',
    status: 'configuring',
    hubChainId: HUB_ID,
    assetSymbol: process.env.STABLECOIN_SYMBOL || 'USDT',
    trustModel: 'Prefunded destination liquidity with threshold validator attestations; not a trustless bridge or issuer-native burn/mint bridge.',
    chains: {},
    safety: { legacyLedgersUntouched: true, qmsWqmsRailUntouched: true, userBalancesUnchanged: true, liquidityFundingAutomatic: false }
  };
  if (state.project !== 'QROS Gateway Stablecoin Settlement') throw new Error('Stablecoin manifest has an unexpected project identity.');

  const contexts = new Map();
  const providers = [];
  try {
    // Preflight both chains before sending any transaction.
    for (const cfg of configs) {
      const id = cfg.id, key = String(id), deployment = migration.chains?.[key];
      const contracts = deployment?.contracts;
      if (!contracts?.gatewayLedger?.address || !contracts?.transferCoordinator?.address || !contracts?.settlementVerifier?.address) {
        throw new Error('Replacement Gateway contracts are incomplete on chain ' + id + '.');
      }
      const owner = addr(deployment.owner, chains[id].name + ' Gateway owner');
      const signer = new ethers.Wallet(cfg.key);
      if (!same(signer.address, owner)) throw new Error(chains[id].name + ' owner key does not match the replacement Gateway owner.');
      const provider = new ethers.JsonRpcProvider(rpcFor(id), id, { staticNetwork: true, cacheTimeout: -1 });
      providers.push(provider);
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== id) throw new Error(chains[id].name + ' RPC chain ID mismatch.');
      const ledgerAddress = addr(contracts.gatewayLedger.address, 'Gateway ledger');
      const coordinatorAddress = addr(contracts.transferCoordinator.address, 'Transfer coordinator');
      const verifierAddress = addr(contracts.settlementVerifier.address, 'Settlement verifier');
      for (const [a, label] of [[cfg.asset, 'stablecoin'], [ledgerAddress, 'Gateway ledger'], [coordinatorAddress, 'coordinator'], [verifierAddress, 'settlement verifier']]) {
        await ensureCode(provider, a, chains[id].name + ' ' + label);
      }
      const wallet = new ethers.NonceManager(new ethers.Wallet(cfg.key, provider));
      const token = new ethers.Contract(cfg.asset, [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)'
      ], wallet);
      const ledger = new ethers.Contract(ledgerAddress, artifact('QrosGatewayLedger').abi, wallet);
      const coordinator = new ethers.Contract(coordinatorAddress, artifact('QrosTransferCoordinator').abi, wallet);
      const verifier = new ethers.Contract(verifierAddress, artifact('QrosQuorumAttestationVerifier').abi, wallet);
      const decimals = Number(await token.decimals());
      const symbol = await token.symbol();
      if (decimals < 1 || decimals > 18) throw new Error(chains[id].name + ' stablecoin decimals are outside the supported 1–18 range.');
      if (symbol !== state.assetSymbol) throw new Error(chains[id].name + ' token symbol is ' + symbol + ', expected ' + state.assetSymbol + '.');
      if (Number(await verifier.signerCount()) < 2 || Number(await verifier.threshold()) < 2) {
        throw new Error(chains[id].name + ' settlement verifier does not have an active 2+ validator quorum.');
      }
      if (!same(await ledger.owner(), owner) || !same(await coordinator.owner(), owner)) {
        throw new Error(chains[id].name + ' replacement Gateway ownership mismatch.');
      }
      if (!same(await coordinator.ledger(), ledgerAddress)) throw new Error(chains[id].name + ' coordinator is bound to a different ledger.');
      state.chains[key] = {
        ...(state.chains[key] || {}),
        name: chains[id].name, chainId: id, owner, asset: cfg.asset, symbol, decimals,
        treasury: cfg.treasury, gatewayLedger: ledgerAddress, transferCoordinator: coordinatorAddress,
        settlementVerifier: verifierAddress
      };
      contexts.set(id, { ...cfg, owner, provider, wallet, token, ledger, coordinator, verifier, decimals, symbol,
        ledgerAddress, coordinatorAddress, verifierAddress });
    }
    if (contexts.get(HUB_ID).decimals !== contexts.get(BASE_ID).decimals) {
      throw new Error('QMS and Base stablecoin decimals must match for 1:1 raw-unit settlement.');
    }

    // Deploy adapters, then enable only this stablecoin on the replacement ledgers.
    for (const id of [HUB_ID, BASE_ID]) {
      const c = contexts.get(id);
      const deployment = await deployAdapter({
        provider: c.provider, wallet: c.wallet, owner: c.owner, chainId: id,
        ledger: c.ledgerAddress, verifier: c.verifierAddress, coordinator: c.coordinatorAddress, state
      });
      c.adapterAddress = addr(deployment.address, 'Stablecoin adapter');
      const currentAdapter = await c.ledger.settlementAdapters(c.asset);
      if (!await c.ledger.supportedAssets(c.asset)) {
        await send(chains[id].name + ' enable stablecoin Gateway custody', c.ledger.setAssetSupport(c.asset, true));
      }
      if (currentAdapter === ethers.ZeroAddress) {
        await send(chains[id].name + ' assign stablecoin settlement adapter', c.ledger.setSettlementAdapterForAsset(c.asset, c.adapterAddress));
      } else if (!same(currentAdapter, c.adapterAddress)) {
        throw new Error(chains[id].name + ' stablecoin already has a different settlement adapter; refusing to replace it.');
      }
      if (!await c.coordinator.approvedAdapters(c.adapterAddress)) {
        await send(chains[id].name + ' approve stablecoin adapter in coordinator', c.coordinator.setAdapter(c.adapterAddress, true));
      }
      const adapter = new ethers.Contract(c.adapterAddress, artifact('QrosAttestedLiquidityAdapter').abi, c.wallet);
      const treasury = await adapter.settlementTreasury();
      if (treasury === ethers.ZeroAddress) {
        await send(chains[id].name + ' set stablecoin settlement treasury', adapter.setSettlementTreasury(c.treasury));
      } else if (!same(treasury, c.treasury)) {
        throw new Error(chains[id].name + ' stablecoin adapter already has a different settlement treasury.');
      }
      c.adapter = adapter;
    }

    // Configure both directions and destination proof routes. Each chain's adapter
    // escrows its own source token; the destination adapter pays from prefunded inventory.
    for (const sourceId of [HUB_ID, BASE_ID]) {
      const source = contexts.get(sourceId);
      const destinationId = sourceId === HUB_ID ? BASE_ID : HUB_ID;
      const destination = contexts.get(destinationId);
      const outboundId = await source.adapter.routeId(source.asset, destinationId, destination.asset);
      if (!await source.adapter.outboundRouteEnabled(outboundId)) {
        await send(chains[sourceId].name + ' enable outbound stablecoin route to ' + chains[destinationId].name,
          source.adapter.setOutboundRoute(source.asset, destinationId, destination.asset, true));
      }
      // Delivery is verified on the destination chain; source escrow release is
      // independently verified on the source chain. Both verifier instances need
      // the exact same route tuple for their respective EIP-712 proof types.
      for (const verifierContext of [source, destination]) {
        const routeKey = await verifierContext.verifier.routeKey(
          sourceId, destinationId, source.asset, destination.asset, destination.ledgerAddress
        );
        if (!await verifierContext.verifier.enabledRoute(routeKey)) {
          await send(chains[verifierContext.id].name + ' enable stablecoin proof route ' +
            sourceId + ' -> ' + destinationId,
            verifierContext.verifier.setRoute(sourceId, destinationId, source.asset,
              destination.asset, destination.ledgerAddress, true));
        }
      }
    }

    for (const id of [HUB_ID, BASE_ID]) {
      const c = contexts.get(id);
      state.chains[String(id)].adapter = {
        ...(state.chains[String(id)].adapter || {}),
        address: c.adapterAddress,
        owner: c.owner,
        chainId: id
      };
      state.chains[String(id)].configured = {
        assetSupport: await c.ledger.supportedAssets(c.asset),
        settlementAdapter: await c.ledger.settlementAdapters(c.asset),
        coordinatorApproved: await c.coordinator.approvedAdapters(c.adapterAddress),
        settlementTreasury: await c.adapter.settlementTreasury()
      };
    }
    state.status = 'configured-awaiting-prefunded-liquidity';
    state.configuredAt = new Date().toISOString();
    state.liquidityNote = 'Adapters are configured but not funded. Fund each destination adapter with the corresponding local stablecoin before enabling user transfers.';
    writeJson(OUTPUT, state);
    console.log('\nStablecoin Gateway settlement configured on QMS Testnet and Base Sepolia.');
    console.log('Manifest: gateway-stablecoin-deployments.json');
    console.log('Next: fund each adapter with its local stablecoin inventory. Transfers remain unavailable until liquidity is funded.');
    console.log('The QMS/wQMS rail and all legacy Gateway balances were left untouched.');
  } finally {
    await Promise.all(providers.map(provider => provider.destroy().catch(() => {})));
  }
}

main().catch(error => {
  console.error('\nStablecoin Gateway activation stopped:', error.stack || error);
  process.exitCode = 1;
});
