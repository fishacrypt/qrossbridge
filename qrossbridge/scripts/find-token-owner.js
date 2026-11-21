const { ethers } = require("ethers");

const expected = "0xd83a953b8af73e9198e58f23f0ca46c0a8d87dff";

console.log("Checking configured signing wallets...\n");

for (const [name, value] of Object.entries(process.env)) {
  if (!name.toUpperCase().includes("KEY") || !value) continue;

  try {
    const wallet = new ethers.Wallet(value);
    console.log(
      name,
      wallet.address,
      wallet.address.toLowerCase() === expected ? "<-- QMS TOKEN OWNER" : ""
    );
  } catch {}
}
