'use strict';
/* QROS Protocol: Networks and Docs pages. Live values are read from the chains; nothing is hardcoded or invented. */

const NETSTAT={}; // chainId -> live status
const bridgeChainIds=()=>[QMS.id,...Object.keys(BRIDGE.spokes||{}).map(Number)];

async function loadNetStatus(id){
  const c=chainOf(id),addr=bridgeAt(id);if(!c||!addr)return;
  const st={loading:true};NETSTAT[id]=st;
  const call=data=>rpc(c,'eth_call',[{to:addr,data},'latest']);
  try{
    const[blk,ps,rl]=await Promise.all([rpc(c,'eth_blockNumber'),call(SEL.paused).catch(()=>null),call(SEL.relayer).catch(()=>null)]);
    st.block=parseInt(blk,16);st.paused=ps?BigInt(ps)===1n:null;
    if(rl){st.relayer='0x'+rl.slice(26);try{st.relayerBal=BigInt(await rpc(c,'eth_getBalance',[st.relayer,'latest']))}catch{}}
    if(id===QMS.id){try{st.pool=BigInt(await rpc(c,'eth_getBalance',[addr,'latest']))}catch{}}
  }catch{st.err=true}
  st.loading=false;st.at=Date.now();
  if(currentView==='networks')renderNetworks();
}
function refreshNetStatus(){bridgeChainIds().forEach(id=>{loadNetStatus(id)});renderNetworks()}

function renderNetworks(){
  const grid=$('netGrid');
  grid.replaceChildren(...bridgeChainIds().map(chainOf).filter(Boolean).map(c=>{
    const st=NETSTAT[c.id]||{loading:true},addr=bridgeAt(c.id);
    const tok=c.id===QMS.id?c.tokens.find(t=>!t.native):c.tokens.find(t=>t.bridged);
    const kv=(a,b)=>b==null||b===''?null:h('div',{class:'kv'},h('span',{},a),h('span',{},b));
    const lnk=(u,t)=>u?h('a',{href:u,target:'_blank',rel:'noopener',class:'addr'},t):t;
    const sym=c.currency.symbol;
    const status=st.loading&&st.block==null?h('span',{class:'skel',style:'display:inline-block;width:90px;height:14px'}):
      st.err?h('span',{style:'color:var(--bad)'},'RPC unreachable'):
      h('span',{},h('span',{class:'dotl '+(st.paused?'warn':'')+'',style:'display:inline-block;margin-right:8px'}),st.paused?'Paused':'Operational',' · block ',String(st.block));
    const rb=st.relayerBal;
    return h('div',{class:'card'},
      h('div',{class:'card-h'},h('div',{class:'net-card'},chip(c),h('div',{class:'n'},h('b',{},c.name),h('small',{},'Chain '+c.id))),
        h('span',{class:'badge '+(c.id===QMS.id?'acc':'')},c.id===QMS.id?'Hub':'Spoke')),
      kv('Status',status),
      kv('Gas token',sym),
      kv('Bridge contract',lnk(addrUrl(c,addr),short(addr))),
      kv(c.id===QMS.id?'WQMS token':'wQMS token',tok?lnk(addrUrl(c,tok.address),short(tok.address)):null),
      c.id===QMS.id&&st.pool!=null?kv('Hub liquidity',fmt(formatUnits(st.pool,18),4)+' QMS'):null,
      st.relayer?kv('Relayer gas balance',rb==null?'Unknown':h('span',{style:rb===0n?'color:var(--bad)':''},fmt(formatUnits(rb,c.currency.decimals),5)+' '+sym+(rb===0n?' · deliveries here will stall':''))):null,
      h('div',{style:'display:flex;flex-wrap:wrap;gap:8px;margin-top:14px'},
        h('button',{class:'mini',onclick:async()=>{if(!S.provider){await connect();if(!S.provider)return}try{await addChain(c.id);toast(c.name+' added to wallet')}catch(e){if(!(e&&e.code===4001))toast('Could not add network')}}},ico('wallet'),'Add to wallet'),
        c.explorer?h('a',{class:'mini',href:c.explorer,target:'_blank',rel:'noopener'},ico('ext'),'Explorer'):null,
        c.faucet?h('a',{class:'mini',href:c.faucet,target:'_blank',rel:'noopener'},ico('drop'),'Faucet'):null));
  }));
}

/* ---------- docs ---------- */
function renderDocs(){
  const hub=chainOf(QMS.id),info=S.info[QMS.id];
  const code=t=>h('code',{},t);
  const sec=(title,...kids)=>[h('h2',{},title),...kids];
  const addr=(c,a)=>h('a',{href:addrUrl(c,a),target:'_blank',rel:'noopener',class:'addr'},a);
  const spokes=Object.keys(BRIDGE.spokes||{}).map(Number).map(chainOf).filter(Boolean);
  const limits=info&&info.min!=null?fmt(formatUnits(info.min,18))+' to '+fmt(formatUnits(info.max,18))+' QMS per transfer':'loaded from the bridge contract when you open the bridge page';
  $('docBody').replaceChildren(
    ...sec('Overview',h('p',{},'QROS currently provides testnet transfers between QMS Testnet and '+spokes.map(c=>c.name).join(', ')+'. On QMS Testnet you hold native QMS or WQMS. On every other network you hold wQMS, a token the bridge mints one-to-one against QMS locked on QMS Testnet.')),
    ...sec('Where QROS is going',h('p',{},'The next stage is a unified cross-chain liquidity experience: users should be able to start with supported stablecoins on QMS, discover opportunities on connected networks, and authorize a destination DeFi action through QROS. QROS would coordinate liquidity sourcing, destination execution and settlement behind the scenes.'),h('p',{class:'muted',style:'margin-top:10px'},'This is the product direction, not a live feature today. The current release supports the testnet transfer routes described on this page. Cross-chain liquidity advances, DeFi integrations, unified balances and destination execution are not yet enabled.')),
    ...sec('How a transfer works',h('ul',{},
      h('li',{},h('b',{},'QMS to another network: '),'you send native QMS (or WQMS, which is unwrapped) to the hub contract on QMS Testnet. The relayer then mints the same amount of wQMS on the destination network.'),
      h('li',{},h('b',{},'Another network to QMS: '),'you burn wQMS on the source network and choose to receive native QMS or WQMS. The relayer then releases that amount from the hub.'),
      h('li',{},'Every transfer has a unique ID and the destination contract accepts each ID exactly once.'))),
    ...sec('What the statuses mean',h('ul',{},
      h('li',{},h('b',{},'Confirming: '),'your transaction has been sent but the source network has not included it yet.'),
      h('li',{},h('b',{},'In transit: '),'the source transaction is confirmed. We are waiting for the relayer to deliver on the destination network.'),
      h('li',{},h('b',{},'Delayed: '),'delivery has taken more than three minutes. Your funds are held by the bridge contract and nothing is lost. The relayer may be offline or out of gas.'),
      h('li',{},h('b',{},'Complete: '),'the destination contract has processed the transfer. We check this on chain. A confirmed source transaction alone never counts as complete.'),
      h('li',{},h('b',{},'Failed: '),'the source transaction reverted or could not be found. Nothing was sent.'))),
    ...sec('Fees and limits',h('ul',{},
      h('li',{},'The bridge charges no protocol fee.'),
      h('li',{},'You pay network gas on the source network. The relayer pays gas on the destination network.'),
      h('li',{},'Current limits: '+limits+'.'),
      h('li',{},'Routes between two non-QMS networks come with a quote that lists its own fees and estimated time.'))),
    ...sec('If something looks stuck',h('ul',{},
      h('li',{},'Open Activity and use Check again on the transfer. Status is read from the chains, so it is always current.'),
      h('li',{},'On the Networks page, a relayer gas balance of zero on the destination network means deliveries there will wait until it is topped up.'),
      h('li',{},'If native QMS cannot be sent to a recipient contract, the amount is held for that address and a Claim button appears.'),
      h('li',{},'Wallet on the wrong network? The bridge asks your wallet to switch automatically before sending.'))),
    ...sec('Trust model and safety',h('p',{},'This is a testnet deployment and has not been audited. A single relayer key authorises every mint and release. The contract owner can pause the bridge and change limits. Do not treat this design as safe for real value without a review and a multi-party validator set.')),
    ...sec('Contracts',h('div',{class:'card flat'},
      h('div',{class:'kv'},h('span',{},hub.name+' (hub)'),addr(hub,BRIDGE.hub.address)),
      h('div',{class:'kv'},h('span',{},'WQMS'),addr(hub,BRIDGE.hub.wqms)),
      ...spokes.flatMap(c=>{const sp=BRIDGE.spokes[c.id];return[
        h('div',{class:'kv'},h('span',{},c.name+' bridge'),addr(c,sp.bridge)),
        h('div',{class:'kv'},h('span',{},c.name+' wQMS'),addr(c,sp.token))]}))),
    ...sec('Source code',h('p',{},h('a',{href:'https://github.com/fishacrypt/qrossbridge',target:'_blank',rel:'noopener'},'github.com/fishacrypt/qrossbridge'),' has the contracts, the relayer and this app. The relayer runs separately; this page talks to the chains directly.'))
  );
}
