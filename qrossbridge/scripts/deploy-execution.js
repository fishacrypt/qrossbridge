const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const QMS_ID = 19480;
const BASE_ID = 84532;

const OUTPUT = path.join(ROOT, 'execution-deployments.json');
const PENDING = path.join(ROOT, '.execution-deployments.pending.json');

function artifact(name) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8')
  );
}

function savePending(data) {
  fs.writeFileSync(PENDING, JSON.stringify(data, null, 2));
}

async function verifyNetwork(provider, expectedId, label) {
  const actual = BigInt(await provider.send('eth_chainId', []));
  if (actual !== BigInt(expectedId)) {
    throw new Error(`${label} RPC chain mismatch: ${actual}`);
  }
  console.log(`${label} network verified: ${expectedId}`);
}

async function deploy(wallet, name, args) {
  const a = artifact(name);
  if (!a.bytecode || a.bytecode === '0x') {
    throw new Error(`Missing bytecode for ${name}. Compile first.`);
  }

  console.log(`Deploying ${name}...`);
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  const receipt = await tx.wait();

  const address = await contract.getAddress();
  if ((await wallet.provider.getCode(address)) === '0x') {
    throw new Error(`${name} deployment has no contract code`);
  }

  console.log(`${name} deployed at ${address}`);

  return {
    address,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}

async function main() {
  if (fs.existsSync(OUTPUT)) {
    throw new Error(
      'execution-deployments.json already exists. Refusing to overwrite it.'
    );
  }

  const deployerKey = process.env.DEPLOYER_KEY;
  const relayerKey = process.env.RELAYER_KEY;

  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey || '')) {
    throw new Error('DEPLOYER_KEY must be a valid private key');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(relayerKey || '')) {
    throw new Error('RELAYER_KEY must be a valid private key');
  }

  const ownerAddress = new ethers.Wallet(deployerKey).address;
  const relayerAddress = new ethers.Wallet(relayerKey).address;

  if (ownerAddress.toLowerCase() === relayerAddress.toLowerCase()) {
    throw new Error('Owner and relayer must be different addresses');
  }

  const qmsProvider = new ethers.JsonRpcProvider(
    rpcFor(QMS_ID), QMS_ID, { staticNetwork: true }
  );
  const baseProvider = new ethers.JsonRpcProvider(
    rpcFor(BASE_ID), BASE_ID, { staticNetwork: true }
  );

  await verifyNetwork(qmsProvider, QMS_ID, 'QMS Testnet');
  await verifyNetwork(baseProvider, BASE_ID, 'Base Sepolia');

  const qmsWallet = new ethers.Wallet(deployerKey, qmsProvider);
  const baseWallet = new ethers.Wallet(deployerKey, baseProvider);

  let record = {
    qmsChainId: QMS_ID,
    destinationChainId: BASE_ID,
    owner: ownerAddress,
    relayer: relayerAddress,
    deployedAt: new Date().toISOString()
  };

  if (fs.existsSync(PENDING)) {
    record = JSON.parse(fs.readFileSync(PENDING, 'utf8'));

    if (record.qmsChainId !== QMS_ID ||
        record.destinationChainId !== BASE_ID ||
        record.owner.toLowerCase() !== ownerAddress.toLowerCase() ||
        record.relayer.toLowerCase() !== relayerAddress.toLowerCase()) {
      throw new Error('Pending deployment record does not match this configuration');
    }

    console.log('Resuming the existing partial deployment.');
  }

  if (record.gateway) {
    if ((await qmsProvider.getCode(record.gateway.address)) === '0x') {
      throw new Error('Recorded QMS gateway has no code; manual review required');
    }
    console.log(`Existing gateway verified: ${record.gateway.address}`);
  } else {
    record.gateway = await deploy(
      qmsWallet,
      'QrosIntentGateway',
      [ownerAddress, relayerAddress, BASE_ID]
    );
    record.qmsStartBlock = record.gateway.blockNumber;
    savePending(record);
  }

  if (record.vault) {
    if ((await baseProvider.getCode(record.vault.address)) === '0x') {
      throw new Error('Recorded Base vault has no code; manual review required');
    }
    console.log(`Existing vault verified: ${record.vault.address}`);
  } else {
    record.vault = await deploy(
      baseWallet,
      'QrosLiquidityVault',
      [ownerAddress, relayerAddress, QMS_ID]
    );
    record.baseStartBlock = record.vault.blockNumber;
    savePending(record);
  }

  if (!record.qmsStartBlock || !record.baseStartBlock) {
    throw new Error('Deployment block information is incomplete');
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(record, null, 2));
  fs.unlinkSync(PENDING);

  console.log('\nBoth execution contracts deployed successfully.');
  console.log(`Gateway: ${record.gateway.address}`);
  console.log(`Vault:   ${record.vault.address}`);
  console.log(`Record:  ${OUTPUT}`);
}

main().catch(error => {
  console.error('Execution deployment failed:', error.shortMessage || error.message);
  process.exitCode = 1;
});