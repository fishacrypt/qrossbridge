
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const CORE_FILE = path.join(ROOT, 'gateway-migration-deployments.json');
const PREP_FILE = path.join(ROOT, 'gateway-migration-adapter-preparations.json');
const BRIDGE_FILE = path.join(ROOT, 'deployments.json');

function read(file) {
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function write(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function address(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(label + ' missing or invalid');
  }
  return ethers.getAddress(value);
}

function same(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function key(value, label) {
  const k = value && !value.startsWith('0x') ? '0x' + value : value;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error(label + ' must be configured in local .env');
  }
  return k;
}

function artifact(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json; run compile first.');
  const a = read(file);
  if (!a.bytecode || a.bytecode === '0x' || !Array.isArray(a.abi)) {
    throw new Error('Invalid artifact ' + name);
  }
  return a;
}

async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' failed');
  console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
}

async function main() {
  const state = read(CORE_FILE);
  const prep = read(PREP_FILE);
  const bridges = read(BRIDGE_FILE);

  const id = '84532';
  const chain = state.chains?.[id];
  const pc = prep.chains?.[id];
  const bc = bridges.chains?.[id];

  if (!chain?.contracts || !pc?.qmsBridgeAdapter?.address ||
      !pc?.bridgeVerifier?.address || !bc?.bridge || !bc?.token) {
    throw new Error('Base migration deployment/preparation records are incomplete.');
  }

  const baseKey = key(process.env.BASE_OWNER_KEY, 'BASE_OWNER_KEY');
  const owner = address(chain.owner, 'Base Gateway owner');
  const walletAddress = new ethers.Wallet(baseKey).address;

  if (!same(walletAddress, owner)) {
    throw new Error('BASE_OWNER_KEY does not match Base Gateway owner ' + owner);
  }

  const provider = new ethers.JsonRpcProvider(
    rpcFor(84532), 84532, { staticNetwork: true, cacheTimeout: -1 }
  );
  const hubProvider = new ethers.JsonRpcProvider(
    rpcFor(19480), 19480, { staticNetwork: true, cacheTimeout: -1 }
  );

  try {
    const [network, hubNetwork] = await Promise.all([
      provider.getNetwork(),
      hubProvider.getNetwork()
    ]);

    if (Number(network.chainId) !== 84532) throw new Error('Base RPC chain ID mismatch.');
    if (Number(hubNetwork.chainId) !== 19480) throw new Error('QMS Hub RPC chain ID mismatch.');

    const wallet = new ethers.NonceManager(new ethers.Wallet(baseKey, provider));

    const ledgerAddress = address(chain.contracts.gatewayLedger.address, 'Base Gateway ledger');
    const coordinatorAddress = address(chain.contracts.transferCoordinator.address, 'Base coordinator');
    const settlementVerifier = address(chain.contracts.settlementVerifier.address, 'Base settlement verifier');
    const bridgeVerifier = address(pc.bridgeVerifier.address, 'Base bridge verifier');
    const bridge = address(bc.bridge, 'Existing Base Spoke');
    const token = address(bc.token, 'Existing Base wQMS');
    const hubBridge = address(bridges.chains['19480'].bridge, 'QMS Hub bridge');
    const hubToken = address(bridges.wqms, 'QMS Hub wQMS');
    const previous = address(pc.qmsBridgeAdapter.address, 'Current Base QMS adapter');

    for (const [a, label] of [
      [ledgerAddress, 'Base ledger'],
      [coordinatorAddress, 'Base coordinator'],
      [settlementVerifier, 'Base settlement verifier'],
      [bridgeVerifier, 'Base bridge verifier'],
      [bridge, 'Base legacy Spoke'],
      [token, 'Base wQMS']
    ]) {
      if (await provider.getCode(a) === '0x') {
        throw new Error(label + ' has no code on Base at ' + a);
      }
    }

    for (const [a, label] of [
      [hubBridge, 'QMS Hub bridge'],
      [hubToken, 'QMS Hub wQMS']
    ]) {
      if (await hubProvider.getCode(a) === '0x') {
        throw new Error(label + ' has no code on QMS at ' + a);
      }
    }

    const ledger = new ethers.Contract(ledgerAddress, artifact('QrosGatewayLedger').abi, wallet);
    const coordinator = new ethers.Contract(coordinatorAddress, artifact('QrosTransferCoordinator').abi, wallet);

    if (!same(await ledger.owner(), owner) || !same(await coordinator.owner(), owner)) {
      throw new Error('Base Gateway ownership verification failed.');
    }
    if (!same(await coordinator.ledger(), ledgerAddress)) {
      throw new Error('Base coordinator is not connected to the replacement ledger.');
    }
    if (!await ledger.supportedAssets(token)) {
      throw new Error('Existing Base wQMS is not enabled for Gateway custody.');
    }

    const current = await ledger.settlementAdapters(token);
    if (!same(current, previous)) {
      throw new Error('Ledger adapter changed since preparation. Expected ' + previous + ', found ' + current + '. Refusing to replace.');
    }
    if (same(current, ethers.ZeroAddress)) {
      throw new Error('No existing adapter is assigned; use the normal preparation workflow instead.');
    }

    const a = artifact('QrosQmsBridgeAdapter');
    console.log('Deploying backward-compatible Base QMS adapter...');

    const instance = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(
      owner, ledgerAddress, settlementVerifier, coordinatorAddress, bridgeVerifier,
      19480, hubBridge, hubToken, bridge, token
    );

    const receipt = await instance.deploymentTransaction().wait();
    if (!receipt || receipt.status !== 1) throw new Error('Replacement Base QMS adapter deployment failed.');

    const next = await instance.getAddress();
    if (await provider.getCode(next) === '0x') throw new Error('Replacement adapter has no deployed code.');

    if (!same(await instance.owner(), owner) ||
        !same(await instance.ledger(), ledgerAddress) ||
        !same(await instance.coordinator(), coordinatorAddress) ||
        !same(await instance.localBridge(), bridge) ||
        !same(await instance.localToken(), token)) {
      throw new Error('Replacement adapter constructor binding verification failed.');
    }

    console.log('  ✓ deployed replacement adapter ' + next + ' [' + receipt.hash + ']');

    await send('replace Base wQMS settlement adapter',
      ledger.setSettlementAdapterForAsset(token, next));

    if (!same(await ledger.settlementAdapters(token), next)) {
      throw new Error('Ledger did not retain replacement adapter.');
    }

    if (!await coordinator.approvedAdapters(next)) {
      await send('approve replacement Base QMS adapter', coordinator.setAdapter(next, true));
    }

    if (!await coordinator.approvedAdapters(next)) {
      throw new Error('Coordinator approval did not persist.');
    }

    const record = {
      contractName: 'QrosQmsBridgeAdapter',
      address: next,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      owner,
      deployer: walletAddress,
      chainId: 84532,
      replaces: previous,
      compatibility: 'legacy-spoke-bridgeBack'
    };

    pc.previousQmsBridgeAdapter = previous;
    pc.qmsBridgeAdapter = record;
    pc.legacySpokeCompatibility = 'bridgeBack(uint256,address,bool); no Spoke redeployment required';
    chain.contracts.qmsBridgeAdapter = record;
    chain.compatibility = pc.legacySpokeCompatibility;
    chain.safeBaseline = {
      ...(chain.safeBaseline || {}),
      assetSettlementAdapterAssigned: true,
      coordinatorAdapterApproved: true
    };

    prep.activation = prep.activation || {};
    prep.activation.baseQmsAdapterUpgraded = true;
    prep.activation.spokeGatewayAdaptersAuthorized = false;
    prep.notes = [
      ...(prep.notes || []),
      'Base QMS adapter upgraded to use the existing legacy Spoke bridgeBack() path; old Spoke and wQMS remain in service.'
    ];

    write(PREP_FILE, prep);
    write(CORE_FILE, state);

    console.log('\nBase QMS adapter upgrade complete.');
    console.log('Old Spoke and wQMS were preserved. Existing Gateway balances were not changed.');
    console.log('Next: npm.cmd run activate-qms-gateway');
  } finally {
  provider.destroy();
  hubProvider.destroy();
}
}

main().catch(error => {
  console.error('\nBase QMS adapter upgrade stopped:', error.stack || error);
  process.exitCode = 1;
});
