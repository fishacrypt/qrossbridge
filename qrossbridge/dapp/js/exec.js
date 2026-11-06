'use strict';
/* QROS Bridge: transaction execution and live progress.
   doBridgeOwn builds the exact same calldata as before (deposit / depositWQMS / bridgeBack); only the
   progress and tracking around it changed. */

let steps=[];
S.liveEntry=null;S.progTitle='';S.tail=[];

function drawProgress(title){
  if(title!==undefined)S.progTitle=title;
  const p=$('prog');p.hidden=false;
  let list=steps.slice();
  const x=S.liveEntry?findEntry(S.liveEntry):null;
  if(x)list=list.concat(entrySteps(x));else list=list.concat(S.tail);
  const kids=[h('h4',{},S.progTitle||'Progress'),...list.map(stepEl)];
  if(x&&isFinal(x)||S.showNew){
    kids.push(h('div',{class:'acts',style:'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px'},
      h('button',{class:'mini',onclick:resetBridge},'New bridge'),
      h('a',{class:'mini',href:'#/activity'},'View in Activity')));
  }
  p.replaceChildren(...kids);
}
function mark(i,state,detail,link){const s=steps[i];if(!s)return;s.state=state;if(detail!==undefined)s.detail=detail;if(link!==undefined)s.link=link;drawProgress()}
function resetBridge(){
  $('prog').hidden=true;S.liveEntry=null;S.showNew=false;S.tail=[];
  S.amount='';$('amt').value='';S.q={state:'idle'};renderQuote();
}
const STEP_LABEL={approve:'Approve token',deposit:'Confirm bridge in wallet',swap:'Confirm in wallet',send:'Confirm in wallet',authorize:'Sign authorization',authorize1:'Sign authorization',authorize2:'Sign authorization'};

async function waitReceipt(hash,chainId){
  for(let i=0;i<90;i++){
    let r=null;
    try{r=await S.provider.request({method:'eth_getTransactionReceipt',params:[hash]})}catch{}
    if(!r){try{r=await rpc(chainOf(chainId),'eth_getTransactionReceipt',[hash])}catch{}}
    if(r){if(r.status==='0x0')throw new Error('Transaction reverted on '+chainOf(chainId).name);return r}
    await sleep(2000);
  }
  throw new Error('Timed out waiting for confirmation');
}
async function getStatus(endpoint){
  const r=await fetch(endpoint.startsWith('http')?endpoint:CFG.api+endpoint);
  if(!r.ok)throw new Error('HTTP '+r.status);
  return r.json();
}
async function pollStatus(endpoint,onTick){
  for(let i=0;i<150;i++){
    let st=null;
    try{st=await getStatus(endpoint)}catch{}
    if(st){
      onTick&&onTick(st);
      if(st.status==='success')return st;
      if(st.status==='failure'||st.status==='refund')throw Object.assign(new Error('Bridge reported: '+(STATUS_TXT[st.status]||st.status)),{status:st});
    }
    await sleep(2000);
  }
  throw new Error('Still processing after 5 minutes. Check Activity for updates.');
}
function typedData(sg){
  const dom=sg.domain||{},types={...(sg.types||{})};
  if(!types.EIP712Domain){
    const f=[['name','string'],['version','string'],['chainId','uint256'],['verifyingContract','address'],['salt','bytes32']];
    types.EIP712Domain=f.filter(x=>dom[x[0]]!==undefined).map(x=>({name:x[0],type:x[1]}));
  }
  return JSON.stringify({domain:dom,types,primaryType:sg.primaryType,message:sg.value});
}

/* ---------- QMS <-> network (own contracts) ---------- */
async function doBridgeOwn(){
  if(S.busy)return;
  const ft=fromTok(),tt=toTok(),fc=fromChain(),tc=toChain();
  const wei=parseUnits(S.amount,ft.decimals);
  const recip=S.useRecipient&&isAddr(S.recipient)?S.recipient:S.account;
  const toQms=tc.id===QMS.id;
  const bridge=toQms?BRIDGE.spokes[fc.id].bridge:BRIDGE.hub.address;
  const needApprove=!toQms&&!ft.native; // depositing WQMS needs an allowance
  const amtIn=S.amount,amtOut=fmt(S.q.out,8);

  // duplicate-submission guard: same wallet, route, amount and recipient still in flight
  const dupKey=[S.account,fc.id,tc.id,ft.address,wei,recip].join('|').toLowerCase();
  const dup=S.history.find(x=>x.dupKey===dupKey&&!isFinal(x)&&Date.now()-x.ts<10*60*1000);
  if(dup&&!(await confirmDialog('Send the same transfer again?','An identical transfer ('+amtIn+' '+ft.symbol+' to '+tc.name+') is still in progress. Sending again creates a second, separate transfer.','Send again')))return;

  S.busy=true;renderPrimary();
  steps=[];S.liveEntry=null;S.showNew=false;
  if(needApprove)steps.push({label:'Approve WQMS',state:'todo'});
  steps.push({label:'Confirm bridge in wallet',state:'todo'});
  S.tail=[{label:'Confirmed on '+fc.name,state:'todo'},{label:'Funds arrive on '+tc.name,state:'todo'}];
  drawProgress('Bridging '+amtIn+' '+ft.symbol+' → '+tt.symbol);
  let cur=0;
  try{
    await ensureChain(fc.id);
    if(needApprove){
      mark(0,'active');
      const al=BigInt(await rpc(fc,'eth_call',[{to:ft.address,data:SEL.allowance+encA(S.account)+encA(bridge)},'latest'])||'0x0');
      if(al<wei){
        const ah=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:ft.address,data:SEL.approve+encA(bridge)+encU(wei),value:'0x0'}]});
        mark(0,'active','Submitted '+short(ah),txUrl(fc,ah));
        await waitReceipt(ah,fc.id);
      }
      mark(0,'done');cur=1;
    }
    mark(cur,'active');
    let data,value='0x0';
    if(toQms)data=SEL.bridgeBack+encU(wei)+encA(recip)+encB(tt.native);
    else if(ft.native){data=SEL.depositNative+encU(tc.id)+encA(recip);value=toHex(wei)}
    else data=SEL.depositWQMS+encU(wei)+encU(tc.id)+encA(recip);
    let destFrom=null;try{destFrom=Math.max(0,parseInt(await rpc(tc,'eth_blockNumber'),16)-5)}catch{}
    const hash=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:bridge,data,value}]});
    // persist immediately so a refresh cannot lose track of the transfer
    const entry=upsertHistory({id:hash,own:true,ts:Date.now(),from:fc.name,to:tc.name,fromId:fc.id,toId:tc.id,sym:ft.symbol,outSym:tt.symbol,amtIn,amtOut,
      status:'pending',stage:'submitted',txIn:hash,account:S.account.toLowerCase(),recipient:recip,dupKey,destFrom});
    steps.pop();S.liveEntry=hash;S.tail=[];drawProgress();
    // hold the form until the source chain has confirmed and the transfer id is known
    for(let i=0;i<120&&!entry.srcOk&&entry.status!=='failure';i++){await refreshEntry(entry);if(!entry.srcOk&&entry.status!=='failure')await sleep(2000)}
    if(entry.status==='failure')throw new Error(entry.err||'Transaction failed');
    if(!entry.srcOk)throw Object.assign(new Error('Still waiting for confirmation on '+fc.name+'. It is saved in Activity and keeps updating.'),{soft:true});
    S.busy=false;renderPrimary();refreshBalances();
    // keep watching delivery in the background (also resumed after a page refresh)
    (async()=>{
      for(let i=0;i<450&&!isFinal(entry);i++){await sleep(2000);await refreshEntry(entry)}
      if(entry.status==='success'){toast('Bridge complete');refreshBalances()}
    })();
  }catch(e){
    if(S.liveEntry){ // already submitted: the timeline shows the real state (failed or still confirming)
      if(e&&e.soft)toast(e.message);
      S.showNew=true;drawProgress();
    }else{
      const er=walletError(e,fc);
      mark(cur,'error',er.text);S.showNew=true;drawProgress();
    }
  }finally{
    S.busy=false;renderPrimary();refreshBalances();
  }
}

/* ---------- other supported network routes (quote + execution via the route backend) ---------- */
async function doBridge(){
  if(S.q.own)return doBridgeOwn();
  const q=S.q.quote;if(!q||S.busy)return;
  if(S.q.at&&Date.now()-S.q.at>90000){scheduleQuote();toast('Quote expired. Refreshed, review it and confirm again.');return}
  const ft=fromTok(),tt=toTok(),fc=fromChain(),tc=toChain();
  const amtIn=S.amount,amtOut=fmt(outAmount(q),8);
  S.busy=true;renderPrimary();
  S.liveEntry=null;S.tail=[];S.showNew=false;
  steps=q.steps.map(s=>({label:STEP_LABEL[s.id]||s.description||s.id,state:'todo'}));
  steps.push({label:'Funds arrive on '+tc.name,state:'todo'});
  drawProgress('Bridging '+amtIn+' '+ft.symbol+' → '+tt.symbol);
  let requestId=null,originHash=null,final=null,cur=0;
  try{
    for(let si=0;si<q.steps.length;si++){
      cur=si;const step=q.steps[si];mark(si,'active');
      if(step.requestId)requestId=step.requestId;
      for(const item of step.items||[]){
        if(item.status==='complete')continue;
        if(step.kind==='transaction'){
          const d=item.data,cid=Number(d.chainId);
          await ensureChain(cid);
          const tx={from:S.account,to:d.to,data:d.data||'0x',value:toHex(d.value||'0')};
          if(d.maxFeePerGas)tx.maxFeePerGas=toHex(d.maxFeePerGas);
          if(d.maxPriorityFeePerGas)tx.maxPriorityFeePerGas=toHex(d.maxPriorityFeePerGas);
          const hash=await S.provider.request({method:'eth_sendTransaction',params:[tx]});
          mark(si,'active','Submitted '+short(hash),txUrl(chainOf(cid),hash));
          await waitReceipt(hash,cid);
          originHash=hash;
          if(requestId)upsertHistory({id:requestId,ts:Date.now(),from:fc.name,to:tc.name,fromId:fc.id,toId:tc.id,sym:ft.symbol,outSym:tt.symbol,amtIn,amtOut,status:'pending',txIn:hash,account:S.account.toLowerCase()});
        }else if(step.kind==='signature'){
          const sg=item.data.sign,post=item.data.post;
          if(sg.chainId)await ensureChain(Number(sg.chainId));
          const sig=sg.signatureKind==='eip191'
            ?await S.provider.request({method:'personal_sign',params:[sg.message,S.account]})
            :await S.provider.request({method:'eth_signTypedData_v4',params:[S.account,typedData(sg)]});
          if(post){
            const sep=post.endpoint.includes('?')?'&':'?';
            const r=await fetch(CFG.api+post.endpoint+sep+'signature='+sig,{method:post.method||'POST',headers:{'content-type':'application/json'},body:post.body?JSON.stringify(post.body):undefined});
            if(!r.ok)throw new Error('Signature rejected (HTTP '+r.status+')');
          }
        }
        if(item.check&&item.check.endpoint){
          final=await pollStatus(item.check.endpoint,st=>mark(si,'active',STATUS_TXT[st.status]||st.status));
        }
      }
      mark(si,'done');
    }
    cur=steps.length-1;mark(cur,'active','Waiting for fill');
    if(!final&&requestId)final=await pollStatus('/intents/status/v3?requestId='+requestId,st=>mark(cur,'active',STATUS_TXT[st.status]||st.status));
    const outHash=final&&(final.txHashes||[])[0];
    mark(cur,'done','Received ~'+amtOut+' '+tt.symbol,outHash?txUrl(tc,outHash):undefined);
    if(requestId)upsertHistory({id:requestId,status:'success',txOut:outHash||null});
    toast('Bridge complete');
    S.showNew=true;drawProgress();
  }catch(e){
    const er=walletError(e,fc);
    mark(cur,'error',er.text);
    if(requestId&&!er.rejected)upsertHistory({id:requestId,status:(e&&e.status&&e.status.status)||'failure'});
    S.showNew=true;drawProgress();
  }finally{
    S.busy=false;renderPrimary();refreshBalances();
  }
}
