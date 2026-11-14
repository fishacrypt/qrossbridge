'use strict';
/* QROS Bridge: Home and Activity views. Only real data from config, chains and this wallet's own history. */

let currentView='home';
function selectRoute(fromId,toId){
  S.from={chainId:fromId,token:ZERO};S.to={chainId:toId,token:ZERO};
  fixTokens();afterChange();
}
function refreshViews(){
  if(currentView==='activity')renderActList();
  if(S.openEntry)renderEntryDialog();
}

/* ---------- shared: transfer card ---------- */
function entryCard(x){
  const sc=chainOf(x.fromId),dc=chainOf(x.toId);
  const li=txUrl(sc,x.txIn),lo=txUrl(dc,x.txOut);
  return h('div',{class:'hi'},
    h('div',{class:'t'},h('span',{},x.amtIn+' '+x.sym+' → '+x.amtOut+' '+x.outSym),h('span',{class:'stat '+x.status},statusText(x))),
    h('div',{class:'m'},h('span',{},x.from+' → '+x.to),h('span',{class:'tnum'},new Date(x.ts).toLocaleString()),
      li?h('a',{href:li,target:'_blank',rel:'noopener'},'Source tx'):null,lo?h('a',{href:lo,target:'_blank',rel:'noopener'},'Delivery tx'):null,
      h('button',{class:'mini',style:'margin-left:auto',onclick:()=>openEntry(x)},'Details')));
}
function connectEmpty(text){
  return h('div',{class:'empty'},h('b',{},'Connect your wallet'),text,h('div',{style:'margin-top:14px'},h('button',{class:'btn solid',onclick:connect},'Connect wallet')));
}

/* ---------- home ---------- */
function renderHome(){
  // The overview is intentionally focused on the protocol introduction.
  // Transfer activity and network details live on their dedicated pages.
}

/* ---------- activity ---------- */
const ACT={status:'all',net:'all',q:''};
const STATUS_FILTERS=[['all','All statuses'],['active','In progress'],['success','Complete'],['delayed','Delayed'],['failure','Failed']];
function renderActivity(){
  const body=$('actBody');
  if(!S.account){body.replaceChildren(connectEmpty('Activity is tied to your wallet address. Connect to see your transfers.'));return}
  const sel=(opts,val,on,label)=>{const s=h('select',{'aria-label':label,onchange:e=>on(e.target.value)},opts.map(([v,l])=>h('option',{value:v,...(v===String(val)?{selected:true}:{})},l)));return s};
  const nets=[['all','All networks'],...[QMS.id,...Object.keys(BRIDGE.spokes||{}).map(Number)].map(id=>[String(id),(chainOf(id)||{}).name||id])];
  const q=h('input',{type:'search',placeholder:'Search by transaction or transfer ID',value:ACT.q,'aria-label':'Search transfers',oninput:e=>{ACT.q=e.target.value.trim().toLowerCase();renderActList()}});
  // track by hash
  const lkChain=h('select',{'aria-label':'Network of the transaction'},nets.slice(1).map(([v,l])=>h('option',{value:v},l)));
  const lkHash=h('input',{type:'text',placeholder:'0x… source transaction hash',spellcheck:'false','aria-label':'Transaction hash',style:'flex:1;min-width:200px;background:var(--box);border:1px solid var(--line);border-radius:12px;padding:0 12px;min-height:40px;color:var(--text);font-family:var(--mono);font-size:13px'});
  const lkMsg=h('div',{class:'msg'});
  const lkBtn=h('button',{class:'btn sm',onclick:async()=>{
    lkMsg.className='msg';lkBtn.disabled=true;
    try{const e=await lookupTx(Number(lkChain.value),lkHash.value.trim());lkHash.value='';renderActList();openEntry(e)}
    catch(err){lkMsg.className='msg show err';lkMsg.textContent=err.message||'Lookup failed'}
    lkBtn.disabled=false;
  }},'Track');
  const lookup=h('details',{class:'card flat',style:'margin-bottom:14px'},h('summary',{style:'cursor:pointer;font-weight:600;min-height:32px'},'Track a transfer by transaction hash'),
    h('p',{class:'muted',style:'font-size:13px;margin:8px 0 10px'},'Sent from another browser? Paste the source transaction hash. Only transfers sent by your connected wallet can be added.'),
    h('div',{class:'filters',style:'margin-bottom:0'},lkChain,lkHash,lkBtn),lkMsg);
  body.replaceChildren(
    h('div',{class:'filters'},
      sel(STATUS_FILTERS,ACT.status,v=>{ACT.status=v;renderActList()},'Filter by status'),
      sel(nets,ACT.net,v=>{ACT.net=v;renderActList()},'Filter by network'),q),
    lookup,h('div',{class:'hist',id:'actList'}));
  renderActList();
}
function filterEntries(){
  return myEntries().filter(x=>{
    if(ACT.status==='active'&&isFinal(x))return false;
    if(ACT.status==='success'&&x.status!=='success')return false;
    if(ACT.status==='delayed'&&x.status!=='delayed')return false;
    if(ACT.status==='failure'&&x.status!=='failure'&&x.status!=='refund')return false;
    if(ACT.net!=='all'&&String(x.fromId)!==ACT.net&&String(x.toId)!==ACT.net)return false;
    if(ACT.q&&!((x.txIn||'')+(x.txOut||'')+(x.id||'')).toLowerCase().includes(ACT.q))return false;
    return true;
  });
}
function renderActList(){
  const el=$('actList');if(!el)return;
  if(!S.account){renderActivity();return}
  const all=myEntries(),list=filterEntries();
  el.replaceChildren(...(list.length?list.map(entryCard):[h('div',{class:'empty'},
    h('b',{},all.length?'No transfers match these filters':'No transfers yet'),
    all.length?'Try clearing the filters.':'Transfers started from this browser with your wallet appear here and keep updating.',
    all.length?null:h('div',{style:'margin-top:14px'},h('a',{class:'btn solid',href:'#/bridge'},'Start a transfer')))]));
}

/* ---------- transfer detail ---------- */
function openEntry(x){S.openEntry=x.txIn||x.id;renderEntryDialog()}
function renderEntryDialog(){
  const x=findEntry(S.openEntry);if(!x){S.openEntry=null;return}
  const sc=chainOf(x.fromId),dc=chainOf(x.toId);
  const kv=(a,b)=>b?h('div',{class:'kv'},h('span',{},a),h('span',{},b)):null;
  const link=(u,t)=>u?h('a',{href:u,target:'_blank',rel:'noopener'},t):null;
  const body=h('div',{},
    h('div',{class:'row',style:'margin-bottom:10px'},h('b',{style:'font-size:17px'},x.amtIn+' '+x.sym+' → '+x.amtOut+' '+x.outSym),h('span',{class:'stat '+x.status},statusText(x))),
    h('div',{class:'prog',style:'margin:0 0 12px'},...entrySteps(x).map(stepEl)),
    kv('From',x.from),kv('To',x.to),
    kv('Recipient',x.recipient?h('span',{class:'addr'},x.recipient):null),
    kv('Started',new Date(x.ts).toLocaleString()),
    kv('Delivery time',x.took?dur(x.took):null),
    kv('Source transaction',link(txUrl(sc,x.txIn),short(x.txIn))),
    kv('Delivery transaction',link(txUrl(dc,x.txOut),short(x.txOut))),
    kv('Transfer ID',x.id&&x.id!==x.txIn?h('button',{class:'mini',onclick:()=>copyText(x.id,'Transfer ID copied')},short(x.id),ico('copy')):null),
    x.err?h('div',{class:'msg show err'},x.err):null);
  $('dlgTitle').textContent='Transfer details';
  $('dlgBody').replaceChildren(body);
  if(!$('dlg').open)$('dlg').showModal();
}
