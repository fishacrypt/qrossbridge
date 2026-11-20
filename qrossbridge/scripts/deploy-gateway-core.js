// Deploys the QROS unified Gateway core contracts to explicitly configured chains.
// Safe to resume: each completed deployment is persisted to a pending manifest.
// This script does NOT configure assets, adapters, validator signers, routes, or strategies.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'gateway-core-deploy.config.json');
const PENDING_PATH = path.join(ROOT, '.gateway-core-deployments.pending.json');
const OUTPUT_PATH = path.join(ROOT, 'gateway-core-deployments.json');

function fail(message) {
  console.error('\nERROR: ' + message);
  process.exit(1);
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { fail('Cannot read ' + path.basename(file) + ': ' + e.message); }
}
function writeJsonAtomic(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'w' });
  fs.renameSync(temp, file);
}
function artifact(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) fail('Missing build artifact ' + name + '.json. Run npm run compile first.');
  const a = readJson(file);
  if (!Array.isArray(a.abi) || !a.bytecode || a.bytecode === '0x') fail('Artifact ' + name + ' has no deployable ABI/bytecode.');
  return a;
}
async function deployOne({ provider, wallet, owner, chainId, chainName, component, contractName, args, state }) {
  const previous = state.chains[String(chainId)].contracts[component];
  if (previous?.address) {
    const code = await provider.getCode(previous.address);
    if (code === '0x') fail(chainName + ': recorded ' + component + ' address has no contract code: ' + previous.address);
    console.log('  reuse ' + component + ': ' + previous.address);
    return previous;
  }
  const a = artifact(contractName);
  console.log('  deploying ' + component + ' (' + contractName + ')...');
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  if (!tx) fail('No deployment transaction returned for ' + component + '.');
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail(component + ' deployment failed on ' + chainName + '.');
  const address = await contract.getAddress();
  const code = await provider.getCode(address);
  if (code === '0x') fail(component + ' deployment receipt succeeded but no code exists at ' + address + '.');
  const record = {
    contractName, address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber,
    deployer: wallet.address, owner, chainId, deployedAt: new Date().toISOString()
  };
  state.chains[String(chainId)].contracts[component] = record;
  writeJsonAtomic(PENDING_PATH, state);
  console.log('  deployed ' + component + ': ' + address);
  return record;
}
async function main() {
  if (!fs.existsSync(CONFIG_PATH)) fail('Missing gateway-core-deploy.config.json. Copy gateway-core-deploy.config.example.json and set explicit owners/chains.');
  if (fs.existsSync(OUTPUT_PATH)) fail('gateway-core-deployments.json already exists. Refusing to overwrite an existing deployment manifest.');
  const config = readJson(CONFIG_PATH);
  const privateKey = process.env.DEPLOYER_KEY;
  if (!privateKey) fail('DEPLOYER_KEY is not set in .env.');
  if (!Array.isArray(config.chains) || config.chains.length === 0) fail('Config must contain a non-empty chains array.');
  if (!Number.isInteger(config.threshold) || config.threshold < 1) fail('Config threshold must be a positive integer.');
  const walletKey = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const deployerAddress = ethers.getAddress(new ethers.Wallet(walletKey).address);
  const state = fs.existsSync(PENDING_PATH) ? readJson(PENDING_PATH) : {
    schemaVersion: 1, project: 'QROS Unified Gateway Core', createdAt: new Date().toISOString(),
    deployer: deployerAddress, threshold: config.threshold, chains: {}
  };
  if (state.deployer && ethers.getAddress(state.deployer) !== deployerAddress) fail('Pending deployment was created by a different deployer key. Use the original DEPLOYER_KEY to resume.');
  state.deployer = deployerAddress;
  state.threshold = config.threshold;
  const seen = new Set();
  for (const entry of config.chains) {
    const chainId = Number(entry.chainId);
    if (!Number.isSafeInteger(chainId) || !chains[chainId]) fail('Unsupported chainId in config: ' + entry.chainId);
    if (seen.has(chainId)) fail('Duplicate chainId in config: ' + chainId);
    seen.add(chainId);
    if (typeof entry.execution !== 'boolean') fail('Chain ' + chainId + ': set execution to true or false.');
    const ownerValue = entry.owner || config.defaultOwner;
    if (!ownerValue) fail('Chain ' + chainId + ': provide owner (or defaultOwner) in gateway-core-deploy.config.json.');
    const owner = ethers.getAddress(ownerValue);
    if (owner === ethers.ZeroAddress) fail('Chain ' + chainId + ': owner cannot be the zero address.');
    const rpc = rpcFor(chainId);
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chainId) fail(chains[chainId].name + ': RPC chain ID mismatch (expected ' + chainId + ', got ' + network.chainId + ').');
    const wallet = new ethers.Wallet(walletKey, provider);
    if (!state.chains[String(chainId)]) {
      state.chains[String(chainId)] = {
        name: chains[chainId].name, role: chains[chainId].role, chainId,
        rpcSource: process.env['RPC_' + chainId] ? 'RPC_' + chainId : 'scripts/chains.js',
        owner, deployer: wallet.address, executionEnabled: entry.execution, contracts: {}
      };
      writeJsonAtomic(PENDING_PATH, state);
    } else {
      const existing = state.chains[String(chainId)];
      if (ethers.getAddress(existing.owner) !== owner) fail(chains[chainId].name + ': owner differs from pending deployment config.');
      if (Boolean(existing.executionEnabled) !== entry.execution) fail(chains[chainId].name + ': execution setting differs from pending deployment config.');
    }
    console.log('\n' + chains[chainId].name + ' (' + chainId + ')');
    const ledger = await deployOne({
      provider, wallet, owner, chainId, chainName: chains[chainId].name,
      component: 'gatewayLedger', contractName: 'QrosGatewayLedger', args: [owner], state
    });
    await deployOne({
      provider, wallet, owner, chainId, chainName: chains[chainId].name,
      component: 'transferCoordinator', contractName: 'QrosTransferCoordinator',
      args: [owner, ledger.address], state
    });
    await deployOne({
      provider, wallet, owner, chainId, chainName: chains[chainId].name,
      component: 'settlementVerifier', contractName: 'QrosQuorumAttestationVerifier',
      args: [owner, config.threshold], state
    });
    if (entry.execution) {
      await deployOne({
        provider, wallet, owner, chainId, chainName: chains[chainId].name,
        component: 'executionRouter', contractName: 'QrosExecutionRouter',
        args: [owner, ledger.address], state
      });
      await deployOne({
        provider, wallet, owner, chainId, chainName: chains[chainId].name,
        component: 'positionRegistry', contractName: 'QrosPositionRegistry',
        args: [owner], state
      });
    }
    await provider.destroy();
  }
  state.completedAt = new Date().toISOString();
  state.status = 'deployed-unconfigured';
  state.notes = [
    'Core contracts deployed only; no setters or validator/route configuration were applied.',
    'Before enabling transfers, configure supported assets, settlement adapters, coordinator adapters, verifier signers/threshold/routes, and route-specific liquidity.',
    'Execution-enabled chains still require approved execution adapter, router strategy IDs, and position-registry adapter permissions.'
  ];
  writeJsonAtomic(OUTPUT_PATH, state);
  if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
  console.log('\nCore deployment manifest written: gateway-core-deployments.json');
  console.log('Status: deployed-unconfigured. No adapter or validator permissions were enabled.');
}
main().catch(error => {
  console.error('\nDeployment stopped. Any completed deployments are saved in .gateway-core-deployments.pending.json.');
  console.error(error?.stack || error);
  process.exit(1);
});
