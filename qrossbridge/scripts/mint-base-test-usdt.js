const { ethers } = require("ethers");

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_84532);
  const signer = new ethers.Wallet(process.env.QMS_OWNER_KEY, provider);

  const token = new ethers.Contract(
    "0x9Bb95Ad4f02266C44728e54CEe8ab8E70aAe2683",
    ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)"],
    signer
  );

  const recipient = "0x28a3D0cD55f95F7153577cc53303E0Fa9d5cD718";

  await token.mint.staticCall(recipient, 10_000_000n);
  const tx = await token.mint(recipient, 10_000_000n);
  console.log("Mint transaction:", tx.hash);
  await tx.wait();
  console.log("Base USDT balance:", ethers.formatUnits(await token.balanceOf(recipient), 6));
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
