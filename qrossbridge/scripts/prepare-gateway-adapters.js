// Prepare chain-local QMS Gateway adapters without enabling unverified transfers.
// Deploys adapters/verifiers, connects each ledger to its coordinator, and enables wQMS custody.
// Deliberately DOES NOT set settlementAdapter, approve coordinator adapters, authorize spoke
// bridge adapters, enable proof routes, or add validator signers. Those are activation steps.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor, HUB_ID } = require('./chains');

const ROOT = path.join(__dirname, '..');
const CORE_FILE = path.join(ROOT, 'gateway-core-deployments.json');
const BRIDGE_FILE = path.join(ROOT, 'deployments.json');
const OUTPUT_FILE = path.join(ROOT, 'gateway-adapter-preparations.json');

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('Missing required file: ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function keyOf(value, label) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(label + ' must be a 32-byte 0x-prefixed private key in .env');
  return value;
}
function addr(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' is missing or invalid');
  return ethers.getAddress(value);
}
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function artifact(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json; compile the project first.');
  const a = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(a.abi) || !a.bytecode || a.bytecode === '0x') throw new Error('Artifact ' + name + ' has no deployable bytecode.');
  return a;
}
async function codeAt(provider, address, label) {
  const code = await provider.getCode(address);
  if (code === '0x') throw new Error(label + ' has no deployed bytecode at ' + address);
}
async function assertOwner(contract, expected, label) {
  const actual = await contract.owner();
  if (!same(actual, expected)) throw new Error(label + ' owner mismatch: expected ' + expected + ', got ' + actual);
}
async function send(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' transaction failed');
  console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
  return receipt;
}
async function deployOrReuse({ provider, wallet, owner, chainId, component, contractName, args, record }) {
  if (record && record.address) {
    const address = addr(record.address, chainId + ' ' + component);
    await codeAt(provider, address, chainId + ' ' + component);
    const instance = new ethers.Contract(address, artifact(contractName).abi, wallet);
    await assertOwner(instance, owner, chainId + ' ' + component);
    console.log('  reuse ' + component + ': ' + address);
    return { address, contract: instance, record };
  }
  const a = artifact(contractName);
  console.log('  deploying ' + component + ' (' + contractName + ')...');
  const instance = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
  const receipt = await instance.deploymentTransaction().wait();
  if (!receipt || receipt.status !== 1) throw new Error(chainId + ' ' + component + ' deployment failed');
  const address = await instance.getAddress();
  await codeAt(provider, address, chainId + ' ' + component);
  await assertOwner(instance, owner, chainId + ' ' + component);
  const saved = {
    contractName, address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    owner, deployer: await wallet.getAddress(), chainId, deployedAt: new Date().toISOString()
  };
  console.log('  deployed ' + component + ': ' + address);
  return { address, contract: instance, record: saved };
}

async function main() {
  const core = readJson(CORE_FILE);
  const bridges = readJson(BRIDGE_FILE);
  if (Number(core.chains?.['19480']?.chainId || 19480) !== HUB_ID || Number(bridges.hubChainId) !== HUB_ID) {
    throw new Error('Gateway core and bridge manifests must both identify QMS Testnet (19480) as Hub.');
  }

  const normalizeKey = (value, label) => keyOf(value && !value.startsWith('0x') ? '0x' + value : value, label);
  const qmsKey = normalizeKey(process.env.QMS_OWNER_KEY, 'QMS_OWNER_KEY');
  const baseKey = normalizeKey(process.env.BASE_OWNER_KEY, 'BASE_OWNER_KEY');
  const bridgeOwner = addr(bridges.owner, 'deployments.json owner');
  const configs = [
    { id: HUB_ID, key: qmsKey, label: 'QMS' },
    { id: 84532, key: baseKey, label: 'Base' }
  ];
  const output = fs.existsSync(OUTPUT_FILE) ? readJson(OUTPUT_FILE) : {
    schemaVersion: 1,
    project: 'QROS Gateway adapter preparation',
    status: 'preparing',
    chains: {},
    activation: {
      settlementAdaptersWired: false,
      coordinatorAdaptersApproved: false,
      spokeGatewayAdaptersAuthorized: false,
      verifierSignersConfigured: false,
      proofRoutesEnabled: false
    },
    notes: [
      'This preparation stage does not enable cross-chain transfers.',
      'Validator signer and route activation is intentionally deferred until real validator addresses and threshold are supplied.'
    ],
    createdAt: new Date().toISOString()
  };

  for (const cfg of configs) {
    const id = cfg.id;
    const idKey = String(id);
    const coreChain = core.chains?.[idKey];
    const bridgeChain = bridges.chains?.[idKey];
    if (!coreChain || !coreChain.contracts) throw new Error('Core deployment manifest missing chain ' + id);
    if (!bridgeChain?.bridge) throw new Error('Bridge deployment manifest missing bridge for chain ' + id);
    const owner = addr(coreChain.owner, id + ' Gateway owner');
    const walletBase = new ethers.Wallet(cfg.key);
    if (!same(walletBase.address, owner)) {
      throw new Error(cfg.label + ' owner key does not match Gateway owner ' + owner + ' (derived ' + walletBase.address + ').');
    }

    const provider = new ethers.JsonRpcProvider(rpcFor(id), id, { staticNetwork: true, cacheTimeout: -1 });
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== id) throw new Error(chains[id].name + ' RPC chain ID mismatch.');
    const wallet = new ethers.NonceManager(new ethers.Wallet(cfg.key, provider));

    const ledgerAddress = addr(coreChain.contracts.gatewayLedger?.address, id + ' Gateway ledger');
    const coordinatorAddress = addr(coreChain.contracts.transferCoordinator?.address, id + ' transfer coordinator');
    const settlementVerifierAddress = addr(coreChain.contracts.settlementVerifier?.address, id + ' settlement verifier');
    const localBridge = addr(bridgeChain.bridge, id + ' bridge');
    const hubBridge = addr(bridges.chains[String(HUB_ID)].bridge, 'QMS Hub bridge');
    const hubWQMS = addr(bridges.wqms, 'Hub wQMS');
    const localToken = id === HUB_ID ? hubWQMS : addr(bridgeChain.token, id + ' wQMS token');

    for (const [address, label] of [
      [ledgerAddress, 'Gateway ledger'], [coordinatorAddress, 'transfer coordinator'],
      [settlementVerifierAddress, 'settlement verifier'], [localBridge, 'QMS bridge'], [localToken, 'wQMS token']
    ]) await codeAt(provider, address, chains[id].name + ' ' + label);

    const ledger = new ethers.Contract(ledgerAddress, artifact('QrosGatewayLedger').abi, wallet);
    const coordinator = new ethers.Contract(coordinatorAddress, artifact('QrosTransferCoordinator').abi, wallet);
    const settlementVerifier = new ethers.Contract(settlementVerifierAddress, artifact('QrosQuorumAttestationVerifier').abi, wallet);
    await assertOwner(ledger, owner, id + ' Gateway ledger');
    await assertOwner(coordinator, owner, id + ' transfer coordinator');
    await assertOwner(settlementVerifier, owner, id + ' settlement verifier');
    if (!same(await coordinator.ledger(), ledgerAddress)) throw new Error(id + ' coordinator is bound to a different ledger.');

    // The legacy Hub/Spoke bridge is owned by the bridge owner, which is intentionally
    // separate from the Base Gateway owner. Only read/validate it in this preparation phase.
    const bridgeAbiName = id === HUB_ID ? 'QmsBridgeHub' : 'QmsBridgeSpoke';
    const bridge = new ethers.Contract(localBridge, artifact(bridgeAbiName).abi, provider);
    await assertOwner(bridge, bridgeOwner, id + ' legacy QMS bridge');
    if (id === HUB_ID) {
      if (!same(await bridge.wqms(), hubWQMS)) throw new Error('Hub bridge wQMS does not match deployments.json.');
    } else {
      if (Number(await bridge.hubChainId()) !== HUB_ID) throw new Error('Base Spoke points to a different Hub chain.');
      if (!same(await bridge.token(), localToken)) throw new Error('Base Spoke token does not match deployments.json.');
    }

    const existing = output.chains[idKey] || {};
    const verifierResult = await deployOrReuse({
      provider, wallet, owner, chainId: id, component: 'bridgeVerifier',
      contractName: 'QrosQmsBridgeAttestationVerifier',
      args: [owner, 1], record: existing.bridgeVerifier
    });
    // Persist each deployment independently so a failure between deployments is resumable.
    output.chains[idKey] = {
      ...(output.chains[idKey] || {}),
      name: chains[id].name, role: id === HUB_ID ? 'hub' : 'spoke',
      owner, bridgeOwner, bridge: localBridge, token: localToken,
      gatewayLedger: ledgerAddress, transferCoordinator: coordinatorAddress,
      settlementVerifier: settlementVerifierAddress,
      bridgeVerifier: verifierResult.record
    };
    writeJson(OUTPUT_FILE, output);
    const adapterResult = await deployOrReuse({
      provider, wallet, owner, chainId: id, component: 'qmsBridgeAdapter',
      contractName: 'QrosQmsBridgeAdapter',
      args: [owner, ledgerAddress, settlementVerifierAddress, coordinatorAddress,
        verifierResult.address, HUB_ID, hubBridge, hubWQMS, localBridge, localToken],
      record: existing.qmsBridgeAdapter
    });

    output.chains[idKey] = {
      name: chains[id].name,
      role: id === HUB_ID ? 'hub' : 'spoke',
      owner, bridgeOwner, bridge: localBridge, token: localToken,
      gatewayLedger: ledgerAddress, transferCoordinator: coordinatorAddress,
      settlementVerifier: settlementVerifierAddress,
      bridgeVerifier: verifierResult.record,
      qmsBridgeAdapter: adapterResult.record,
      preparedAt: new Date().toISOString()
    };
    writeJson(OUTPUT_FILE, output);

    // Safe baseline wiring: coordinator link and supported wQMS custody only.
    // Crucially, the settlement adapter remains unset and the coordinator adapter
    // remains unapproved, so the new bridge adapter cannot initiate/settle transfers.
    const currentCoordinator = await ledger.transferCoordinator();
    if (same(currentCoordinator, ethers.ZeroAddress)) {
      await send(id + ' set Gateway transfer coordinator', ledger.setTransferCoordinator(coordinatorAddress));
    } else if (!same(currentCoordinator, coordinatorAddress)) {
      throw new Error(id + ' ledger already points to a different transfer coordinator: ' + currentCoordinator);
    }
    if (!(await ledger.supportedAssets(localToken))) {
      await send(id + ' enable wQMS Gateway custody', ledger.setAssetSupport(localToken, true));
    }

    if (!same(await ledger.settlementAdapter(), ethers.ZeroAddress)) {
      throw new Error(id + ' ledger already has a settlement adapter configured; refusing to replace it automatically.');
    }
    if (await coordinator.approvedAdapters(adapterResult.address)) {
      throw new Error(id + ' coordinator already approves the new adapter; this preparation script will not activate it.');
    }

    output.chains[idKey].safeBaseline = {
      transferCoordinatorConnected: true,
      wqmsCustodyEnabled: true,
      settlementAdapterUnset: true,
      coordinatorAdapterUnapproved: true
    };
    writeJson(OUTPUT_FILE, output);
    console.log('  safe baseline complete; cross-chain adapter remains inactive.');
    await provider.destroy();
  }

  output.status = 'prepared-awaiting-validator-quorum';
  output.preparedAt = new Date().toISOString();
  writeJson(OUTPUT_FILE, output);
  console.log('\nGateway adapter preparation complete.');
  console.log('Manifest: gateway-adapter-preparations.json');
  console.log('Cross-chain transfers remain disabled pending real validator addresses, quorum, and reviewed route activation.');
}

main().catch(error => {
  console.error('\nGateway adapter preparation stopped:', error.stack || error);
  process.exitCode = 1;
});
