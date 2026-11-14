const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const QMS_ID = 19480;
const BASE_ID = 84532;
const AMOUNT = 5_000_000n; // 5 tokens, 6 decimals
const FEE_BPS = 0;

const QMS_ASSETS = {
  USDC: '0xDd4D61DF875cc613E1372c78827a5F4C2741bf11',
  USDT: '0x5D1386fC130143F92511bC2D18124D3E414ed429'
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];

async function wait(label, tx) {
  console.log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed`);
  console.log(`${label}: confirmed in block ${receipt.blockNumber}`);
}

async function main() {
  if (!process.env.DEPLOYER_KEY) {
    throw new Error('DEPLOYER_KEY is missing from .env');
  }

  const deployments = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'execution-deployments.json'), 'utf8')
  );

  const stable = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'stablecoin-deployments.json'), 'utf8')
  );

  if (stable.chainId !== BASE_ID) {
    throw new Error('stablecoin-deployments.json is not for Base Sepolia');
  }

  const walletAddress = new ethers.Wallet(process.env.DEPLOYER_KEY).address;

  if (ethers.getAddress(walletAddress) !== ethers.getAddress(deployments.owner)) {
    throw new Error('DEPLOYER_KEY does not match execution deployment owner');
  }

  const qmsProvider = new ethers.JsonRpcProvider(rpcFor(QMS_ID));
  const baseProvider = new ethers.JsonRpcProvider(rpcFor(BASE_ID));

  if (Number((await qmsProvider.getNetwork()).chainId) !== QMS_ID) {
    throw new Error('QMS RPC chain ID mismatch');
  }

  if (Number((await baseProvider.getNetwork()).chainId) !== BASE_ID) {
    throw new Error('Base Sepolia RPC chain ID mismatch');
  }

  const qmsWallet = walletAddress
    ? new ethers.Wallet(process.env.DEPLOYER_KEY, qmsProvider)
    : null;

  const baseWallet = new ethers.Wallet(process.env.DEPLOYER_KEY, baseProvider);

  const gatewayArtifact = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'build', 'QrosIntentGateway.json'), 'utf8')
  );

  const vaultArtifact = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'build', 'QrosLiquidityVault.json'), 'utf8')
  );

  const gateway = new ethers.Contract(
    deployments.gateway.address,
    gatewayArtifact.abi,
    qmsWallet
  );

  const vault = new ethers.Contract(
    deployments.vault.address,
    vaultArtifact.abi,
    baseWallet
  );

  const assets = {
    USDC: {
      source: QMS_ASSETS.USDC,
      destination: stable.assets.USDC.address
    },
    USDT: {
      source: QMS_ASSETS.USDT,
      destination: stable.assets.USDT.address
    }
  };

  console.log('Owner:', walletAddress);
  console.log('Gateway:', deployments.gateway.address);
  console.log('Vault:', deployments.vault.address);

  // Configure QMS source-to-Base destination routes.
  for (const [symbol, asset] of Object.entries(assets)) {
    const current = await gateway.assetRoutes(asset.source);

    const correct =
      ethers.getAddress(current.destinationAsset) === ethers.getAddress(asset.destination) &&
      ethers.getAddress(current.lp) === ethers.getAddress(walletAddress) &&
      BigInt(current.feeBps) === BigInt(FEE_BPS) &&
      current.enabled;

    if (correct) {
      console.log(`${symbol} gateway route already configured`);
    } else {
      await wait(
        `Configure ${symbol} gateway route`,
        await gateway.setAssetRoute(
          asset.source,
          asset.destination,
          walletAddress,
          FEE_BPS,
          true
        )
      );
    }
  }

  // Enable destination assets and bring available liquidity up to 5 each.
  for (const [symbol, asset] of Object.entries(assets)) {
    const supported = await vault.supportedAssets(asset.destination);

    if (!supported) {
      await wait(
        `Enable Base ${symbol}`,
        await vault.setAssetSupport(asset.destination, true)
      );
    } else {
      console.log(`Base ${symbol} already enabled`);
    }

    const available = await vault.availableLiquidity(asset.destination);
    const remaining = AMOUNT > available ? AMOUNT - available : 0n;

    if (remaining === 0n) {
      console.log(
        `${symbol}: vault already has ${ethers.formatUnits(available, 6)} available`
      );
      continue;
    }

    const token = new ethers.Contract(
      asset.destination,
      ERC20_ABI,
      baseWallet
    );

    const balance = await token.balanceOf(walletAddress);

    if (balance < remaining) {
      throw new Error(
        `Insufficient Base Sepolia ${symbol}. Required: ${ethers.formatUnits(remaining, 6)}, available in wallet: ${ethers.formatUnits(balance, 6)}`
      );
    }

    let allowance = await token.allowance(
      walletAddress,
      deployments.vault.address
    );

    if (allowance < remaining) {
      if (allowance > 0n) {
        await wait(
          `Reset ${symbol} approval`,
          await token.approve(deployments.vault.address, 0)
        );
      }

      await wait(
        `Approve ${symbol}`,
        await token.approve(deployments.vault.address, remaining)
      );
    } else {
      console.log(`${symbol} vault allowance is already sufficient`);
    }

    await wait(
      `Fund vault with ${ethers.formatUnits(remaining, 6)} ${symbol}`,
      await vault.fundLiquidity(asset.destination, remaining)
    );
  }

  console.log('\nExecution configuration and liquidity funding completed.');
}

main().catch(error => {
  console.error('\nExecution setup stopped:', error.shortMessage || error.message);
  process.exitCode = 1;
});