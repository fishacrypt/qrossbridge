// Full two-chain QMS Gateway adapter harness: real Hub/Spoke, real relayer,
// real Gateway ledger/coordinator, and both quorum proof layers. Local Ganache only.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Relayer, fileStore } = require('../relayer/relayer');
const { deliveryProof, cancellationProof, recoveryProof } = require('../scripts/settlement-attestation');
const { qmsBridgeDeliveryProof, combineSettlementAndBridgeProof } = require('../scripts/qms-bridge-attestation');
const root = path.join(__dirname, '..');
const art = n => JSON.parse(fs.readFileSync(path.join(root, 'build', n + '.json')));
const E = ethers.parseEther, HUB = 19480, SPOKE = 84532, coder = ethers.AbiCoder.defaultAbiCoder();
const tid = s => ethers.keccak256(ethers.toUtf8Bytes(s));
const msgId = (c,n) => ethers.keccak256(coder.encode(['uint256','uint256'],[c,n]));
const event = (c,r,n) => { for (const l of r.logs) { try { const p=c.interface.parseLog(l); if(p?.name===n)return p; } catch {} } throw Error('missing '+n); };
const rejects = async (p,label) => { let failed=false; try { await p; } catch { failed=true; } assert(failed,label); };

(async()=>{
 const hs=ganache.server({logging:{quiet:true},chain:{chainId:HUB},wallet:{deterministic:true,defaultBalance:10000}});
 const ss=ganache.server({logging:{quiet:true},chain:{chainId:SPOKE},wallet:{deterministic:true,defaultBalance:10000}});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qros-qms-')); let started=false;
 try {
  await hs.listen(18991); await ss.listen(18992); started=true;
  const hp=new ethers.JsonRpcProvider('http://127.0.0.1:18991',HUB,{staticNetwork:true});
  const sp=new ethers.JsonRpcProvider('http://127.0.0.1:18992',SPOKE,{staticNetwork:true});
  const keys=Object.values(await hs.provider.getInitialAccounts()).map(x=>x.secretKey);
  const wallet=(key,p)=>new ethers.Wallet(key,p);
  const ho=wallet(keys[0],hp), hr=wallet(keys[1],hp), hu=wallet(keys[2],hp), hv=wallet(keys[3],hp);
  const so=wallet(keys[0],sp), sr=wallet(keys[1],sp), su=wallet(keys[2],sp);
  const deploy=async(w,n,args=[])=>{const a=art(n),c=await new ethers.ContractFactory(a.abi,a.bytecode,w).deploy(...args);const r=await c.deploymentTransaction().wait();await c.waitForDeployment();return {c,a:await c.getAddress(),block:r.blockNumber};};
  const wrap=await deploy(ho,'MockWQMS');
  const hub=await deploy(ho,'QmsBridgeHub',[wrap.a,ho.address,hr.address]);
  const spoke=await deploy(so,'QmsBridgeSpoke',[HUB,so.address,sr.address]);
  const spokeToken=new ethers.Contract(await spoke.c.token(),art('WrappedQMS').abi,sp);
  await (await hub.c.setChainSupport(SPOKE,true)).wait();

  const hl=await deploy(ho,'QrosGatewayLedger',[ho.address]), sl=await deploy(so,'QrosGatewayLedger',[so.address]);
  const hc=await deploy(ho,'QrosTransferCoordinator',[ho.address,hl.a]), sc=await deploy(so,'QrosTransferCoordinator',[so.address,sl.a]);
  const hsv=await deploy(ho,'QrosQuorumAttestationVerifier',[ho.address,1]), ssv=await deploy(so,'QrosQuorumAttestationVerifier',[so.address,1]);
  const hbv=await deploy(ho,'QrosQmsBridgeAttestationVerifier',[ho.address,1]), sbv=await deploy(so,'QrosQmsBridgeAttestationVerifier',[so.address,1]);
  const hba=await deploy(ho,'QrosQmsBridgeAdapter',[ho.address,hl.a,hsv.a,hc.a,hbv.a,HUB,hub.a,wrap.a,hub.a,wrap.a]);
  const sba=await deploy(so,'QrosQmsBridgeAdapter',[so.address,sl.a,ssv.a,sc.a,sbv.a,HUB,hub.a,wrap.a,spoke.a,await spoke.c.token()]);
  const st=await spoke.c.token(), user=hu.address, validator=hv.address;

  for (const [ledger,asset,adapter,coord,owner] of [[hl,wrap.a,hba,hc,ho],[sl,st,sba,sc,so]]) {
   await (await ledger.c.setAssetSupport(asset,true)).wait();
   await (await ledger.c.setSettlementAdapter(adapter.a)).wait();
   await (await ledger.c.setTransferCoordinator(coord.a)).wait();
   await (await coord.c.setAdapter(adapter.a,true)).wait();
  }
  await (await spoke.c.setGatewayAdapter(sba.a,true)).wait();
  // Route.gatewayLedger is the remote destination ledger; inbound destination-ledger
  // binding is independently enforced by the settlement proof and local ledger address.
  await (await hba.c.setRemoteRoute(SPOKE,spoke.a,st,sba.a,sl.a,true)).wait();
  await (await sba.c.setRemoteRoute(HUB,hub.a,wrap.a,hba.a,hl.a,true)).wait();

  await (await ssv.c.setSigner(validator,true)).wait();
  await (await hsv.c.setSigner(validator,true)).wait();
  await (await sbv.c.setSigner(validator,true)).wait();
  await (await hbv.c.setSigner(validator,true)).wait();
  await (await ssv.c.setRoute(HUB,SPOKE,wrap.a,st,sl.a,true)).wait();
  await (await hsv.c.setRoute(SPOKE,HUB,st,wrap.a,hl.a,true)).wait();
  await (await sbv.c.setRoute(HUB,SPOKE,hub.a,spoke.a,wrap.a,st,hba.a,sba.a,true)).wait();
  await (await hbv.c.setRoute(SPOKE,HUB,spoke.a,hub.a,st,wrap.a,sba.a,hba.a,true)).wait();

  await (await wrap.c.connect(hu).deposit({value:E('12')})).wait();
  await (await wrap.c.connect(hu).approve(hl.a,E('12'))).wait();
  await (await hl.c.connect(hu).deposit(wrap.a,E('12'))).wait();

  const relayer=new Relayer({chains:{
   [HUB]:{name:'QMS',role:'hub',bridge:hub.a,startBlock:hub.block,provider:hp},
   [SPOKE]:{name:'Base Sepolia',role:'spoke',bridge:spoke.a,startBlock:spoke.block,provider:sp}
  },hubChainId:HUB,key:keys[1],confirmations:0,maxRange:100,store:fileStore(path.join(dir,'relayer.json')),log:()=>{}});
  const deadline=BigInt(Math.floor(Date.now()/1000)+3600);

  // Hub -> Spoke. The real relayer consumes the standard Hub Bridged event.
  const out=tid('qms-hub-to-spoke');
  await (await hc.c.connect(hu).requestGatewayHandoff(out,wrap.a,E('5'),SPOKE,st,sl.a,hba.a)).wait();
  const dispatch=await (await hc.c.connect(hu).initiate(out)).wait();
  const he=event(hub.c,dispatch,'Bridged'), hmid=msgId(HUB,he.args.nonce);
  assert.equal(he.args.recipient.toLowerCase(),sba.a.toLowerCase());
  assert.equal(await relayer.tick(),1);
  assert.equal(await spokeToken.balanceOf(sba.a),E('5'));
  const settlement=await deliveryProof({wallets:[hv],verifier:ssv.a,transferId:out,sourceChainId:HUB,destinationChainId:SPOKE,sourceAsset:wrap.a,recipient:user,destinationAsset:st,destinationLedger:sl.a,amount:E('5'),deadline});
  const wrong=await qmsBridgeDeliveryProof({wallets:[hv],verifier:sbv.a,transferId:out,sourceChainId:HUB,destinationChainId:SPOKE,sourceBridge:hub.a,destinationBridge:spoke.a,sourceAdapter:hba.a,destinationAdapter:sba.a,sourceToken:wrap.a,destinationToken:st,beneficiary:so.address,amount:E('5'),bridgeMessageId:hmid,deadline});
  await rejects(sba.c.proveAndFinalize(out,combineSettlementAndBridgeProof(settlement,wrong)),'reject beneficiary mismatch');
  const bp1=await qmsBridgeDeliveryProof({wallets:[hv],verifier:sbv.a,transferId:out,sourceChainId:HUB,destinationChainId:SPOKE,sourceBridge:hub.a,destinationBridge:spoke.a,sourceAdapter:hba.a,destinationAdapter:sba.a,sourceToken:wrap.a,destinationToken:st,beneficiary:sba.a,amount:E('5'),bridgeMessageId:hmid,deadline});
  const proof1=combineSettlementAndBridgeProof(settlement,bp1);
  await (await sba.c.proveAndFinalize(out,proof1)).wait();
  assert.equal((await sl.c.getBalance(user,st)).available,E('5'));
  await rejects(sba.c.proveAndFinalize(out,proof1),'inbound replay blocked');
  await rejects(spoke.c.connect(sr).mint(HUB,he.args.nonce,sba.a,E('5')),'spoke mint replay blocked');

  // Spoke -> Hub. The real relayer consumes bridgeBackFor's standard Bridged event.
  const back=tid('qms-spoke-to-hub');
  await (await sc.c.connect(su).requestGatewayHandoff(back,st,E('5'),HUB,wrap.a,hl.a,sba.a)).wait();
  const backDispatch=await (await sc.c.connect(su).initiate(back)).wait();
  const se=event(spoke.c,backDispatch,'Bridged'), smid=msgId(SPOKE,se.args.nonce);
  assert.equal(se.args.recipient.toLowerCase(),hba.a.toLowerCase());
  assert.equal(await relayer.tick(),1);
  assert.equal(await wrap.c.balanceOf(hba.a),E('5'));
  const settlement2=await deliveryProof({wallets:[hv],verifier:hsv.a,transferId:back,sourceChainId:SPOKE,destinationChainId:HUB,sourceAsset:st,recipient:user,destinationAsset:wrap.a,destinationLedger:hl.a,amount:E('5'),deadline});
  const bp2=await qmsBridgeDeliveryProof({wallets:[hv],verifier:hbv.a,transferId:back,sourceChainId:SPOKE,destinationChainId:HUB,sourceBridge:spoke.a,destinationBridge:hub.a,sourceAdapter:sba.a,destinationAdapter:hba.a,sourceToken:st,destinationToken:wrap.a,beneficiary:hba.a,amount:E('5'),bridgeMessageId:smid,deadline});
  const proof2=combineSettlementAndBridgeProof(settlement2,bp2);
  await (await hba.c.proveAndFinalize(back,proof2)).wait();
  assert.equal((await hl.c.getBalance(user,wrap.a)).available,E('7'));
  await rejects(hba.c.proveAndFinalize(back,proof2),'reverse replay blocked');

  // Pre-dispatch cancellation restores only the still-reserved balance.
  const cancel=tid('qms-pre-dispatch-cancel');
  await (await hc.c.connect(hu).requestGatewayHandoff(cancel,wrap.a,E('1'),SPOKE,st,sl.a,hba.a)).wait();
  const cp=await cancellationProof({wallets:[hv],verifier:hsv.a,transferId:cancel,sourceChainId:HUB,deadline});
  await (await hba.c.cancelOrRecover(cancel,cp)).wait();
  assert.equal((await hl.c.getBalance(user,wrap.a)).available,E('7'));

  // Post-dispatch recovery is blocked until the exact wQMS has returned to adapter custody.
  const recovery=tid('qms-post-dispatch-recovery');
  await (await hc.c.connect(hu).requestGatewayHandoff(recovery,wrap.a,E('2'),SPOKE,st,sl.a,hba.a)).wait();
  await (await hc.c.connect(hu).initiate(recovery)).wait();
  const rp=await recoveryProof({wallets:[hv],verifier:hsv.a,transferId:recovery,sourceChainId:HUB,sourceAsset:wrap.a,amount:E('2'),deadline});
  await rejects(hba.c.cancelOrRecover(recovery,rp),'proof alone cannot fabricate returned wQMS');
  // Simulates the bridge's authenticated return leg by placing the exact asset in adapter custody.
  await (await wrap.c.connect(ho).deposit({value:E('2')})).wait();
  await (await wrap.c.connect(ho).transfer(hba.a,E('2'))).wait();
  await (await hba.c.cancelOrRecover(recovery,rp)).wait();
  assert.equal((await hl.c.getBalance(user,wrap.a)).available,E('7'));
  assert.equal(await relayer.tick(),0);
  console.log('QMS Gateway adapter: Hub->Spoke, Spoke->Hub, production relayer, dual proofs, replay, cancellation and token-backed recovery scenarios passed');
 } finally {
  if(started) await Promise.allSettled([hs.close(),ss.close()]);
  fs.rmSync(dir,{recursive:true,force:true});
 }
})().catch(e=>{console.error('QMS Gateway adapter integration failed:',e);process.exitCode=1;});
