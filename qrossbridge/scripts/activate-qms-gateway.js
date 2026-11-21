// Activate QMS <-> Base Gateway settlement after validator addresses are supplied.
// This script is intentionally separate from preparation. It is idempotent and validates
// both Gateway owners and the legacy bridge owner before sending any transaction.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor, HUB_ID } = require('./chains');

const ROOT = path.join(__dirname, '..');
const MIGRATION_CORE_FILE = path.join(ROOT, 'gateway-migration-deployments.json');
const MIGRATION_PREP_FILE = path.join(ROOT, 'gateway-migration-adapter-preparations.json');
const USE_MIGRATION = fs.existsSync(MIGRATION_CORE_FILE) && fs.existsSync(MIGRATION_PREP_FILE);
const CORE_FILE = USE_MIGRATION ? MIGRATION_CORE_FILE : path.join(ROOT, 'gateway-core-deployments.json');
const BRIDGE_FILE = path.join(ROOT, 'deployments.json');
const PREP_FILE = USE_MIGRATION ? MIGRATION_PREP_FILE : path.join(ROOT, 'gateway-adapter-preparations.json');
const VALIDATOR_FILE = path.join(ROOT, 'gateway-validator.config.json');
const OUTPUT_FILE = path.join(ROOT, USE_MIGRATION ? 'gateway-migration-activations.json' : 'gateway-adapter-activations.json');

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
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(label + ' must be a 32-byte private key in local .env');
  return key;
}
function addr(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' is missing or invalid');
  return ethers.getAddress(value);
}
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function art(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json; run npm.cmd run compile first.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function code(provider, address, label) {
  if (await provider.getCode(address) === '0x') throw new Error(label + ' has no deployed code at ' + address);
}
async function assertOwner(contract, expected, label) {
  const actual = await contract.owner();
  if (!same(actual, expected)) throw new Error(label + ' owner mismatch: expected ' + expected + ', got ' + actual);
}
async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' failed');
  console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
  return receipt.hash;
}
async function ensureBool(label, read, write) {
  if (await read()) return;
  await send(label, write());
  if (!(await read())) throw new Error(label + ' did not persist');
}
async function ensureAddress(label, read, write, expected) {
  const current = await read();
  if (same(current, expected)) return;
  if (!same(current, ethers.ZeroAddress)) throw new Error(label + ' already points to another address: ' + current);
  await send(label, write());
  if (!same(await read(), expected)) throw new Error(label + ' did not persist');
}

async function main() {
  const core = readJson(CORE_FILE);
  const bridges = readJson(BRIDGE_FILE);
  const prepared = readJson(PREP_FILE);
  const validatorConfig = readJson(VALIDATOR_FILE);
  if (Number(bridges.hubChainId) !== HUB_ID) throw new Error('Unexpected Hub chain in bridge manifest.');
  if (!Array.isArray(validatorConfig.validators) || validatorConfig.validators.length === 0) {
    throw new Error('Add real validator addresses to gateway-validator.config.json before activation.');
  }
  const validators = [...new Set(validatorConfig.validators.map((v, i) => addr(v, 'validators[' + i + ']')))]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const threshold = Number(validatorConfig.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > validators.length) {
    throw new Error('Validator threshold must be between 1 and the number of unique validator addresses.');
  }

  const qmsKey = keyOf(process.env.QMS_OWNER_KEY, 'QMS_OWNER_KEY');
  const baseKey = keyOf(process.env.BASE_OWNER_KEY, 'BASE_OWNER_KEY');
  const bridgeOwner = addr(bridges.owner, 'legacy bridge owner');
  const qmsAddress = ethers.getAddress(new ethers.Wallet(qmsKey).address);
  if (!same(qmsAddress, bridgeOwner)) {
    throw new Error('QMS_OWNER_KEY must also control the legacy QMS Hub/Spoke bridge owner ' + bridgeOwner + '.');
  }

  const configs = [
    { id: HUB_ID, key: qmsKey },
    { id: 84532, key: baseKey }
  ];
  const contexts = new Map();

  // Preflight all contracts and owners on both chains before the first state-changing call.
  for (const cfg of configs) {
    const id = cfg.id, idKey = String(id);
    const cc = core.chains?.[idKey], bc = bridges.chains?.[idKey], pc = prepared.chains?.[idKey];
    if (!cc?.contracts || !bc?.bridge || !pc?.qmsBridgeAdapter?.address || !pc?.bridgeVerifier?.address) {
      throw new Error('Missing prepared Gateway/bridge deployment records for chain ' + id + '. Run prepare-gateway-adapters first.');
    }
    const owner = addr(cc.owner, id + ' Gateway owner');
    const gatewayBase = new ethers.Wallet(cfg.key);
    if (!same(gatewayBase.address, owner)) throw new Error(id + ' owner key does not match Gateway owner ' + owner);
    const provider = new ethers.JsonRpcProvider(rpcFor(id), id, { staticNetwork: true, cacheTimeout: -1 });
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== id) throw new Error(chains[id].name + ' RPC chain ID mismatch.');

    const gatewayWallet = new ethers.NonceManager(new ethers.Wallet(cfg.key, provider));
    const bridgeWallet = same(gatewayBase.address, bridgeOwner)
      ? gatewayWallet
      : new ethers.NonceManager(new ethers.Wallet(qmsKey, provider));

    const ledgerAddress = addr(cc.contracts.gatewayLedger?.address, id + ' ledger');
    const coordinatorAddress = addr(cc.contracts.transferCoordinator?.address, id + ' coordinator');
    const settlementVerifierAddress = addr(cc.contracts.settlementVerifier?.address, id + ' settlement verifier');
    const adapterAddress = addr(pc.qmsBridgeAdapter.address, id + ' QMS adapter');
    const bridgeVerifierAddress = addr(pc.bridgeVerifier.address, id + ' QMS bridge verifier');
    const bridgeAddress = addr(bc.bridge, id + ' legacy bridge');
    const tokenAddress = id === HUB_ID ? addr(bridges.wqms, 'Hub wQMS') : addr(bc.token, id + ' spoke wQMS');

    for (const [a, label] of [
      [ledgerAddress, 'Gateway ledger'], [coordinatorAddress, 'transfer coordinator'],
      [settlementVerifierAddress, 'settlement verifier'], [adapterAddress, 'QMS adapter'],
      [bridgeVerifierAddress, 'QMS bridge verifier'], [bridgeAddress, 'legacy bridge'], [tokenAddress, 'wQMS']
    ]) await code(provider, a, chains[id].name + ' ' + label);

    const ledger = new ethers.Contract(ledgerAddress, art('QrosGatewayLedger').abi, gatewayWallet);
    const coordinator = new ethers.Contract(coordinatorAddress, art('QrosTransferCoordinator').abi, gatewayWallet);
    const settlementVerifier = new ethers.Contract(settlementVerifierAddress, art('QrosQuorumAttestationVerifier').abi, gatewayWallet);
    const adapter = new ethers.Contract(adapterAddress, art('QrosQmsBridgeAdapter').abi, gatewayWallet);
    const bridgeVerifier = new ethers.Contract(bridgeVerifierAddress, art('QrosQmsBridgeAttestationVerifier').abi, gatewayWallet);
    const bridge = new ethers.Contract(bridgeAddress, art(id === HUB_ID ? 'QmsBridgeHub' : 'QmsBridgeSpoke').abi, bridgeWallet);

    await assertOwner(ledger, owner, id + ' Gateway ledger');
    await assertOwner(coordinator, owner, id + ' transfer coordinator');
    await assertOwner(settlementVerifier, owner, id + ' settlement verifier');
    await assertOwner(adapter, owner, id + ' QMS adapter');
    await assertOwner(bridgeVerifier, owner, id + ' QMS bridge verifier');
    await assertOwner(bridge, bridgeOwner, id + ' legacy bridge');
    if (!same(await coordinator.ledger(), ledgerAddress)) throw new Error(id + ' coordinator ledger mismatch.');
    if (id === HUB_ID) {
      if (!same(await bridge.wqms(), tokenAddress)) throw new Error('Hub bridge wQMS mismatch.');
    } else {
      if (Number(await bridge.hubChainId()) !== HUB_ID || !same(await bridge.token(), tokenAddress)) {
        throw new Error('Base Spoke Hub/token configuration mismatch.');
      }
    }
    contexts.set(id, {
      id, owner, provider, gatewayWallet, bridgeWallet, ledger, coordinator,
      settlementVerifier, adapter, bridgeVerifier, bridge,
      ledgerAddress, coordinatorAddress, adapterAddress, bridgeAddress, tokenAddress
    });
  }

  // Configure validators on both independent proof verifiers on both chains.
  for (const id of [HUB_ID, 84532]) {
    const c = contexts.get(id);
    console.log('\nConfiguring validators on ' + chains[id].name);
    for (const signer of validators) {
      await ensureBool('enable settlement validator ' + signer,
        () => c.settlementVerifier.isSigner(signer),
        () => c.settlementVerifier.setSigner(signer, true));
      await ensureBool('enable bridge validator ' + signer,
        () => c.bridgeVerifier.isSigner(signer),
        () => c.bridgeVerifier.setSigner(signer, true));
    }
    const settlementCount = Number(await c.settlementVerifier.signerCount());
    const bridgeCount = Number(await c.bridgeVerifier.signerCount());
    if (settlementCount !== validators.length || bridgeCount !== validators.length) {
      throw new Error(id + ' verifier contains unexpected signer entries; inspect signer allowlists before activation.');
    }
    if (Number(await c.settlementVerifier.threshold()) !== threshold) {
      await send(id + ' set settlement quorum ' + threshold, c.settlementVerifier.setThreshold(threshold));
    }
    if (Number(await c.bridgeVerifier.threshold()) !== threshold) {
      await send(id + ' set bridge quorum ' + threshold, c.bridgeVerifier.setThreshold(threshold));
    }
  }

  // Attach the QMS adapter only to the wQMS asset; stablecoins can have separate adapters.
  for (const id of [HUB_ID, 84532]) {
    const c = contexts.get(id);
    await ensureAddress(id + ' set wQMS settlement adapter',
      () => c.ledger.settlementAdapters(c.tokenAddress),
      () => c.ledger.setSettlementAdapterForAsset(c.tokenAddress, c.adapterAddress),
      c.adapterAddress);
    await ensureBool(id + ' approve QMS coordinator adapter',
      () => c.coordinator.approvedAdapters(c.adapterAddress),
      () => c.coordinator.setAdapter(c.adapterAddress, true));
  }

  // The legacy bridge owner key is distinct from the Base Gateway owner key.
  const hub = contexts.get(HUB_ID), base = contexts.get(84532);
  await ensureBool('enable Base Sepolia on QMS Hub bridge',
    () => hub.bridge.supportedChain(84532),
    () => hub.bridge.setChainSupport(84532, true));
  // The deployed Base Spoke predates gatewayAdapters(). If it exposes the allowlist,
  // authorize the adapter normally. Otherwise the upgraded adapter uses legacy bridgeBack(),
  // which burns the wQMS it holds and does not require changing/replacing the live Spoke.
  try {
    await ensureBool('authorize Base QMS Gateway adapter on Spoke bridge',
      () => base.bridge.gatewayAdapters(base.adapterAddress),
      () => base.bridge.setGatewayAdapter(base.adapterAddress, true));
  } catch (error) {
    console.log('  Base Spoke has no gatewayAdapters() getter; using backward-compatible bridgeBack() path.');
  }

  // Configure both directions. Destination verifiers accept only exact endpoint tuples.
  for (const sourceId of [HUB_ID, 84532]) {
    const source = contexts.get(sourceId);
    for (const destinationId of [HUB_ID, 84532]) {
      if (sourceId === destinationId) continue;
      const destination = contexts.get(destinationId);
      const remote = await source.adapter.remoteRoutes(destinationId);
      const routeMatches = remote.enabled && same(remote.bridge, destination.bridgeAddress) &&
        same(remote.token, destination.tokenAddress) && same(remote.adapter, destination.adapterAddress) &&
        same(remote.gatewayLedger, destination.ledgerAddress);
      if (!routeMatches) {
        const safeAdapterUpgrade = remote.enabled &&
          same(remote.bridge, destination.bridgeAddress) &&
          same(remote.token, destination.tokenAddress) &&
          same(remote.gatewayLedger, destination.ledgerAddress) &&
          same(remote.adapter, prepared.chains?.[String(destinationId)]?.previousQmsBridgeAdapter);
        if (remote.enabled && !safeAdapterUpgrade) {
          throw new Error('Existing remote adapter route ' + sourceId + ' -> ' + destinationId + ' differs beyond the recorded adapter upgrade; refusing to overwrite.');
        }
        await send((safeAdapterUpgrade ? 'upgrade' : 'configure') + ' QMS adapter route ' + sourceId + ' -> ' + destinationId,
          source.adapter.setRemoteRoute(destinationId, destination.bridgeAddress, destination.tokenAddress,
            destination.adapterAddress, destination.ledgerAddress, true));
      }

      const settlementKey = await destination.settlementVerifier.routeKey(
        sourceId, destinationId, source.tokenAddress, destination.tokenAddress, destination.ledgerAddress
      );
      await ensureBool('enable settlement proof route ' + sourceId + ' -> ' + destinationId,
        () => destination.settlementVerifier.enabledRoute(settlementKey),
        () => destination.settlementVerifier.setRoute(sourceId, destinationId, source.tokenAddress,
          destination.tokenAddress, destination.ledgerAddress, true));

      const bridgeKey = await destination.bridgeVerifier.routeKey(
        sourceId, destinationId, source.bridgeAddress, destination.bridgeAddress,
        source.tokenAddress, destination.tokenAddress, source.adapterAddress, destination.adapterAddress
      );
      await ensureBool('enable bridge proof route ' + sourceId + ' -> ' + destinationId,
        () => destination.bridgeVerifier.enabledRoute(bridgeKey),
        () => destination.bridgeVerifier.setRoute(sourceId, destinationId, source.bridgeAddress,
          destination.bridgeAddress, source.tokenAddress, destination.tokenAddress,
          source.adapterAddress, destination.adapterAddress, true));
    }
  }

  const output = {
    status: 'qms-wqms-settlement-active',
    hubChainId: HUB_ID,
    chains: {},
    validators,
    threshold,
    activatedAt: new Date().toISOString(),
    trustModel: 'Threshold validator attestations; not a trustless cross-chain light client.',
    scope: 'QMS/wQMS only. Stablecoin settlement adapters and Uniswap execution are configured separately.'
  };
  for (const id of [HUB_ID, 84532]) {
    const c = contexts.get(id);
    output.chains[String(id)] = {
      name: chains[id].name, owner: c.owner, bridge: c.bridgeAddress, token: c.tokenAddress,
      gatewayLedger: c.ledgerAddress, transferCoordinator: c.coordinatorAddress,
      qmsBridgeAdapter: c.adapterAddress,
      settlementVerifier: await c.settlementVerifier.getAddress(),
      bridgeVerifier: await c.bridgeVerifier.getAddress(),
      assetSettlementAdapter: await c.ledger.settlementAdapters(c.tokenAddress),
      coordinatorApproved: await c.coordinator.approvedAdapters(c.adapterAddress),
      validatorCount: Number(await c.settlementVerifier.signerCount()),
      threshold
    };
    await c.provider.destroy();
  }
  writeJson(OUTPUT_FILE, output);
  console.log('\nQMS/wQMS Gateway settlement activation complete.');
  console.log('Manifest: gateway-adapter-activations.json');
  console.log('This activates only the QMS/wQMS asset rail, not stablecoin settlement or DeFi execution.');
}

main().catch(error => {
  console.error('\nQMS Gateway activation stopped:', error.stack || error);
  process.exitCode = 1;
});
