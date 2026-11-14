const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { chains, rpcFor } = require('./chains');

const CHAIN_ID = 84532;
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const root = path.join(__dirname, '..');

async function main(env = process.env) {
  const key = env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('DEPLOYER_KEY must be a valid 32-byte private key');
  }

  const existing = JSON.parse(
    fs.readFileSync(path.join(root, 'deployments.json'), 'utf8')
  );
  const owner = existing.owner;

  if (!ethers.isAddress(owner) || owner === ethers.ZeroAddress) {
    throw new Error('Existing deployments.json has no valid owner address');
  }

  const outputFile = path.join(root, 'stablecoin-deployments.json');
  if (fs.existsSync(outputFile)) {
    throw new Error(
      'stablecoin-deployments.json already exists. Refusing to overwrite it.'
    );
  }

  const provider = new ethers.JsonRpcProvider(
    rpcFor(CHAIN_ID, env),
    CHAIN_ID,
    { staticNetwork: true, cacheTimeout: -1 }
  );

  const actualChainId = await provider.send('eth_chainId', []);
  if (BigInt(actualChainId) !== BigInt(CHAIN_ID)) {
    throw new Error(`Wrong network: expected ${CHAIN_ID}, got ${actualChainId}`);
  }

  const usdcCode = await provider.getCode(USDC_ADDRESS);
  if (usdcCode === '0x' || usdcCode === '0x0') {
    throw new Error('Circle USDC contract code not found on Base Sepolia');
  }

  const usdc = new ethers.Contract(
    USDC_ADDRESS,
    [
      'function name() view returns (string)',
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)'
    ],
    provider
  );

  const [usdcName, usdcSymbol, usdcDecimals] = await Promise.all([
    usdc.name(),
    usdc.symbol(),
    usdc.decimals()
  ]);

  if (usdcSymbol !== 'USDC' || Number(usdcDecimals) !== 6) {
    throw new Error('Circle USDC metadata did not match expected USDC / 6 decimals');
  }

  const artifact = JSON.parse(
    fs.readFileSync(path.join(root, 'build', 'QrosTestUSDT.json'), 'utf8')
  );

  if (!artifact.bytecode || artifact.bytecode === '0x') {
    throw new Error('QrosTestUSDT bytecode is missing. Run npm.cmd run compile first.');
  }

  const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider));
  console.log('Network verified:', chains[CHAIN_ID].name);
  console.log('USDC verified:', usdcName, usdcSymbol, Number(usdcDecimals), 'decimals');
  console.log('Token owner:', owner);
  console.log('Deploying QROS Test USDT...');

  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  const token = await factory.deploy(owner);
  const receipt = await token.deploymentTransaction().wait();
  const address = await token.getAddress();

  const deployed = new ethers.Contract(address, artifact.abi, provider);
  const [name, symbol, decimals, actualOwner] = await Promise.all([
    deployed.name(),
    deployed.symbol(),
    deployed.decimals(),
    deployed.owner()
  ]);

  if (
    name !== 'QROS Test USDT' ||
    symbol !== 'USDT' ||
    Number(decimals) !== 6 ||
    actualOwner.toLowerCase() !== owner.toLowerCase()
  ) {
    throw new Error('Post-deployment token verification failed');
  }

  const result = {
    chainId: CHAIN_ID,
    network: chains[CHAIN_ID].name,
    deployedAt: new Date().toISOString(),
    deployer: await wallet.getAddress(),
    owner,
    assets: {
      USDC: {
        name: usdcName,
        symbol: usdcSymbol,
        decimals: Number(usdcDecimals),
        address: USDC_ADDRESS,
        issuer: 'Circle'
      },
      USDT: {
        name,
        symbol,
        decimals: Number(decimals),
        address,
        issuer: 'QROS test token',
        transactionHash: receipt.hash,
        deploymentBlock: receipt.blockNumber
      }
    }
  };

  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log('\nQROS Test USDT deployed and verified:', address);
  console.log('Transaction:', receipt.hash);
  console.log('Saved:', outputFile);
}

module.exports = { main };
if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}
