'use strict';
/* QROS Bridge: transfer tracking. Persisted history, stage detection from receipts and contract state,
   timeline rendering, tx lookup and claimable balances. Nothing here is simulated. */

const HKEY='tetrixbridge.history.v1';
const DELAY_MS=3*60*1000; // after this long without delivery, a transfer is shown as delayed
const STATUS_TXT={waiting:'Waiting for deposit',depositing:'Depositing',pending:'In transit',submitted:'Fill submitted',success:'Complete',delayed:'Delayed',refund:'Refunded',failure:'Failed'};
const isFinal=x=>x.status==='success'||x.status==='failure'||x.status==='refund';
const statusText=x=>x.own&&x.status==='pending'&&!x.srcOk?'Confirming':(STATUS_TXT[x.status]||x.status);

/* ---------- history store ---------- */
function saveHistory(){LS.set(HKEY,S.history.slice(0,60))}
const findEntry=k=>S.history.find(x=>x.id===k||x.txIn===k);
function upsertHistory(e){
  const i=S.history.findIndex(x=>(e.id&&x.id===e.id)||(e.txIn&&x.txIn===e.txIn));
  let entry;
  if(i>=0){entry=Object.assign(S.history[i],e)}else{entry=e;S.history.unshift(e)}
  saveHistory();onEntryUpdate(entry);
  return entry;
}
/* entries that belong to the connected wallet (lowercase compare). Legacy entries without an owner are backfilled from chain data. */
function myEntries(){
  if(!S.account)return[];
  const a=S.account.toLowerCase();
  return S.history.filter(x=>x.account&&x.account===a);
}
async function backfillAccount(x){
  if(x.account||x.acctTried||!x.txIn)return;
  x.acctTried=true;
  try{
    const tx=await rpc(chainOf(x.fromId),'eth_getTransactionByHash',[x.txIn]);
    if(tx&&tx.from)x.account=tx.from.toLowerCase();
  }catch{x.acctTried=false}
}

/* ---------- per-entry checks ---------- */
async function checkOwn(x){
  const sc=chainOf(x.fromId),dc=chainOf(x.toId);
  if(!sc||!dc)return;
  if(!x.srcOk){
    let rc=null;
    try{rc=await rpc(sc,'eth_getTransactionReceipt',[x.txIn])}catch{return}
    // a public RPC can lag behind the wallet's own node: ask the wallet too when it is on the source chain
    if(!rc&&S.provider&&S.walletChain===x.fromId){try{rc=await S.provider.request({method:'eth_getTransactionReceipt',params:[x.txIn]})}catch{}}
    if(!rc){
      let tx=null;try{tx=await rpc(sc,'eth_getTransactionByHash',[x.txIn])}catch{return}
      if(!tx&&Date.now()-x.ts>10*60*1000){x.status='failure';x.stage='failed';x.err='Transaction not found on '+sc.name+'. It may have been dropped or replaced.'}
      else x.stage='submitted';
      return;
    }
    if(rc.status==='0x0'){x.status='failure';x.stage='failed';x.err='Transaction reverted on '+sc.name;return}
    const bridge=String(bridgeAt(x.fromId)).toLowerCase();
    const log=(rc.logs||[]).find(l=>l.address.toLowerCase()===bridge&&l.topics[0]===TOPIC.bridged);
    if(!log){x.status='failure';x.stage='failed';x.err='The transaction succeeded but emitted no bridge transfer.';return}
    x.id=log.topics[1];x.srcOk=true;x.srcBlock=parseInt(rc.blockNumber,16);
    x.account=x.account||('0x'+log.topics[3].slice(26)).toLowerCase();
    try{const b=await rpc(sc,'eth_getBlockByNumber',[rc.blockNumber,false]);x.srcTs=parseInt(b.timestamp,16)*1000}catch{}
  }
  try{x.conf=parseInt(await rpc(sc,'eth_blockNumber'),16)-x.srcBlock+1}catch{}
  const dest=bridgeAt(x.toId);
  let done=false;
  try{done=BigInt(await rpc(dc,'eth_call',[{to:dest,data:SEL.processed+x.id.slice(2)},'latest']))===1n}catch{x.rpcErr=true;return}
  x.rpcErr=false;
  if(done){
    x.status='success';x.stage='delivered';
    if(!x.txOut&&!x.outTried){
      x.outTried=true;
      try{
        const head=parseInt(await rpc(dc,'eth_blockNumber'),16);
        const from=x.destFrom!=null?x.destFrom:Math.max(0,head-10000);
        const ls=await rpc(dc,'eth_getLogs',[{address:dest,topics:[TOPIC.delivered,x.id],fromBlock:toHex(from),toBlock:'latest'}]);
        if(ls&&ls[0]){
          x.txOut=ls[0].transactionHash;
          try{const b=await rpc(dc,'eth_getBlockByNumber',[ls[0].blockNumber,false]);x.doneAt=parseInt(b.timestamp,16)*1000}catch{}
          try{const r2=await rpc(dc,'eth_getTransactionReceipt',[x.txOut]);x.claimable=!!(r2&&(r2.logs||[]).some(l=>l.topics[0]===TOPIC.claimableCredited))}catch{}
        }
      }catch{}
    }
    if(!x.doneAt)x.doneAt=Date.now();
    x.took=Math.max(0,x.doneAt-(x.srcTs||x.ts));
    return;
  }
  x.stage='delivering';
  x.status=Date.now()-(x.srcTs||x.ts)>DELAY_MS?'delayed':'pending';
}
async function checkRelay(x){
  try{
    const st=await getStatus('/intents/status/v3?requestId='+x.id);
    if(st&&st.status&&st.status!==x.status){x.status=st.status;if(st.txHashes&&st.txHashes[0])x.txOut=st.txHashes[0]}
  }catch{}
}
async function refreshEntry(x){
  try{x.own?await checkOwn(x):await checkRelay(x)}catch{}
  saveHistory();onEntryUpdate(x);
}
let tracking=false;
async function trackAll(){
  if(tracking)return;tracking=true;
  try{
    for(const x of S.history.slice()){
      if(!x.account)await backfillAccount(x);
      if(!isFinal(x)&&(x.txIn||x.id))await refreshEntry(x);
    }
    saveHistory();
  }finally{tracking=false}
  if(typeof refreshViews==='function')refreshViews();
}
setInterval(()=>{if(!document.hidden&&S.history.some(x=>!isFinal(x)))trackAll()},4000);

function onEntryUpdate(x){
  if(S.liveEntry&&(x.id===S.liveEntry||x.txIn===S.liveEntry)&&typeof drawProgress==='function')drawProgress();
  if(typeof refreshViews==='function')refreshViews();
}

/* ---------- timeline ---------- */
function timelineSteps(x){
  const sc=chainOf(x.fromId),dc=chainOf(x.toId);
  const when=ts=>new Date(ts).toLocaleTimeString();
  const s=[];
  s.push({label:'Transaction submitted',state:x.txIn?'done':'active',
    detail:x.txIn?short(x.txIn)+' · '+when(x.ts):'Waiting for your wallet',link:txUrl(sc,x.txIn)});
  if(x.stage==='failed'&&!x.srcOk)s.push({label:'Confirmed on '+sc.name,state:'error',detail:x.err||'Failed'});
  else s.push({label:'Confirmed on '+sc.name,state:x.srcOk?'done':x.txIn?'active':'todo',
    detail:x.srcOk?'Block '+x.srcBlock+(x.srcTs?' · '+when(x.srcTs):'')+(x.conf&&x.status!=='success'?' · '+x.conf+' confirmation'+(x.conf===1?'':'s'):''):x.txIn?'Waiting for the network to include it':undefined});
  const label='Funds arrive on '+dc.name;
  if(x.status==='success'){
    s.push({label,state:x.claimable?'warn':'done',
      detail:x.claimable?'Delivered, but the recipient could not accept native QMS, so it is held for claiming. Claim it from the connected recipient wallet.'
        :'Received ~'+x.amtOut+' '+x.outSym+(x.took?' · took '+dur(x.took):''),
      link:txUrl(dc,x.txOut),
      acts:x.claimable&&S.account&&S.account.toLowerCase()===String(x.recipient||x.account).toLowerCase()?[h('button',{class:'mini',onclick:doClaim},'Claim QMS')]:undefined});
  }else if(x.srcOk){
    const el=dur(Date.now()-(x.srcTs||x.ts));
    const delayed=x.status==='delayed';
    s.push({label,state:delayed?'warn':'active',
      detail:(x.rpcErr?'Could not reach '+dc.name+' to check. Retrying. ':'')+(delayed
        ?'Taking longer than usual ('+el+'). The relayer may be busy or low on gas. Your funds are held by the bridge contract and will be delivered when it catches up.'
        :'Waiting for the relayer to deliver · '+el),
      acts:[h('button',{class:'mini',onclick:()=>{const e=findEntry(x.txIn||x.id);if(e)refreshEntry(e).then(()=>toast(isFinal(e)?'Transfer complete':'Still in transit'))}},'Check again')]});
  }else if(x.stage==='failed')s.push({label,state:'todo'});
  else s.push({label,state:'todo'});
  return s;
}
function relaySteps(x){
  const sc=chainOf(x.fromId),dc=chainOf(x.toId);
  const bad=x.status==='failure'||x.status==='refund';
  return[
    {label:'Transaction submitted',state:'done',detail:x.txIn?short(x.txIn)+' · '+new Date(x.ts).toLocaleTimeString():undefined,link:txUrl(sc,x.txIn)},
    {label:'Funds arrive on '+dc.name,state:x.status==='success'?'done':bad?'error':'active',
      detail:x.status==='success'?'Received ~'+x.amtOut+' '+x.outSym:(STATUS_TXT[x.status]||x.status),link:txUrl(dc,x.txOut)}
  ];
}
const entrySteps=x=>x.own?timelineSteps(x):relaySteps(x);
function stepEl(s){
  return h('div',{class:'st '+s.state},
    h('span',{class:'dot'},s.state==='done'?ico('check'):s.state==='error'||s.state==='warn'?'!':''),
    h('div',{},s.label,
      s.detail?h('small',{class:'tsm'},s.detail):null,
      s.link?h('small',{},h('a',{href:s.link,target:'_blank',rel:'noopener'},'View on explorer')):null,
      s.acts?h('div',{class:'acts'},...s.acts):null));
}

/* ---------- look up a transfer by source transaction hash ---------- */
async function lookupTx(chainId,hash){
  const c=chainOf(chainId),bridge=bridgeAt(chainId);
  if(!c||!bridge)throw new Error('That network is not part of the QMS bridge.');
  if(!isHash(hash))throw new Error('Enter a full 66-character transaction hash.');
  const ex=findEntry(hash);
  const rc=await rpc(c,'eth_getTransactionReceipt',[hash]);
  if(!rc)throw new Error('Transaction not found on '+c.name+' yet.');
  const log=(rc.logs||[]).find(l=>l.address.toLowerCase()===bridge.toLowerCase()&&l.topics[0]===TOPIC.bridged);
  if(!log)throw new Error('No QMS bridge transfer in this transaction.');
  const sender=('0x'+log.topics[3].slice(26)).toLowerCase();
  if(!S.account||sender!==S.account.toLowerCase())throw new Error('This transfer was sent by a different wallet, so it is not shown here.');
  if(ex)return ex;
  const d=log.data.slice(2),w=i=>d.slice(i*64,(i+1)*64);
  const recipient='0x'+w(0).slice(24),amount=BigInt('0x'+w(1)),asNative=BigInt('0x'+w(3))===1n;
  const toId=chainId===QMS.id?Number(BigInt(log.topics[2])):QMS.id;
  const tx=await rpc(c,'eth_getTransactionByHash',[hash]).catch(()=>null);
  const viaWqms=!!(tx&&String(tx.input).startsWith(SEL.depositWQMS));
  const sym=chainId===QMS.id?(viaWqms?'WQMS':'QMS'):'wQMS';
  const outSym=chainId===QMS.id?'wQMS':(asNative?'QMS':'WQMS');
  let ts=Date.now();
  try{const b=await rpc(c,'eth_getBlockByNumber',[rc.blockNumber,false]);ts=parseInt(b.timestamp,16)*1000}catch{}
  const f=fmt(formatUnits(amount,18),8);
  const entry=upsertHistory({id:log.topics[1],own:true,ts,from:c.name,to:(chainOf(toId)||{}).name||String(toId),fromId:chainId,toId,sym,outSym,amtIn:f,amtOut:f,
    status:'pending',txIn:hash,account:sender,recipient});
  trackAll();
  return entry;
}

/* ---------- claimable QMS on the hub (when a recipient could not accept native QMS) ---------- */
S.claimable=0n;
async function loadClaimable(){
  if(!S.account||!bridgeReady()){S.claimable=0n;renderClaim();return}
  try{S.claimable=BigInt(await rpc(chainOf(QMS.id),'eth_call',[{to:BRIDGE.hub.address,data:SEL.claimable+encA(S.account)},'latest'])||'0x0')}
  catch{S.claimable=0n}
  renderClaim();
}
function renderClaim(){
  for(const id of['claimBanner','claimBanner2']){
    const el=$(id);if(!el)continue;
    if(!(S.claimable>0n)){el.hidden=true;continue}
    el.hidden=false;
    el.replaceChildren(
      h('b',{},fmt(formatUnits(S.claimable,18),8)+' QMS is waiting for you to claim on QMS Testnet.'),
      h('div',{style:'margin-top:4px;color:var(--mut)'},'A delivery could not be pushed to your address, so the bridge holds it for you.'),
      h('div',{class:'acts'},h('button',{class:'btn sm solid',id:id+'Go',onclick:doClaim},'Claim now')));
  }
}
async function doClaim(){
  if(!S.provider||!S.account){connect();return}
  try{
    await ensureChain(QMS.id);
    const hash=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:BRIDGE.hub.address,data:SEL.claim,value:'0x0'}]});
    toast('Claim submitted');
    await waitReceipt(hash,QMS.id);
    toast('Claimed');
  }catch(e){const er=walletError(e,chainOf(QMS.id));toast(er.text)}
  loadClaimable();refreshBalances();
}
function onAccountChange(){loadClaimable();if(typeof refreshViews==='function')refreshViews();trackAll()}
