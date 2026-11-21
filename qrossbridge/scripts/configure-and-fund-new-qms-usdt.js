const fs = require("fs");
const { ethers } = require("ethers");

const QMS_ID = 19480;
const BASE_ID = 84532;
const TARGET = 10_000_000n;

const qmsToken = JSON.parse(
  fs.readFileSync("qms-test-usdt-deployment.json", "utf8")
).address;

const manifest = JSON.parse(
  fs.readFileSync("gateway-stablecoin-deployments.json", "utf8")
);

const qms = manifest.chains["19480"];
const base = manifest.chains["84532"];

const baseToken = base.asset;
const qmsAdapter = qms.adapter.address;
const baseAdapter = base.adapter.address;

const erc20Abi = [
  "function owner() view returns (address)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)"
];

const ledgerAbi = JSON.parse(
  fs.readFileSync("build/QrosGatewayLedger.json", "utf8")
).abi;

const adapterAbi = JSON.parse(
  fs.readFileSync("build/QrosAttestedLiquidityAdapter.json", "utf8")
).abi;

async function tx(label, promise) {
  const transaction = await promise;
  console.log(`${label}: ${transaction.hash}`);
  await transaction.wait();
  console.log(`${label}: confirmed`);
}

async function main() {
  const qmsProvider = new ethers.JsonRpcProvider(
    process.env.RPC_19480, QMS_ID, { staticNetwork: true }
  );
  const baseProvider = new ethers.JsonRpcProvider(
    process.env.RPC_84532, BASE_ID, { staticNetwork: true }
  );

  const qmsWallet = new ethers.Wallet(
    process.env.QMS_OWNER_KEY, qmsProvider
  );
  const baseWallet = new ethers.Wallet(
    process.env.BASE_OWNER_KEY, baseProvider
  );

  const qmsExpected = "0xeae9a255d6acb4994f335ae3b92ecc421f03ad0d";
  const baseExpected = "0x28a3d0cd55f95f7153577cc53303e0fa9d5cD718".toLowerCase();

  if (qmsWallet.address.toLowerCase() !== qmsExpected)
    throw new Error("Unexpected QMS signing wallet.");
  if (baseWallet.address.toLowerCase() !== baseExpected)
    throw new Error("Unexpected Base signing wallet.");

  if ((await qmsProvider.getNetwork()).chainId !== BigInt(QMS_ID))
    throw new Error("QMS chain mismatch.");
  if ((await baseProvider.getNetwork()).chainId !== BigInt(BASE_ID))
    throw new Error("Base chain mismatch.");

  const qmsLedger = new ethers.Contract(qms.gatewayLedger, ledgerAbi, qmsWallet);
  const qmsAdapterContract = new ethers.Contract(qmsAdapter, adapterAbi, qmsWallet);
  const baseAdapterContract = new ethers.Contract(baseAdapter, adapterAbi, baseWallet);

  const qmsCoin = new ethers.Contract(qmsToken, erc20Abi, qmsWallet);
  const qmsWalletOnBase = new ethers.Wallet(process.env.QMS_OWNER_KEY, baseProvider);
const baseCoinForOwner = new ethers.Contract(baseToken, erc20Abi, qmsWalletOnBase);
  const baseCoin = new ethers.Contract(baseToken, erc20Abi, baseWallet);

  // Preflight ownership checks.
  for (const [label, contract, expected] of [
    ["QMS ledger", qmsLedger, qmsWallet.address],
    ["QMS adapter", qmsAdapterContract, qmsWallet.address],
    ["Base adapter", baseAdapterContract, baseWallet.address],
    ["QMS token", qmsCoin, qmsWallet.address],
    ["Base token", baseCoinForOwner, qmsWallet.address]
  ]) {
    const actual = await contract.owner();
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new Error(`${label} owner mismatch: ${actual}`);
    console.log(`${label} ownership verified.`);
  }

  // Ensure both wallets have gas before making changes.
  const qmsGas = await qmsProvider.getBalance(qmsWallet.address);
  const baseGas = await baseProvider.getBalance(baseWallet.address);
  const baseMintGas = await baseProvider.getBalance(qmsWallet.address);

  if (qmsGas === 0n || baseGas === 0n || baseMintGas === 0n) {
    throw new Error(
      "A transaction wallet needs native gas. Check QMS owner gas on QMS and Base, and Base owner gas on Base."
    );
  }

  // Verify QMS test token is already funded.
  let qmsBalance = await qmsCoin.balanceOf(qmsWallet.address);
  if (qmsBalance < TARGET)
    throw new Error("QMS owner has less than 10 new test USDT.");

  // Mint Base test USDT using its actual owner.
  let baseOwnerBalance = await baseCoinForOwner.balanceOf(baseWallet.address);

  if (baseOwnerBalance < TARGET) {
    const difference = TARGET - baseOwnerBalance;
    console.log("\nMinting Base Sepolia test USDT:", ethers.formatUnits(difference, 6));
    await baseCoinForOwner.mint.staticCall(baseWallet.address, difference);
    await tx("Base test USDT mint", baseCoinForOwner.mint(baseWallet.address, difference));
  } else {
    console.log("\nBase owner already has at least 10 USDT; no mint needed.");
  }

  // Add the new QMS asset without disabling the existing token.
  console.log("\nConfiguring QMS ledger...");
  if (!(await qmsLedger.supportedAssets(qmsToken))) {
    await tx("Enable new QMS asset", qmsLedger.setAssetSupport(qmsToken, true));
  }

  const currentMapping = await qmsLedger.settlementAdapters(qmsToken);
  if (currentMapping.toLowerCase() !== qmsAdapter.toLowerCase()) {
    await tx(
      "Assign QMS settlement adapter",
      qmsLedger.setSettlementAdapterForAsset(qmsToken, qmsAdapter)
    );
  }

  // Verify existing adapters are already approved by their coordinators.
  const qmsCoordinator = new ethers.Contract(
    qms.transferCoordinator,
    ["function approvedAdapters(address) view returns (bool)"],
    qmsProvider
  );
  const baseCoordinator = new ethers.Contract(
    base.transferCoordinator,
    ["function approvedAdapters(address) view returns (bool)"],
    baseProvider
  );

  if (!(await qmsCoordinator.approvedAdapters(qmsAdapter)))
    throw new Error("QMS adapter is not approved by its coordinator.");
  if (!(await baseCoordinator.approvedAdapters(baseAdapter)))
    throw new Error("Base adapter is not approved by its coordinator.");

  // Enable both directions, preserving other existing routes.
  const qmsRoute = await qmsAdapterContract.routeId(qmsToken, BASE_ID, baseToken);
  if (!(await qmsAdapterContract.outboundRouteEnabled(qmsRoute))) {
    await tx(
      "Enable QMS to Base route",
      qmsAdapterContract.setOutboundRoute(qmsToken, BASE_ID, baseToken, true)
    );
  }

  const baseRoute = await baseAdapterContract.routeId(baseToken, QMS_ID, qmsToken);
  if (!(await baseAdapterContract.outboundRouteEnabled(baseRoute))) {
    await tx(
      "Enable Base to QMS route",
      baseAdapterContract.setOutboundRoute(baseToken, QMS_ID, qmsToken, true)
    );
  }

  // Fund each adapter to a target of 10 USDT.
  async function fund(label, token, adapterAddress, adapter, wallet) {
    const current = await adapter.liquidityBalance(await token.getAddress());
    console.log(`${label} existing adapter liquidity: ${ethers.formatUnits(current, 6)} USDT`);

    if (current >= TARGET) {
      console.log(`${label}: target liquidity already met.`);
      return;
    }

    const amount = TARGET - current;
    const balance = await token.balanceOf(wallet.address);

    if (balance < amount)
      throw new Error(`${label}: wallet has insufficient USDT for funding.`);

    const allowance = await token.allowance(wallet.address, adapterAddress);
    if (allowance < amount) {
      await tx(`${label} approve adapter`, token.approve(adapterAddress, amount));
    }

    await tx(
      `${label} fund adapter`,
      adapter.fundLiquidity(await token.getAddress(), amount)
    );

    const finalBalance = await adapter.liquidityBalance(await token.getAddress());
    if (finalBalance < TARGET)
      throw new Error(`${label}: liquidity verification failed.`);

    console.log(`${label} final liquidity: ${ethers.formatUnits(finalBalance, 6)} USDT`);
  }

  await fund("QMS", qmsCoin, qmsAdapter, qmsAdapterContract, qmsWallet);
  await fund("Base", baseCoin, baseAdapter, baseAdapterContract, baseWallet);

  console.log("\n--- FINAL VERIFICATION ---");
  console.log("QMS token:", qmsToken);
  console.log("QMS asset supported:", await qmsLedger.supportedAssets(qmsToken));
  console.log("QMS adapter mapping:", await qmsLedger.settlementAdapters(qmsToken));
  console.log("QMS adapter liquidity:", ethers.formatUnits(
    await qmsAdapterContract.liquidityBalance(qmsToken), 6
  ));
  console.log("Base adapter liquidity:", ethers.formatUnits(
    await baseAdapterContract.liquidityBalance(baseToken), 6
  ));
  console.log("QMS -> Base route:", await qmsAdapterContract.outboundRouteEnabled(qmsRoute));
  console.log("Base -> QMS route:", await baseAdapterContract.outboundRouteEnabled(baseRoute));
  console.log("\nConfiguration and liquidity steps completed.");
}

main().catch(error => {
  console.error("\nSTOPPED:", error.shortMessage || error.message);
  process.exitCode = 1;
});


