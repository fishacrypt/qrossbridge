// Deploy replacement QROS Gateway ledgers and immutable dependants without touching
// the existing gateway-core-deployments.json or any live balances.
// This is a deployment-only migration stage: no assets, adapters, routes, or strategies
// are enabled. The existing Gateway remains the live system until a later cutover.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor, HUB_ID } = require('./chains');

const ROOT = path.join(__dirname, '..');
const CORE_FILE = path.join(ROOT, 'gateway-core-deployments.json');
const BRIDGE_FILE = path.join(ROOT, 'deployments.json');
const OUTPUT_FILE = path.join(ROOT, 'gateway-migration-deployments.json');

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function keyOf(value, label) {
  const key = value && !value.startsWith('0x') ? '0x' + value : value;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(label + ' must be configured in local .env');
  return key;
}
function addr(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' missing or invalid');
  return ethers.getAddress(value);
}
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function artifact(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json. Run npm.cmd run compile first.');
  const a = readJson(file);
  if (!Array.isArray(a.abi) || !a.bytecode || a.bytecode === '0x') throw new Error('Invalid deployable artifact: ' + name);
  return a;
}
async function ensureCode(provider, address, label) {
  if (await provider.getCode(address) === '0x') throw new Error(label + ' has no deployed code: ' + address);
}
async function deploy({ provider, wallet, owner, chainId, chainName, name, args, state }) {
  const chain = state.chains[String(chainId)];
  const prior = chain.contracts[name];
  if (prior?.address) {
    await ensureCode(provider, addr(prior.address, name), chainName + ' recorded ' + name);
    console.log('  reuse ' + name + ': ' + prior.address);
    return prior;
  }
  const a = artifact(name);
  console.log('  deploying ' + name + '...');
  const instance = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
  const tx = instance.deploymentTransaction();
  if (!tx) throw new Error('Missing deployment transaction for ' + name);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(name + ' deployment failed on ' + chainName);
  const address = await instance.getAddress();
  await ensureCode(provider, address, chainName + ' newly deployed ' + name);
  const record = {
    contractName: name, address, transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber, deployer: wallet.address,
    owner, chainId, deployedAt: new Date().toISOString()
  };
  chain.contracts[name] = record;
  writeJson(OUTPUT_FILE, state);
  console.log('  deployed ' + name + ': ' + address);
  return record;
}

async function main() {
  const core = readJson(CORE_FILE);
  const bridges = readJson(BRIDGE_FILE);
  if (Number(bridges.hubChainId) !== HUB_ID) throw new Error('Bridge manifest Hub must be QMS Testnet (19480).');
  const qmsKey = keyOf(process.env.QMS_OWNER_KEY, 'QMS_OWNER_KEY');
  const baseKey = keyOf(process.env.BASE_OWNER_KEY, 'BASE_OWNER_KEY');
  const configs = [
    { id: HUB_ID, key: qmsKey, label: 'QMS Testnet', execution: false },
    { id: 84532, key: baseKey, label: 'Base Sepolia', execution: true }
  ];

  let state = fs.existsSync(OUTPUT_FILE) ? readJson(OUTPUT_FILE) : {
    schemaVersion: 1,
    project: 'QROS Gateway Ledger Migration',
    status: 'deploying-replacement-contracts',
    migrationFrom: path.basename(CORE_FILE),
    createdAt: new Date().toISOString(),
    chains: {},
    safety: {
      existingGatewayManifestPreserved: true,
      existingLedgersUntouched: true,
      existingBalancesNotMigrated: true,
      noValidatorsOrProofRoutesActivated: true,
      cutoverAuthorized: false
    },
    notes: [
      'Replacement contracts only. Existing Gateway contracts and user balances remain untouched.',
      'Safe wQMS custody, asset-specific adapter assignment, coordinator approval, and Base execution-router linkage are applied only to replacement contracts. No validators, proof routes, or execution strategies are enabled.',
      'Do not direct users to replacement ledgers until a separately reviewed cutover and balance migration is completed.'
    ]
  };
  if (state.project !== 'QROS Gateway Ledger Migration') throw new Error('Migration output file has an unexpected project identity.');

  // Validate both owners and both RPC networks before broadcasting any deployment.
  for (const cfg of configs) {
    const old = core.chains?.[String(cfg.id)];
    if (!old?.contracts?.gatewayLedger?.address || !old?.contracts?.transferCoordinator?.address ||
        !old?.contracts?.settlementVerifier?.address) throw new Error('Existing core manifest incomplete for chain ' + cfg.id);
    const owner = addr(old.owner, cfg.label + ' existing Gateway owner');
    const derived = new ethers.Wallet(cfg.key).address;
    if (!same(derived, owner)) throw new Error(cfg.label + ' owner key does not match existing Gateway owner ' + owner);
    const priorChain = state.chains[String(cfg.id)];
    if (priorChain && !same(priorChain.owner, owner)) throw new Error(cfg.label + ' owner differs from the resumable migration manifest.');
    if (!priorChain) state.chains[String(cfg.id)] = {
      name: cfg.label, chainId: cfg.id, owner, role: cfg.id === HUB_ID ? 'hub' : 'spoke',
      executionEnabled: cfg.execution, replaces: old.contracts.gatewayLedger.address, contracts: {}
    };
  }
  writeJson(OUTPUT_FILE, state);

  const hubBridge = addr(bridges.chains?.[String(HUB_ID)]?.bridge, 'QMS Hub bridge');
  const hubWQMS = addr(bridges.wqms, 'Hub wQMS');
  const bridgeOwner = addr(bridges.owner, 'Legacy bridge owner');

  for (const cfg of configs) {
    const id = cfg.id, idKey = String(id), oldBridge = bridges.chains?.[idKey];
    const owner = state.chains[idKey].owner;
    const localBridge = addr(oldBridge?.bridge, cfg.label + ' legacy bridge');
    const localToken = id === HUB_ID ? hubWQMS : addr(oldBridge?.token, cfg.label + ' wQMS token');
    const provider = new ethers.JsonRpcProvider(rpcFor(id), id, { staticNetwork: true, cacheTimeout: -1 });
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== id) throw new Error(cfg.label + ' RPC chain ID mismatch.');
    const wallet = new ethers.NonceManager(new ethers.Wallet(cfg.key, provider));
    await ensureCode(provider, localBridge, cfg.label + ' legacy bridge');
    await ensureCode(provider, localToken, cfg.label + ' wQMS token');

    console.log('\n' + cfg.label + ' (' + id + ') — replacement deployment');
    const ledger = await deploy({
      provider, wallet, owner, chainId: id, chainName: cfg.label,
      name: 'QrosGatewayLedger', args: [owner], state
    });
    const coordinator = await deploy({
      provider, wallet, owner, chainId: id, chainName: cfg.label,
      name: 'QrosTransferCoordinator', args: [owner, ledger.address], state
    });
    const settlementVerifier = await deploy({
      provider, wallet, owner, chainId: id, chainName: cfg.label,
      name: 'QrosQuorumAttestationVerifier', args: [owner, 1], state
    });
    const bridgeVerifier = await deploy({
      provider, wallet, owner, chainId: id, chainName: cfg.label,
      name: 'QrosQmsBridgeAttestationVerifier', args: [owner, 1], state
    });
    const adapter = await deploy({
      provider, wallet, owner, chainId: id, chainName: cfg.label,
      name: 'QrosQmsBridgeAdapter',
      args: [owner, ledger.address, settlementVerifier.address, coordinator.address,
        bridgeVerifier.address, HUB_ID, hubBridge, hubWQMS, localBridge, localToken],
      state
    });
    let executionRouter = null, positionRegistry = null;
    if (cfg.execution) {
      executionRouter = await deploy({
        provider, wallet, owner, chainId: id, chainName: cfg.label,
        name: 'QrosExecutionRouter', args: [owner, ledger.address], state
      });
      positionRegistry = await deploy({
        provider, wallet, owner, chainId: id, chainName: cfg.label,
        name: 'QrosPositionRegistry', args: [owner], state
      });
    }

    // Safe baseline on the NEW ledger only. No validator or proof route is enabled here.
    const ledgerWrite = new ethers.Contract(ledger.address, artifact('QrosGatewayLedger').abi, wallet);
    const coordinatorWrite = new ethers.Contract(coordinator.address, artifact('QrosTransferCoordinator').abi, wallet);
    const executionRouterWrite = executionRouter
      ? new ethers.Contract(executionRouter.address, artifact('QrosExecutionRouter').abi, wallet)
      : null;
    async function send(label, txPromise) {
      const tx = await txPromise;
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(label + ' transaction failed.');
      console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
    }
    async function ensureAddress(label, read, write, expected) {
      const current = await read();
      if (same(current, expected)) return;
      if (!same(current, ethers.ZeroAddress)) throw new Error(label + ' already points to a different address: ' + current);
      await send(label, write());
      if (!same(await read(), expected)) throw new Error(label + ' did not persist.');
    }
    async function ensureBool(label, read, write) {
      if (await read()) return;
      await send(label, write());
      if (!(await read())) throw new Error(label + ' did not persist.');
    }
    await ensureAddress(cfg.label + ' connect replacement transfer coordinator',
      () => ledgerWrite.transferCoordinator(),
      () => ledgerWrite.setTransferCoordinator(coordinator.address), coordinator.address);
    await ensureBool(cfg.label + ' enable replacement wQMS custody',
      () => ledgerWrite.supportedAssets(localToken),
      () => ledgerWrite.setAssetSupport(localToken, true));
    await ensureAddress(cfg.label + ' assign wQMS settlement adapter',
      () => ledgerWrite.settlementAdapters(localToken),
      () => ledgerWrite.setSettlementAdapterForAsset(localToken, adapter.address), adapter.address);
    await ensureBool(cfg.label + ' approve QMS adapter in replacement coordinator',
      () => coordinatorWrite.approvedAdapters(adapter.address),
      () => coordinatorWrite.setAdapter(adapter.address, true));
    if (executionRouterWrite) {
      await ensureAddress('Base Sepolia connect replacement execution router',
        () => ledgerWrite.executionRouter(),
        () => ledgerWrite.setExecutionRouter(executionRouter.address), executionRouter.address);
    }

    // Read back constructor bindings and safe baseline before declaring this chain complete.
    const ledgerRead = new ethers.Contract(ledger.address, artifact('QrosGatewayLedger').abi, provider);
    const coordinatorRead = new ethers.Contract(coordinator.address, artifact('QrosTransferCoordinator').abi, provider);
    const adapterRead = new ethers.Contract(adapter.address, artifact('QrosQmsBridgeAdapter').abi, provider);
    if (!same(await ledgerRead.owner(), owner)) throw new Error(cfg.label + ' replacement ledger owner verification failed.');
    if (!same(await coordinatorRead.owner(), owner) || !same(await coordinatorRead.ledger(), ledger.address)) {
      throw new Error(cfg.label + ' replacement coordinator binding verification failed.');
    }
    if (!same(await adapterRead.owner(), owner) || !same(await adapterRead.ledger(), ledger.address) ||
        !same(await adapterRead.coordinator(), coordinator.address)) {
      throw new Error(cfg.label + ' replacement QMS adapter binding verification failed.');
    }
    if (executionRouter) {
      const routerRead = new ethers.Contract(executionRouter.address, artifact('QrosExecutionRouter').abi, provider);
      if (!same(await routerRead.ledger(), ledger.address)) throw new Error('Base execution router ledger binding verification failed.');
    }

    state.chains[idKey].contracts = {
      ...state.chains[idKey].contracts,
      gatewayLedger: ledger, transferCoordinator: coordinator,
      settlementVerifier, bridgeVerifier, qmsBridgeAdapter: adapter,
      ...(executionRouter ? { executionRouter, positionRegistry } : {})
    };
    state.chains[idKey].legacy = {
      bridge: localBridge, token: localToken, bridgeOwner,
      previousGatewayLedger: core.chains[idKey].contracts.gatewayLedger.address,
      previousTransferCoordinator: core.chains[idKey].contracts.transferCoordinator.address
    };
    state.chains[idKey].safeBaseline = {
      transferCoordinatorConnected: true,
      wqmsCustodyEnabled: true,
      assetSettlementAdapterAssigned: true,
      coordinatorAdapterApproved: true,
      executionRouterConnected: Boolean(executionRouter)
    };
    state.chains[idKey].deploymentVerifiedAt = new Date().toISOString();
    writeJson(OUTPUT_FILE, state);
    await provider.destroy();
  }

  const preparation = {
    schemaVersion: 1,
    project: 'QROS Gateway migration adapter preparation',
    status: 'prepared-awaiting-validator-quorum',
    chains: {},
    activation: {
      settlementAdaptersWired: true,
      coordinatorAdaptersApproved: true,
      spokeGatewayAdaptersAuthorized: false,
      verifierSignersConfigured: false,
      proofRoutesEnabled: false
    },
    notes: [
      'Replacement ledgers only. Existing Gateway contracts and balances remain untouched.',
      'wQMS settlement adapters are assigned and coordinator-approved, but validator signers and proof routes remain disabled.',
      'Cross-chain transfers are not ready until the separate activation workflow completes.'
    ],
    createdAt: state.createdAt,
    preparedAt: new Date().toISOString()
  };
  for (const id of [HUB_ID, 84532]) {
    const c = state.chains[String(id)];
    preparation.chains[String(id)] = {
      name: c.name, role: c.role, owner: c.owner,
      bridgeOwner: c.legacy.bridgeOwner, bridge: c.legacy.bridge, token: c.legacy.token,
      gatewayLedger: c.contracts.gatewayLedger.address,
      transferCoordinator: c.contracts.transferCoordinator.address,
      settlementVerifier: c.contracts.settlementVerifier.address,
      bridgeVerifier: c.contracts.bridgeVerifier,
      qmsBridgeAdapter: c.contracts.qmsBridgeAdapter,
      safeBaseline: c.safeBaseline,
      preparedAt: c.deploymentVerifiedAt
    };
  }
  writeJson(path.join(ROOT, 'gateway-migration-adapter-preparations.json'), preparation);
  state.status = 'replacement-contracts-prepared-awaiting-validator-quorum';
  state.completedAt = new Date().toISOString();
  writeJson(OUTPUT_FILE, state);
  console.log('\nReplacement deployment and safe baseline complete.');
  console.log('Migration manifest: gateway-migration-deployments.json');
  console.log('Existing gateway-core-deployments.json was not modified.');
  console.log('No existing balances were moved. No replacement adapter or route was activated.');
}

main().catch(error => {
  console.error('\nGateway migration deployment stopped. Completed deployments are saved for safe resume.');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
