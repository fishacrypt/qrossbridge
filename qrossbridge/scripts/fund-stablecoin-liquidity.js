
const fs = require('fs');
const { ethers } = require('ethers');

const manifest = JSON.parse(
  fs.readFileSync('gateway-stablecoin-deployments.json', 'utf8')
);

const TARGET = 10n;
const CHAINS = [
  { id: '19480', rpc: 'RPC_19480', key: 'QMS_OWNER_KEY' },
  { id: '84532', rpc: 'RPC_84532', key: 'BASE_OWNER_KEY' }
];

const tokenAbi = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];

const adapterAbi = [
  'function fundLiquidity(address,uint256)',
  'function liquidityBalance(address) view returns (uint256)'
];

async function main() {
  for (const cfg of CHAINS) {
    const chain = manifest.chains[cfg.id];
    const rpc = process.env[cfg.rpc];
    const key = process.env[cfg.key];

    if (!chain || !rpc || !key) {
      throw new Error(`Missing configuration for chain ${cfg.id}`);
    }

    const provider = new ethers.JsonRpcProvider(rpc);
    const signer = new ethers.Wallet(key, provider);

    try {
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(cfg.id)) {
        throw new Error(`Wrong network for ${chain.name}`);
      }

      const token = new ethers.Contract(chain.asset, tokenAbi, signer);
      const adapter = new ethers.Contract(
        chain.adapter.address, adapterAbi, signer
      );

      const decimals = await token.decimals();
      if (decimals !== 6 || await token.symbol() !== 'USDT') {
        throw new Error(`Unexpected token on ${chain.name}`);
      }

      const target = ethers.parseUnits(TARGET.toString(), decimals);
      const current = await adapter.liquidityBalance(chain.asset);

      console.log(`\n${chain.name}`);
      console.log('Adapter:', chain.adapter.address);
      console.log('Current liquidity:', ethers.formatUnits(current, decimals));

      if (current >= target) {
        console.log('Target already reached. No funding needed.');
        continue;
      }

      const amount = target - current;
      const walletBalance = await token.balanceOf(signer.address);

      if (walletBalance < amount) {
        throw new Error(
          `Insufficient wallet USDT. Required: ${ethers.formatUnits(amount, decimals)}, available: ${ethers.formatUnits(walletBalance, decimals)}`
        );
      }

      let allowance = await token.allowance(
        signer.address, chain.adapter.address
      );

      if (allowance < amount) {
        if (allowance > 0n) {
          const reset = await token.approve(chain.adapter.address, 0n);
          await reset.wait();
        }

        const approval = await token.approve(chain.adapter.address, amount);
        await approval.wait();
        console.log('Approval confirmed:', approval.hash);
      }

      const tx = await adapter.fundLiquidity(chain.asset, amount);
      await tx.wait();
      console.log('Funding confirmed:', tx.hash);

      const finalBalance = await adapter.liquidityBalance(chain.asset);
      console.log('Final adapter liquidity:', ethers.formatUnits(finalBalance, decimals));

      if (finalBalance < target) {
        throw new Error('Final liquidity is below target.');
      }
    } finally {
      provider.destroy();
    }
  }

  console.log('\nBoth stablecoin adapter funding checks completed.');
}

main().catch(error => {
  console.error('\nFunding stopped:', error.message || error);
  process.exitCode = 1;
});
