const { ethers } = require("ethers");

const tokens = [
  {
    name: "QMS Testnet",
    rpc: process.env.RPC_19480,
    key: process.env.QMS_OWNER_KEY,
    token: "0x5D1386fC130143F92511bC2D18124D3E414ed429",
    recipient: "0xEae9a255D6AcB4994f335AE3B92ECC421F03ad0d"
  },
  {
    name: "Base Sepolia",
    rpc: process.env.RPC_84532,
    key: process.env.BASE_OWNER_KEY,
    token: "0x9Bb95Ad4f02266C44728e54CEe8ab8E70aAe2683",
    recipient: "0x28a3D0cD55f95F7153577cc53303E0Fa9d5cD718"
  }
];

const abi = [
  "function owner() view returns (address)",
  "function mint(address to, uint256 amount)",
  "function decimals() view returns (uint8)"
];

async function main() {
  for (const item of tokens) {
    console.log(`\nChecking ${item.name}...`);
    try {
      const provider = new ethers.JsonRpcProvider(item.rpc);
      const wallet = new ethers.Wallet(item.key, provider);
      const token = new ethers.Contract(item.token, abi, wallet);

      console.log("Wallet:", wallet.address);
      console.log("Decimals:", await token.decimals());

      const owner = await token.owner();
      console.log("Token owner:", owner);

      await token.mint.staticCall(
        item.recipient,
        10_000_000n
      );

      console.log("MINT CHECK: Authorized — 10 USDT simulation passed.");
    } catch (error) {
      console.log("MINT CHECK FAILED:", error.shortMessage || error.message);
    }
  }
}

main().catch(console.error);
