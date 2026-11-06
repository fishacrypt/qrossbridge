'use strict';
/* QROS Bridge: bridge form. Quotes, fee breakdown, rendering and pickers. */

/* ---------- live route info (limits + pause state, read from the contracts) ---------- */
async function loadBridgeInfo(chainId){
  const c=chainOf(chainId),addr=bridgeAt(chainId);
  if(!c||!addr)return null;
  const call=data=>rpc(c,'eth_call',[{to:addr,data},'latest']);
  const [mn,mx,ps]=await Promise.all([call(SEL.minAmount),call(SEL.maxAmount),call(SEL.paused).catch(()=>null)]);
  const info={min:BigInt(mn),max:BigInt(mx),paused:ps?BigInt(ps)===1n:false,at:Date.now()};
  S.info[chainId]=info;
  return info;
}
async function refreshRouteInfo(){
  if(routeKind()!=='own'){renderRouteInfo();return}
  const ids=[S.from.chainId,S.to.chainId];
  await Promise.all(ids.map(id=>loadBridgeInfo(id).catch(()=>null)));
  renderRouteInfo();
}
async function refreshGas(){
  if(!S.account)return;
  const c=fromChain();
  try{S.gasBal=S.gasBal||{};S.gasBal[c.id]=BigInt(await rpc(c,'eth_getBalance',[S.account,'latest']));renderQuote()}catch{}
}

/* ---------- quotes ---------- */
let qTimer=null,qRefresh=null;
function scheduleQuote(){
  clearTimeout(qTimer);clearTimeout(qRefresh);
  S.quoteSeq++;
  const f=fromTok(),kind=routeKind();
  if(kind==='blocked'){
    S.q={state:'unavailable',msg:bridgeReady()?'QMS bridging is available with Base Sepolia, Arbitrum Sepolia and OP Sepolia.':"QMS bridging is not available yet."};
    renderQuote();return;
  }
  const wei=S.amount?parseUnits(S.amount,f.decimals):null;
  if(!wei||wei===0n){S.q={state:'idle'};renderQuote();return}
  if(S.useRecipient&&S.recipient&&!isAddr(S.recipient)){S.q={state:'idle'};renderQuote();return}
  S.q={state:'loading'};renderQuote();
  const seq=S.quoteSeq;
  qTimer=setTimeout(()=>kind==='own'?runOwnQuote(seq,wei):runQuote(seq,wei),kind==='own'?250:450);
}
function ownCallData(wei){
  const tc=toChain(),ft=fromTok(),tt=toTok(),toQms=tc.id===QMS.id;
  const recip=S.useRecipient&&isAddr(S.recipient)?S.recipient:(S.account||DEAD);
  if(toQms)return{data:SEL.bridgeBack+encU(wei)+encA(recip)+encB(tt.native),value:'0x0'};
  if(ft.native)return{data:SEL.depositNative+encU(tc.id)+encA(recip),value:toHex(wei)};
  return{data:SEL.depositWQMS+encU(wei)+encU(tc.id)+encA(recip),value:'0x0'};
}
async function runOwnQuote(seq,wei){
  const from=fromChain(),to=toChain(),toQms=to.id===QMS.id;
  const src=toQms?BRIDGE.spokes[from.id].bridge:BRIDGE.hub.address;
  let q;
  try{
    const calls=[rpc(from,'eth_call',[{to:src,data:SEL.minAmount},'latest']),rpc(from,'eth_call',[{to:src,data:SEL.maxAmount},'latest']),
      rpc(from,'eth_call',[{to:src,data:SEL.paused},'latest']).catch(()=>null)];
    if(toQms)calls.push(rpc(to,'eth_getBalance',[BRIDGE.hub.address,'latest']));
    const[mn,mx,ps,pool]=await Promise.all(calls);
    const min=BigInt(mn),max=BigInt(mx);
    S.info[from.id]=Object.assign(S.info[from.id]||{},{min,max,paused:ps?BigInt(ps)===1n:false});
    if(S.info[from.id].paused)q={state:'error',error:'The bridge on '+from.name+' is paused. Transfers are disabled until it is resumed.'};
    else if(wei<min)q={state:'error',error:'Minimum amount is '+fmt(formatUnits(min,18))+' QMS.'};
    else if(wei>max)q={state:'error',error:'Maximum per transfer is '+fmt(formatUnits(max,18))+' QMS.'};
    else if(toQms&&pool&&wei>BigInt(pool))q={state:'error',error:'Not enough QMS liquidity on QMS Testnet right now. Try a smaller amount.'};
    else q={state:'ready',own:true,out:formatUnits(wei,18),at:Date.now()};
  }catch(e){console.error('Qros own quote failed:',e);q={state:'error',error:'Quote failed: '+(e?.message||String(e))}}
  if(seq!==S.quoteSeq)return;
  S.q=q;renderQuote();
  if(q.state==='ready'&&S.account)estimateOwnCosts(seq,wei);
}
/* Best-effort network gas estimate + approval requirement. Never blocks the bridge button. */
async function estimateOwnCosts(seq,wei){
  const from=fromChain(),ft=fromTok(),tc=toChain();
  const bridge=tc.id===QMS.id?BRIDGE.spokes[from.id].bridge:BRIDGE.hub.address;
  const out={};
  try{
    if(tc.id!==QMS.id&&!ft.native){
      const al=BigInt(await rpc(from,'eth_call',[{to:ft.address,data:SEL.allowance+encA(S.account)+encA(bridge)},'latest'])||'0x0');
      out.needApprove=al<wei;
    }
    if(!out.needApprove){
      const{data,value}=ownCallData(wei);
      const[gas,price]=await Promise.all([rpc(from,'eth_estimateGas',[{from:S.account,to:bridge,data,value}]),rpc(from,'eth_gasPrice')]);
      out.gasWei=BigInt(gas)*BigInt(price);
    }
  }catch{}
  if(seq!==S.quoteSeq||S.q.state!=='ready'||!S.q.own)return;
  S.q.est=out;renderQuote();
}
async function runQuote(seq,wei){
  const body={
    user:S.account||DEAD,originChainId:S.from.chainId,destinationChainId:S.to.chainId,
    originCurrency:S.from.token,destinationCurrency:S.to.token,amount:wei.toString(),tradeType:'EXACT_INPUT'
  };
  if(S.slip!=='auto')body.slippageTolerance=String(S.slip);
  if(S.useRecipient&&isAddr(S.recipient))body.recipient=S.recipient;
  try{
    const r=await fetch(CFG.api+'/quote/v2',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(seq!==S.quoteSeq)return;
    if(!r.ok||!j.steps){S.q={state:'error',error:friendly(j,r.status)};}
    else{S.q={state:'ready',quote:j,at:Date.now()};qRefresh=setTimeout(()=>{if(!S.busy&&S.q.state==='ready')scheduleQuote()},60000)}
  }catch(e){
    if(seq!==S.quoteSeq)return;
    S.q={state:'error',error:"Couldn't fetch a quote. Check your connection and try again."};
  }
  renderQuote();
}
function friendly(j,status){
  const m=(j&&(j.message||j.error))||'';
  if(/insufficient|balance/i.test(m)&&!S.account)return 'Connect your wallet to get an exact quote for this amount.';
  return 'No route is available for this pair or amount right now.';
}
const outAmount=q=>{
  const o=q&&q.details&&q.details.currencyOut;if(!o)return '';
  return o.amountFormatted||(o.amount?formatUnits(BigInt(o.amount),toTok().decimals):'');
};

/* ---------- rendering ---------- */
function chip(c,tok){
  if(c&&c.id===QMS.id&&!c.icon)return h('span',{class:'chip qms'},qmsSvg());
  const label=(tok?tok.symbol:c.name)[0]||'?';
  const el=h('span',{class:'chip',style:'background:hsl('+hue(tok?tok.symbol:c.name)+' 60% 70%)'},label);
  const url=tok?tok.logo:c&&c.icon;
  if(url){const img=h('img',{src:url,alt:'',loading:'lazy'});img.addEventListener('error',()=>img.remove());el.append(img)}
  return el;
}
function qmsSvg(){const d=document.createElement('span');d.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M15 15l4.5 4.5"/></svg>';return d.firstChild}
const car=()=>h('span',{class:'car'},ico('chev'));
function renderSides(){
  const fc=fromChain(),tc=toChain(),ft=fromTok(),tt=toTok();
  const fill=(btn,kids)=>{btn.replaceChildren(...kids)};
  fill($('fromChain'),[chip(fc),fc.name,car()]);
  fill($('toChain'),[chip(tc),tc.name,car()]);
  fill($('fromTok'),[chip(null,ft),ft.symbol,car()]);
  fill($('toTok'),[chip(null,tt),tt.symbol,car()]);
  const fb=balOf(S.from.chainId,ft),tb=balOf(S.to.chainId,tt);
  $('fromBal').textContent=S.account?(fb==null?'Balance: —':'Balance: '+fmt(formatUnits(fb,ft.decimals))+' '+ft.symbol):'';
  $('toBal').textContent=S.account?(tb==null?'Balance: —':'Balance: '+fmt(formatUnits(tb,tt.decimals))+' '+tt.symbol):'';
  $('maxBtn').hidden=!(S.account&&fb);
  const k=routeKind();
  $('routeBadge').textContent=k==='own'?'QMS bridge':k==='relay'?'Network route':'Unavailable';
  $('routeBadge').className='badge '+(k==='blocked'?'warn':'acc');
  renderWalletBtn();
}
function renderBanner(){
  const el=$('banner');
  el.hidden=false;el.className='banner';el.replaceChildren(
    h('div',{style:'margin-bottom:8px;font-weight:600;color:var(--text)'},'Need QMS Testnet?'),
    h('div',{class:'acts',style:'margin-top:0'},
      h('button',{class:'mini',onclick:addQms},ico('wallet'),'Add QMS Testnet to wallet'),
      h('a',{class:'mini',href:QMS.faucet,target:'_blank',rel:'noopener'},ico('drop'),'Faucet'),
      h('a',{class:'mini',href:QMS.explorer,target:'_blank',rel:'noopener'},ico('ext'),'Explorer')));
}
/* Typical delivery time, measured from this browser's own completed transfers on the same route. */
function lastTook(){
  const e=S.history.find(x=>x.own&&x.status==='success'&&x.took&&x.fromId===S.from.chainId&&x.toId===S.to.chainId);
  return e?dur(e.took):null;
}
function renderQuote(){
  const q=S.q,det=$('details'),msg=$('msg');
  det.hidden=true;msg.className='msg';msg.textContent='';
  $('out').value=q.state==='ready'?fmt(q.own?q.out:outAmount(q.quote),8):'';
  const row=(a,b,cls)=>b?h('div',{class:'d'+(cls?' '+cls:'')},h('span',{},a),h('span',{},b)):null;
  if(q.state==='error'){msg.className='msg show err';msg.textContent=q.error}
  else if(q.state==='unavailable'){msg.className='msg show info';msg.textContent=q.msg}
  else if(q.state==='ready'&&q.own){
    const fc=fromChain(),tc=toChain(),est=q.est||{};
    const gas=est.needApprove?'Set by your wallet (approval + bridge)':est.gasWei!=null?'~'+fmt(formatUnits(est.gasWei,fc.currency.decimals),6)+' '+fc.currency.symbol:'Set by your wallet';
    const took=lastTook();
    const rows=[
      row('You send',fmt(S.amount,8)+' '+fromTok().symbol),
      row('You receive',fmt(q.out,8)+' '+toTok().symbol,'strong'),
      row('Bridge fee','None'),
      row('Network gas ('+fc.name+')',gas),
      est.needApprove?row('Approval','1 extra transaction (WQMS spend)'):null,
      row('Delivery gas ('+tc.name+')','Paid by the relayer'),
      row('Delivery time',took?'Last on this route: '+took:'Varies with confirmations and the relayer'),
      S.useRecipient&&isAddr(S.recipient)?row('Recipient',short(S.recipient)):null
    ].filter(Boolean);
    det.replaceChildren(...rows);
    det.hidden=false;
  }
  else if(q.state==='ready'){
    const d=q.quote.details||{},f=q.quote.fees||{};
    const money=x=>x&&x.amountFormatted?fmt(x.amountFormatted,6)+' '+(x.currency&&x.currency.symbol||'')+(x.amountUsd&&+x.amountUsd>0?' ($'+(+x.amountUsd).toFixed(2)+')':''):null;
    const rows=[
      row('You receive',fmt(outAmount(q.quote),8)+' '+toTok().symbol,'strong'),
      row('Estimated time',d.timeEstimate!=null?'~'+d.timeEstimate+'s':null),
      row('Network fee',money(f.gas)),
      row('Bridge fee',money(f.relayer)),
      row('Total impact',d.totalImpact&&d.totalImpact.percent!=null?(+d.totalImpact.percent).toFixed(2)+'%':null),
      row('Rate',d.rate?'1 '+fromTok().symbol+' = '+fmt(String(d.rate),6)+' '+toTok().symbol:null),
      row('Quote','Refreshes every minute')
    ].filter(Boolean);
    det.replaceChildren(...rows);
    det.hidden=!rows.length;
  }
  renderPrimary();
}
function primaryState(){
  if(S.busy)return{label:'Working...',off:true};
  if(S.q.state==='unavailable')return{label:'Route unavailable',off:true};
  if(!S.account)return{label:'Connect wallet',off:false,act:connect};
  const f=fromTok(),wei=S.amount?parseUnits(S.amount,f.decimals):null;
  if(!wei||wei===0n)return{label:'Enter an amount',off:true};
  if(S.useRecipient&&!isAddr(S.recipient))return{label:'Enter a valid recipient',off:true};
  const b=balOf(S.from.chainId,f);
  if(b!=null&&wei>b)return{label:'Insufficient '+f.symbol,off:true};
  const g=S.gasBal&&S.gasBal[S.from.chainId];
  if(g===0n&&S.q.state!=='error')return{label:'No '+fromChain().currency.symbol+' for gas',off:true};
  if(S.q.state==='loading')return{label:'Fetching quote...',off:true};
  if(S.q.state==='error')return{label:"Can't bridge this amount",off:true};
  if(S.q.state!=='ready')return{label:'Enter an amount',off:true};
  return{label:'Bridge to '+toChain().name,off:false,act:doBridge};
}
function renderPrimary(){
  const p=primaryState(),b=$('go');b.textContent=p.label;b.disabled=p.off;b.onclick=p.act||null;
  const g=S.gasBal&&S.gasBal[S.from.chainId];
  if(S.account&&g===0n&&$('msg').textContent===''){
    const m=$('msg');m.className='msg show info';
    m.replaceChildren('You have no '+fromChain().currency.symbol+' on '+fromChain().name+' for network gas. ',
      fromChain().id===QMS.id?h('a',{href:QMS.faucet,target:'_blank',rel:'noopener'},'Open the QMS faucet'):'Get testnet '+fromChain().currency.symbol+' from a faucet for this network.');
  }
}
/* Side panel: facts about the selected route, read from the contracts. */
function renderRouteInfo(){
  const el=$('routeInfo');if(!el)return;
  const fc=fromChain(),tc=toChain(),k=routeKind();
  const kv=(a,b)=>h('div',{class:'kv'},h('span',{},a),h('span',{},b));
  const card=[];
  const rows=[kv('From',fc.name),kv('To',tc.name)];
  if(k==='own'){
    const si=S.info[fc.id],di=S.info[tc.id];
    rows.push(kv('Mechanism',fc.id===QMS.id?'Lock QMS on the hub, mint wQMS':'Burn wQMS, release QMS from the hub'));
    rows.push(kv('Per-transfer limits',si&&si.min!=null?fmt(formatUnits(si.min,18))+' to '+fmt(formatUnits(si.max,18))+' QMS':'Loading...'));
    const state=x=>!x?'Checking...':x.paused?'Paused':'Active';
    rows.push(kv(fc.name+' contract',state(si)));
    rows.push(kv(tc.name+' contract',state(di)));
    rows.push(kv('Protocol fee','None'));
  }else if(k==='relay'){
    rows.push(kv('Route type','Direct network route'));
    rows.push(kv('Fees','Shown in the quote'));
  }else rows.push(kv('Status','Not available for this pair'));
  card.push(h('div',{class:'card flat'},h('div',{class:'card-h'},h('h3',{},'Route')),rows));
  if(k==='own'&&((S.info[fc.id]&&S.info[fc.id].paused)||(S.info[tc.id]&&S.info[tc.id].paused)))
    card.push(h('div',{class:'banner warn'},'One of the bridge contracts on this route is paused. New transfers may fail, and deliveries wait until it is resumed.'));
  card.push(h('div',{class:'card flat'},h('div',{class:'card-h'},h('h3',{},'Good to know')),
    h('ul',{class:'muted',style:'margin:0;padding-left:18px;font-size:13.5px;line-height:1.7'},
      h('li',{},'Testnet only. Tokens have no monetary value.'),
      h('li',{},'You can close this tab after sending. Track the transfer any time in Activity.'),
      h('li',{},'A transfer is complete only when the destination chain has processed it.'),
      h('li',{},'The relayer is a single operator in this deployment. Delivery can be delayed if it is offline.'))));
  el.replaceChildren(...card);
}

/* ---------- pickers ---------- */
function pickChain(side){
  const body = h('div',{});
  const supported = [];
  const unavailable = [];
  for (const c of S.chains.values()){
    (SUPPORTED_CHAIN_IDS.has(c.id) ? supported : unavailable).push(c);
  }
  function addSection(title, chains, isUnavailable){
    if (!chains.length) return;
    body.append(h('div',{class:'network-section'},title));
    for (const c of chains){
      const button = h('button',{
        class: 'li' + (isUnavailable ? ' unavailable' : ''),
        type: 'button',
        ...(isUnavailable
          ? {disabled:true,'aria-disabled':'true'}
          : {onclick:()=>{
              $('dlg').close();
              setChain(side,c.id);
            }})
      },
        chip(c),
        h('span',{class:'n'},h('b',{},c.name),h('small',{},'Chain '+c.id)),
        ...(isUnavailable ? [h('span',{class:'route-status'},'Unavailable')] : [])
      );
      body.append(button);
    }
  }
  addSection('Supported',supported,false);
  addSection('Unavailable routes',unavailable,true);
  openDialog(side === 'from' ? 'From network' : 'To network', body);
}
function setChain(side,id){
  const other=side==='from'?'to':'from';
  if(S[other].chainId===id){flip();return}
  S[side]={chainId:id,token:chainOf(id).currency.address};
  fixTokens();
  afterChange();
}
function pickToken(side){
  const cid=S[side].chainId;
  let list=chainOf(cid).tokens;
  if(routeKind()==='own')list=list.filter(t=>inFamily(cid,t));
  const ul=h('div',{});
  const draw=q=>{
    ul.replaceChildren(...list.filter(t=>!q||t.symbol.toLowerCase().includes(q)||t.name.toLowerCase().includes(q)).map(t=>
      h('button',{class:'li',onclick:()=>{$('dlg').close();S[side].token=t.address;if(side==='from')matchToken();afterChange()}},
        chip(null,t),h('span',{class:'n'},h('b',{},t.symbol),h('small',{},t.name)))));
  };
  draw('');
  openDialog('Select token',ul,list.length>6,draw);
}
function flip(){
  const a=S.from,b=S.to;
  S.from={chainId:b.chainId,token:tokenOf(b.chainId,b.token).address};
  S.to={chainId:a.chainId,token:tokenOf(a.chainId,a.token).address};
  afterChange();
}
function afterChange(){renderSides();refreshBalances();refreshGas();scheduleQuote();renderRouteInfo();refreshRouteInfo()}
