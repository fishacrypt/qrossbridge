// Deploy one chain's QMS Hub/Spoke Gateway adapter and its bridge-attestation verifier.
// This script deploys contracts only. Route/role configuration is a separate reviewed operation.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const root = path.join(__dirname, '..');
const artifact = name => JSON.parse(fs.readFileSync(path.join(root, 'build', name + '.json'), 'utf8'));
const required = name => {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(name + ' must be a valid non-zero address');
  }
  return value;
};

async function deploy(wallet, name, args) {
  const a = artifact(name);
  const contract = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  return { contract, address: await contract.getAddress(), block: receipt.blockNumber };
}

async function main() {
  const rpc = process.env.RPC_URL;
  const key = process.env.DEPLOYER_KEY;
  if (!rpc) throw new Error('RPC_URL is required');
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_KEY must be a 32-byte private key');

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider));
  const chainId = Number((await provider.getNetwork()).chainId);
  const owner = process.env.OWNER_ADDRESS || await wallet.getAddress();
  if (!ethers.isAddress(owner) || owner === ethers.ZeroAddress) throw new Error('Invalid OWNER_ADDRESS');
  const threshold = Number(process.env.QMS_ATTESTATION_THRESHOLD || 2);
  if (!Number.isInteger(threshold) || threshold < 1) throw new Error('Invalid QMS_ATTESTATION_THRESHOLD');

  const hubChainId = Number(process.env.QMS_HUB_CHAIN_ID || 19480);
  const hubBridge = required('QMS_HUB_BRIDGE');
  const hubWQMS = required('QMS_HUB_WQMS');
  const localBridge = required('QMS_LOCAL_BRIDGE');
  const localToken = required('QMS_LOCAL_WQMS');
  const ledger = required('QROS_GATEWAY_LEDGER');
  const settlementVerifier = required('QROS_SETTLEMENT_VERIFIER');
  const coordinator = required('QROS_TRANSFER_COORDINATOR');

  if (chainId === hubChainId && localBridge.toLowerCase() !== hubBridge.toLowerCase()) {
    throw new Error('On the QMS Hub, QMS_LOCAL_BRIDGE must equal QMS_HUB_BRIDGE');
  }
  if (chainId !== hubChainId && localBridge.toLowerCase() === hubBridge.toLowerCase()) {
    throw new Error('On a Spoke, QMS_LOCAL_BRIDGE must be the local QmsBridgeSpoke');
  }

  const verifier = await deploy(wallet, 'QrosQmsBridgeAttestationVerifier', [owner, threshold]);
  const adapter = await deploy(wallet, 'QrosQmsBridgeAdapter', [
    owner, ledger, settlementVerifier, coordinator, verifier.address,
    hubChainId, hubBridge, hubWQMS, localBridge, localToken
  ]);

  console.log(JSON.stringify({
    chainId, owner,
    qmsBridgeAttestationVerifier: verifier.address,
    qmsBridgeAttestationVerifierBlock: verifier.block,
    qrosQmsBridgeAdapter: adapter.address,
    qrosQmsBridgeAdapterBlock: adapter.block,
    note: 'Deployment only. Configure signers, remote routes, spoke adapter allowlist, ledger adapter, coordinator approval and verifier routes before use.'
  }, null, 2));
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
