
const fs = require('fs');
const { ethers } = require('ethers');

const manifest = JSON.parse(
  fs.readFileSync('gateway-stablecoin-deployments.json', 'utf8')
);

const chains = [
  { id: 19480, name: 'QMS Testnet', rpc: 'RPC_19480', key: 'QMS_OWNER_KEY' },
  { id: 84532, name: 'Base Sepolia', rpc: 'RPC_84532', key: 'BASE_OWNER_KEY' }
];

const tokenAbi = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

const adapterAbi = [
  'function liquidityBalance(address) view returns (uint256)'
];

async function main() {
  for (const cfg of chains) {
    console.log(`\nChecking ${cfg.name}...`);

    const entry = manifest.chains[String(cfg.id)];
    const rpc = process.env[cfg.rpc];
    const key = process.env[cfg.key];

    if (!entry || !rpc || !key) {
      console.log('Missing configuration. Skipping.');
      continue;
    }

    const request = new ethers.FetchRequest(rpc);
    request.timeout = 120000;

    const provider = new ethers.JsonRpcProvider(
      request, cfg.id, { staticNetwork: true }
    );

    try {
      console.log('Reading block number...');
      console.log('Block:', await provider.getBlockNumber());

      const wallet = new ethers.Wallet(key, provider);
      const token = new ethers.Contract(entry.asset, tokenAbi, provider);
      const adapter = new ethers.Contract(
        entry.adapter.address, adapterAbi, provider
      );

      const decimals = await token.decimals();
      const walletBalance = await token.balanceOf(wallet.address);
      const adapterBalance = await adapter.liquidityBalance(entry.asset);

      console.log('Wallet:', wallet.address);
      console.log('Wallet USDT:', ethers.formatUnits(walletBalance, decimals));
      console.log('Adapter:', entry.adapter.address);
      console.log('Adapter USDT:', ethers.formatUnits(adapterBalance, decimals));
    } catch (error) {
      console.log('READ FAILED:', error.shortMessage || error.message);
    } finally {
      provider.destroy();
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
