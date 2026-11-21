const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

async function main() {
  const chainId = 19480n;
  const rpc = process.env.RPC_19480;
  const key = process.env.QMS_OWNER_KEY;
  const recipient = "0xeae9a255d6acb4994f335ae3b92ecc421f03ad0d";
  const output = path.join(__dirname, "..", "qms-test-usdt-deployment.json");
  const artifactPath = path.join(__dirname, "..", "build", "QrosTestUSDT.json");

  if (!rpc || !key) throw new Error("QMS RPC or owner key is missing.");
  if (fs.existsSync(output)) throw new Error("Deployment record already exists. Stopping.");
  if (!fs.existsSync(artifactPath)) throw new Error("Compile contracts first.");

  const provider = new ethers.JsonRpcProvider(rpc, Number(chainId), {
    staticNetwork: true
  });

  const wallet = new ethers.Wallet(key, provider);

  if (wallet.address.toLowerCase() !== recipient.toLowerCase()) {
    throw new Error("QMS_OWNER_KEY does not match the expected QMS owner.");
  }

  const network = await provider.getNetwork();
  if (network.chainId !== chainId) throw new Error("Wrong network.");

  const balance = await provider.getBalance(wallet.address);
  console.log("QMS owner:", wallet.address);
  console.log("Native gas balance:", ethers.formatEther(balance));

  if (balance === 0n) throw new Error("Owner wallet needs QMS gas tokens.");

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const factory = new ethers.ContractFactory(
    artifact.abi,
    artifact.bytecode,
    wallet
  );

  console.log("\nDeploying QROS Test USDT...");
  const token = await factory.deploy(recipient);
  const deployTx = token.deploymentTransaction();
  console.log("Deployment transaction:", deployTx.hash);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("Token deployed:", address);

  console.log("\nMinting 10 USDT...");
  const mintTx = await token.mint(recipient, 10_000_000n);
  console.log("Mint transaction:", mintTx.hash);
  await mintTx.wait();

  const owner = await token.owner();
  const amount = await token.balanceOf(recipient);

  if (owner.toLowerCase() !== recipient.toLowerCase()) {
    throw new Error("Unexpected token owner.");
  }
  if (amount < 10_000_000n) throw new Error("Mint balance verification failed.");

  const record = {
    name: "QROS Test USDT",
    symbol: "USDT",
    decimals: 6,
    chainId: 19480,
    address,
    owner,
    recipient,
    mintedAmount: "10",
    deploymentTransaction: deployTx.hash,
    mintTransaction: mintTx.hash,
    status: "deployed-and-minted"
  };

  fs.writeFileSync(output, JSON.stringify(record, null, 2));
  console.log("\nSUCCESS");
  console.log("QMS USDT balance:", ethers.formatUnits(amount, 6));
  console.log("Record saved:", output);
}

main().catch(error => {
  console.error("\nDeployment stopped:", error.shortMessage || error.message);
  process.exitCode = 1;
});

