// Replace only the Base QMS Gateway adapter so it can use the already-deployed
// legacy Spoke's bridgeBack() function. No Spoke redeployment, token migration,
// validator changes, user-balance changes, or production cutover occurs here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { chains, rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const CORE_FILE = path.join(ROOT, 'gateway-migration-deployments.json');
const PREP_FILE = path.join(ROOT, 'gateway-migration-adapter-preparations.json');
const BRIDGE_FILE = path.join(ROOT, 'deployments.json');

function read(file) {
  if (!fs.existsSync(file)) throw new Error('Missing ' + path.basename(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function address(value, label) {
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(label + ' missing or invalid');
  return ethers.getAddress(value);
}
function same(a,b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
function key(value,label) {
  const k = value && !value.startsWith('0x') ? '0x'+value : value;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(label+' must be configured in local .env');
  return k;
}
function artifact(name) {
  const f=path.join(ROOT,'build',name+'.json');
  if (!fs.existsSync(f)) throw new Error('Missing build/'+name+'.json; run npm.cmd run compile first.');
  const a=read(f);
  if (!a.bytecode || a.bytecode==='0x' || !Array.isArray(a.abi)) throw new Error('Invalid artifact '+name);
  return a;
}
async function send(label,promise) {
  const tx=await promise, receipt=await tx.wait();
  if (!receipt || receipt.status!==1) throw new Error(label+' failed');
  console.log('  ✓ '+label+' ['+receipt.hash+']');
  return receipt;
}
async function main() {
  const state=read(CORE_FILE), prep=read(PREP_FILE), bridges=read(BRIDGE_FILE);
  const id='84532', chain=state.chains?.[id], pc=prep.chains?.[id], bc=bridges.chains?.[id];
  if (!chain?.contracts || !pc?.qmsBridgeAdapter?.address || !pc?.bridgeVerifier?.address || !bc?.bridge || !bc?.token) {
    throw new Error('Base migration deployment/preparation records are incomplete.');
  }
  const baseKey=key(process.env.BASE_OWNER_KEY,'BASE_OWNER_KEY');
  const owner=address(chain.owner,'Base Gateway owner');
  const walletAddress=new ethers.Wallet(baseKey).address;
  if (!same(walletAddress,owner)) throw new Error('BASE_OWNER_KEY does not match Base Gateway owner '+owner);
  const provider=new ethers.JsonRpcProvider(rpcFor(84532),84532,{staticNetwork:true,cacheTimeout:-1});
  const network=await provider.getNetwork();
  if (Number(network.chainId)!==84532) throw new Error('Base RPC chain ID mismatch.');
  const wallet=new ethers.NonceManager(new ethers.Wallet(baseKey,provider));
  const ledgerAddress=address(chain.contracts.gatewayLedger.address,'Base Gateway ledger');
  const coordinatorAddress=address(chain.contracts.transferCoordinator.address,'Base coordinator');
  const settlementVerifier=address(chain.contracts.settlementVerifier.address,'Base settlement verifier');
  const bridgeVerifier=address(pc.bridgeVerifier.address,'Base bridge verifier');
  const bridge=address(bc.bridge,'Existing Base Spoke');
  const token=address(bc.token,'Existing Base wQMS');
  const hubBridge=address(bridges.chains['19480'].bridge,'QMS Hub bridge');
  const hubToken=address(bridges.wqms,'QMS Hub wQMS');
  const previous=address(pc.qmsBridgeAdapter.address,'Current Base QMS adapter');

  for (const [a,label] of [[ledgerAddress,'ledger'],[coordinatorAddress,'coordinator'],[settlementVerifier,'settlement verifier'],
    [bridgeVerifier,'bridge verifier'],[bridge,'legacy Spoke'],[token,'wQMS'],[hubBridge,'Hub bridge'],[hubToken,'Hub wQMS']]) {
    if (await provider.getCode(a)==='0x') throw new Error(label+' has no code at '+a);
  }
  const ledger=new ethers.Contract(ledgerAddress,artifact('QrosGatewayLedger').abi,wallet);
  const coordinator=new ethers.Contract(coordinatorAddress,artifact('QrosTransferCoordinator').abi,wallet);
  if (!same(await ledger.owner(),owner) || !same(await coordinator.owner(),owner)) throw new Error('Base Gateway ownership verification failed.');
  if (!same(await coordinator.ledger(),ledgerAddress)) throw new Error('Base coordinator is not connected to the replacement ledger.');
  if (!await ledger.supportedAssets(token)) throw new Error('Existing Base wQMS is not enabled for Gateway custody.');
  const current=await ledger.settlementAdapters(token);
  if (!same(current,previous)) throw new Error('Ledger adapter changed since preparation. Expected '+previous+', found '+current+'. Refusing to replace.');
  if (same(current,ethers.ZeroAddress)) throw new Error('No existing adapter is assigned; use the normal preparation workflow instead.');

  const a=artifact('QrosQmsBridgeAdapter');
  console.log('Deploying backward-compatible Base QMS adapter...');
  const instance=await new ethers.ContractFactory(a.abi,a.bytecode,wallet).deploy(
    owner,ledgerAddress,settlementVerifier,coordinatorAddress,bridgeVerifier,
    19480,hubBridge,hubToken,bridge,token
  );
  const receipt=await instance.deploymentTransaction().wait();
  if (!receipt || receipt.status!==1) throw new Error('Replacement Base QMS adapter deployment failed.');
  const next=await instance.getAddress();
  if (await provider.getCode(next)==='0x') throw new Error('Replacement adapter has no deployed code.');
  if (!same(await instance.owner(),owner) || !same(await instance.ledger(),ledgerAddress) ||
      !same(await instance.coordinator(),coordinatorAddress) || !same(await instance.localBridge(),bridge) ||
      !same(await instance.localToken(),token)) throw new Error('Replacement adapter constructor binding verification failed.');
  console.log('  ✓ deployed replacement adapter '+next+' ['+receipt.hash+']');

  await send('replace Base wQMS settlement adapter',ledger.setSettlementAdapterForAsset(token,next));
  if (!same(await ledger.settlementAdapters(token),next)) throw new Error('Ledger did not retain replacement adapter.');
  const approved=await coordinator.approvedAdapters(next);
  if (!approved) await send('approve replacement Base QMS adapter',coordinator.setAdapter(next,true));
  if (!await coordinator.approvedAdapters(next)) throw new Error('Coordinator approval did not persist.');

  const record={
    contractName:'QrosQmsBridgeAdapter',address:next,transactionHash:receipt.hash,
    blockNumber:receipt.blockNumber,owner,deployer:walletAddress,chainId:84532,
    replaces:previous,compatibility:'legacy-spoke-bridgeBack'
  };
  pc.previousQmsBridgeAdapter=previous;
  pc.qmsBridgeAdapter=record;
  pc.legacySpokeCompatibility='bridgeBack(uint256,address,bool); no Spoke redeployment required';
  chain.contracts.qmsBridgeAdapter=record;
  chain.compatibility=pc.legacySpokeCompatibility;
  chain.safeBaseline={...(chain.safeBaseline||{}),assetSettlementAdapterAssigned:true,coordinatorAdapterApproved:true};
  prep.activation=prep.activation||{};
  prep.activation.baseQmsAdapterUpgraded=true;
  prep.activation.spokeGatewayAdaptersAuthorized=false;
  prep.notes=[...(prep.notes||[]),'Base QMS adapter upgraded to call the existing legacy Spoke bridgeBack() path; old Spoke and wQMS contract remain in service.'];
  write(PREP_FILE,prep);
  write(CORE_FILE,state);
  await provider.destroy();
  console.log('\nBase QMS adapter upgrade complete.');
  console.log('Old Spoke and wQMS were preserved. Existing Gateway balances were not changed.');
  console.log('Next: npm.cmd run activate-qms-gateway');
}
main().catch(error=>{console.error('\nBase QMS adapter upgrade stopped:',error.stack||error);process.exitCode=1;});
