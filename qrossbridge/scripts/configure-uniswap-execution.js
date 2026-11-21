// Deploy and configure the explicit, user-authorized Uniswap V3 execution adapter on Base Sepolia.
// Requires real Base Sepolia Uniswap router/position-manager and token/pool addresses in config.
// Does not move user funds or execute a strategy.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const MIGRATION_CORE_FILE = path.join(ROOT, 'gateway-migration-deployments.json');
const CORE_FILE = fs.existsSync(MIGRATION_CORE_FILE)
  ? MIGRATION_CORE_FILE
  : path.join(ROOT, 'gateway-core-deployments.json');
const CONFIG_FILE = path.join(ROOT, 'uniswap-execution.config.json');
const OUTPUT_FILE = path.join(ROOT, 'uniswap-execution-deployments.json');

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function addr(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' is missing or invalid');
  return ethers.getAddress(value);
}
function keyOf(value) {
  const key = value && !value.startsWith('0x') ? '0x' + value : value;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('BASE_OWNER_KEY must be a 32-byte private key in local .env');
  return key;
}
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function art(name) {
  const file = path.join(ROOT, 'build', name + '.json');
  if (!fs.existsSync(file)) throw new Error('Missing build/' + name + '.json; compile first.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function code(provider, address, label) {
  if (await provider.getCode(address) === '0x') throw new Error(label + ' has no contract code at ' + address);
}
async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' failed');
  console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
}
async function ensureBool(label, read, write) {
  if (await read()) return;
  await send(label, write());
  if (!(await read())) throw new Error(label + ' did not persist');
}
async function ensureAddress(label, read, write, expected) {
  const current = await read();
  if (same(current, expected)) return;
  if (!same(current, ethers.ZeroAddress)) throw new Error(label + ' already points to a different address: ' + current);
  await send(label, write());
  if (!same(await read(), expected)) throw new Error(label + ' did not persist');
}

async function main() {
  const core = readJson(CORE_FILE);
  const cfg = readJson(CONFIG_FILE);
  const chainId = 84532;
  const coreChain = core.chains?.[String(chainId)];
  if (!coreChain?.executionEnabled || !coreChain.contracts?.executionRouter?.address || !coreChain.contracts?.positionRegistry?.address) {
    throw new Error('Base Sepolia core must have executionRouter and positionRegistry deployed.');
  }
  const owner = addr(coreChain.owner, 'Base Gateway owner');
  const key = keyOf(process.env.BASE_OWNER_KEY);
  const walletBase = new ethers.Wallet(key);
  if (!same(walletBase.address, owner)) throw new Error('BASE_OWNER_KEY does not match Base Gateway owner ' + owner);

  const swapRouter = addr(cfg.swapRouter, 'Uniswap V3 SwapRouter');
  const positionManager = addr(cfg.positionManager, 'Uniswap V3 NonfungiblePositionManager');
  const token0 = addr(cfg.token0, 'token0');
  const token1 = addr(cfg.token1, 'token1');
  if (BigInt(token0) >= BigInt(token1)) throw new Error('token0 must be the lower address than token1.');
  const poolFee = Number(cfg.poolFee);
  const swapFee = Number(cfg.swapFee || 0);
  if (!Number.isInteger(poolFee) || poolFee <= 0 || poolFee > 1000000) throw new Error('poolFee must be a valid Uniswap V3 fee tier.');
  if (!Number.isInteger(swapFee) || swapFee < 0 || swapFee > 1000000) throw new Error('swapFee must be zero or a valid Uniswap V3 fee tier.');
  if (!cfg.strategyId || !/^0x[0-9a-fA-F]{64}$/.test(cfg.strategyId) || /^0x0{64}$/i.test(cfg.strategyId)) {
    throw new Error('strategyId must be a non-zero bytes32 value.');
  }

  const provider = new ethers.JsonRpcProvider(rpcFor(chainId), chainId, { staticNetwork: true, cacheTimeout: -1 });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== chainId) throw new Error('Base Sepolia RPC chain ID mismatch.');
  const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider));

  const ledgerAddress = addr(coreChain.contracts.gatewayLedger?.address, 'Gateway ledger');
  const routerAddress = addr(coreChain.contracts.executionRouter.address, 'Execution router');
  const registryAddress = addr(coreChain.contracts.positionRegistry.address, 'Position registry');
  for (const [a, label] of [[ledgerAddress, 'Gateway ledger'], [routerAddress, 'Execution router'],
    [registryAddress, 'Position registry'], [swapRouter, 'Uniswap swap router'], [positionManager, 'Uniswap position manager'],
    [token0, 'token0'], [token1, 'token1']]) await code(provider, a, label);

  const ledger = new ethers.Contract(ledgerAddress, art('QrosGatewayLedger').abi, wallet);
  const router = new ethers.Contract(routerAddress, art('QrosExecutionRouter').abi, wallet);
  const registry = new ethers.Contract(registryAddress, art('QrosPositionRegistry').abi, wallet);
  await Promise.all([
    ledger.owner().then(v => { if (!same(v, owner)) throw new Error('Gateway ledger owner mismatch.'); }),
    router.owner().then(v => { if (!same(v, owner)) throw new Error('Execution router owner mismatch.'); }),
    registry.owner().then(v => { if (!same(v, owner)) throw new Error('Position registry owner mismatch.'); })
  ]);

  const managerAbi = [
    'function factory() view returns (address)',
    'function ownerOf(uint256) view returns (address)'
  ];
  const factoryAbi = ['function getPool(address,address,uint24) view returns (address)'];
  const manager = new ethers.Contract(positionManager, managerAbi, provider);
  const factoryAddress = addr(await manager.factory(), 'Uniswap V3 factory');
  await code(provider, factoryAddress, 'Uniswap V3 factory');
  const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
  const pool = await factory.getPool(token0, token1, poolFee);
  if (pool === ethers.ZeroAddress) throw new Error('Configured Uniswap V3 pool does not exist for token0/token1/poolFee.');
  await code(provider, pool, 'Uniswap V3 pool');
  if (swapFee !== 0) {
    const swapPool = await factory.getPool(token0, token1, swapFee);
    if (swapPool === ethers.ZeroAddress) throw new Error('Configured swap pool does not exist for token0/token1/swapFee.');
    await code(provider, swapPool, 'Uniswap V3 swap pool');
  }

  const outputFile = OUTPUT_FILE;
  const output = fs.existsSync(outputFile) ? readJson(outputFile) : { chainId, owner, createdAt: new Date().toISOString() };
  if (output.owner && !same(output.owner, owner)) throw new Error('Existing execution manifest belongs to a different owner.');
  let adapterAddress = output.adapter?.address;
  let adapter;
  if (adapterAddress) {
    adapterAddress = addr(adapterAddress, 'Existing Uniswap execution adapter');
    await code(provider, adapterAddress, 'Existing Uniswap execution adapter');
    adapter = new ethers.Contract(adapterAddress, art('UniswapV3LiquidityAdapter').abi, wallet);
    if (!same(await adapter.owner(), owner)) throw new Error('Existing Uniswap adapter owner mismatch.');
  } else {
    const a = art('UniswapV3LiquidityAdapter');
    console.log('Deploying UniswapV3LiquidityAdapter...');
    adapter = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(owner, ledgerAddress);
    const receipt = await adapter.deploymentTransaction().then(tx => tx.wait());
    if (!receipt || receipt.status !== 1) throw new Error('Uniswap execution adapter deployment failed.');
    adapterAddress = await adapter.getAddress();
    await code(provider, adapterAddress, 'New Uniswap execution adapter');
    output.adapter = { address: adapterAddress, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
    writeJson(outputFile, output);
    console.log('  deployed adapter: ' + adapterAddress);
  }

  const configuredRouter = await adapter.swapRouter();
  const configuredManager = await adapter.positionManager();
  const configuredRegistry = await adapter.registry();
  if (same(configuredRouter, ethers.ZeroAddress) && same(configuredManager, ethers.ZeroAddress) &&
      same(configuredRegistry, ethers.ZeroAddress)) {
    await send('configure Uniswap router/manager/registry', adapter.configure(swapRouter, positionManager, registryAddress));
  } else if (!same(configuredRouter, swapRouter) || !same(configuredManager, positionManager) ||
             !same(configuredRegistry, registryAddress)) {
    throw new Error('Existing Uniswap adapter protocol configuration differs from config; refusing to overwrite.');
  }
  await ensureBool('approve pool fee ' + poolFee, () => adapter.allowedPoolFees(poolFee), () => adapter.setPoolFee(poolFee, true));
  if (swapFee !== 0) {
    await ensureBool('approve swap fee ' + swapFee, () => adapter.allowedSwapFees(swapFee), () => adapter.setSwapFee(swapFee, true));
  }
  const pairKey = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address'], [cfg.strategyId, token0, token1]
  ));
  await ensureBool('approve strategy token pair', () => adapter.allowedStrategyPairs(pairKey),
    () => adapter.setStrategyPair(cfg.strategyId, token0, token1, true));
  await ensureBool('approve adapter in position registry', () => registry.approvedAdapters(adapterAddress),
    () => registry.setAdapter(adapterAddress, true));
  await ensureAddress('set Gateway execution adapter', () => ledger.executionAdapter(),
    () => ledger.setExecutionAdapter(adapterAddress), adapterAddress);
  await ensureAddress('set Gateway execution router', () => ledger.executionRouter(),
    () => ledger.setExecutionRouter(routerAddress), routerAddress);
  await ensureBool('enable token0 in Gateway', () => ledger.supportedAssets(token0), () => ledger.setAssetSupport(token0, true));
  await ensureBool('enable token1 in Gateway', () => ledger.supportedAssets(token1), () => ledger.setAssetSupport(token1, true));
  await ensureBool('approve execution strategy', () => router.approvedStrategies(cfg.strategyId),
    () => router.setStrategy(cfg.strategyId, true));

  output.status = 'execution-adapter-configured';
  output.chainId = chainId;
  output.owner = owner;
  output.ledger = ledgerAddress;
  output.executionRouter = routerAddress;
  output.positionRegistry = registryAddress;
  output.adapter = { ...(output.adapter || {}), address: adapterAddress };
  output.protocol = { swapRouter, positionManager, factory: factoryAddress, pool, token0, token1, poolFee, swapFee };
  output.strategyId = cfg.strategyId;
  output.configuredAt = new Date().toISOString();
  writeJson(outputFile, output);
  await provider.destroy();
  console.log('\nUniswap execution adapter configured. No user funds were moved and no strategy was executed.');
  console.log('Manifest: uniswap-execution-deployments.json');
}

main().catch(error => {
  console.error('\nUniswap execution configuration stopped:', error.stack || error);
  process.exitCode = 1;
});
