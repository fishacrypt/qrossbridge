'use strict';
/* QROS Bridge: shared core. Helpers, chain data, state, RPC, balances, wallet.
   Bridge contract logic is unchanged from the original single-file dapp; only moved here. */

/* ---------- constants & helpers ---------- */
const ZERO='0x0000000000000000000000000000000000000000';
const DEAD='0x000000000000000000000000000000000000dEaD';
const GAS_RESERVE=10n**15n; // kept back when using MAX on a native token
const $=id=>document.getElementById(id);
const LS={get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}};
const CFG={api:'https://api.testnets.relay.link'}; // quote + execution backend for non-QMS routes

const SEL={"depositNative":"0xf0194945","depositWQMS":"0x12a70661","bridgeBack":"0x052bc1f3","processed":"0xc1f0808a","minAmount":"0x9b2cb5d8","maxAmount":"0x5f48f393","approve":"0x095ea7b3","allowance":"0xdd62ed3e",
  "paused":"0x5c975abb","relayer":"0x8406c079","claimable":"0x402914f5","claim":"0x4e71d92d"};
const TOPIC={"bridged":"0x00ecd434907c7fb39030e4c2dd3b81850ed4074e0b7143dfb58047c05d551194","delivered":"0x412a2e49e2fbaa8106a12b6da52f3230d42664f1820de27b3a1806eecb295450","claimableCredited":"0x274ab5bd94b20deda63af3a10820112f8f6e08e59c978b05001dbaabc2463795"};
const encU=v=>BigInt(v).toString(16).padStart(64,'0');
const encA=a=>a.slice(2).toLowerCase().padStart(64,'0');
const encB=b=>(b?'1':'0').padStart(64,'0');

function h(tag,props,...kids){
  const e=document.createElement(tag);
  for(const[k,v]of Object.entries(props||{})){
    if(k==='class')e.className=v;
    else if(k.startsWith('on'))e.addEventListener(k.slice(2),v);
    else if(v===true)e.setAttribute(k,'');
    else if(v!==false&&v!=null)e.setAttribute(k,v);
  }
  for(const c of kids.flat()){if(c==null||c===false)continue;e.append(c.nodeType?c:document.createTextNode(String(c)))}
  return e;
}
function parseUnits(s,d){
  s=String(s).trim();
  if(!/^\d*\.?\d*$/.test(s)||s===''||s==='.')return null;
  let[i,f='']=s.split('.');
  if(f.length>d)f=f.slice(0,d);
  return BigInt((i||'0')+f.padEnd(d,'0'));
}
function formatUnits(v,d){
  const neg=v<0n; if(neg)v=-v;
  const s=v.toString().padStart(d+1,'0');
  const i=s.slice(0,s.length-d);
  const f=d?s.slice(s.length-d).replace(/0+$/,''):'';
  return (neg?'-':'')+i+(f?'.'+f:'');
}
function fmt(str,max=6){
  if(str==null||str==='')return '';
  const[i,f='']=String(str).split('.');
  const ff=f.slice(0,max).replace(/0+$/,'');
  if(!ff&&/[1-9]/.test(f))return '<0.'+'0'.repeat(max-1)+'1';
  return i+(ff?'.'+ff:'');
}
const short=a=>a?a.slice(0,6)+'...'+a.slice(-4):'';
const isAddr=a=>/^0x[0-9a-fA-F]{40}$/.test(a||'');
const isHash=x=>/^0x[0-9a-fA-F]{64}$/.test(x||'');
const toHex=v=>'0x'+BigInt(v).toString(16);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.remove('show'),3200)}
function hue(s){let x=0;for(const c of s)x=(x*31+c.charCodeAt(0))%360;return x}
function copyText(t,msg){try{navigator.clipboard&&navigator.clipboard.writeText(t);toast(msg||'Copied')}catch{toast('Could not copy')}}
function ago(ts){
  const s=Math.max(0,Math.round((Date.now()-ts)/1000));
  if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';
  return new Date(ts).toLocaleDateString();
}
function dur(ms){
  const s=Math.round(ms/1000);if(s<60)return s+'s';
  const m=Math.floor(s/60);return m<60?m+'m '+(s%60)+'s':Math.floor(m/60)+'h '+(m%60)+'m';
}

/* ---------- icons (inline SVG, no dependency) ---------- */
const ICONS={
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',x:'<path d="M6 6l12 12M18 6L6 18"/>',
  gear:'<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  chev:'<path d="M6 9l6 6 6-6"/>',swap:'<path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/>',
  arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  ext:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check:'<path d="M5 12l5 5 9-10"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor:'<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  alert:'<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/>',
  drop:'<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  wallet:'<path d="M4 7a2 2 0 0 1 2-2h12v4"/><path d="M4 7v10a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2z"/><path d="M16 14h.01"/>',
  book:'<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>'
};
function ico(name){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('class','i');s.setAttribute('aria-hidden','true');s.innerHTML=ICONS[name]||'';return s}
function hydrateIcons(root=document){root.querySelectorAll('[data-ico]').forEach(el=>{if(!el.firstChild)el.replaceChildren(ico(el.dataset.ico))})}

/* ---------- chains (data from the chainlist.org dataset) ---------- */
const QMS={id:19480,name:'QMS Testnet',faucet:'https://faucet.testnet.qms.finance',explorer:'https://testnet.qmsscan.io'};
const CHAINLIST_URL='https://chainid.network/chains.json'; // the dataset chainlist.org is built on
const NETS=[
  {id:19480,name:'QMS Testnet',rpc:'https://rpc.testnet.qms.finance',explorer:'https://testnet.qmsscan.io',sym:'QMS',cur:'QMS'},
  {id:11155111,name:'Sepolia',rpc:'https://ethereum-sepolia-rpc.publicnode.com',explorer:'https://sepolia.etherscan.io',sym:'ETH',cur:'Ether'},
  {id:84532,name:'Base Sepolia',rpc:'https://sepolia.base.org',explorer:'https://sepolia-explorer.base.org',sym:'ETH',cur:'Ether'},
  {id:421614,name:'Arbitrum Sepolia',rpc:'https://arbitrum-sepolia-rpc.publicnode.com',explorer:'https://sepolia.arbiscan.io',sym:'ETH',cur:'Ether'},
  {id:11155420,name:'OP Sepolia',rpc:'https://sepolia.optimism.io',explorer:'https://sepolia-optimism.etherscan.io',sym:'ETH',cur:'Ether'},
  {id:80002,name:'Polygon Amoy',rpc:'https://polygon-amoy-bor-rpc.publicnode.com',explorer:'https://amoy.polygonscan.com',sym:'POL',cur:'POL'},
  {id:97,name:'BNB Testnet',rpc:'https://bsc-testnet-rpc.publicnode.com',explorer:'https://testnet.bscscan.com',sym:'tBNB',cur:'BNB'},
  {id:43113,name:'Avalanche Fuji',rpc:'https://api.avax-test.network/ext/bc/C/rpc',explorer:'https://testnet.snowscan.xyz',sym:'AVAX',cur:'Avalanche'}
];
// extra well-known testnets, added only if present in the live chainlist data
const EXTRA_IDS=[59141,534351,1301,763373,168587773,5003,10143,300,560048,17000];
const goodRpc=u=>/^https:\/\//.test(u)&&!/[${}]|YOUR|API_KEY/i.test(u);
function mkChain(id,name,rpcs,explorer,sym,cur,dec){
  const native={symbol:sym,name:cur,address:ZERO,decimals:dec||18,native:true};
  return{id,name,rpcs,rpc:rpcs[0],explorer,icon:null,currency:native,tokens:[native],faucet:id===QMS.id?QMS.faucet:null};
}
function baseChains(){return sortChains(NETS.map(n=>mkChain(n.id,n.name,[n.rpc],n.explorer,n.sym,n.cur)))}
function attachBridge(c){
  if(c.id===QMS.id){
    if(BRIDGE.hub.wqms&&!c.tokens.some(t=>t.address.toLowerCase()===BRIDGE.hub.wqms.toLowerCase()))
      c.tokens.push({symbol:'WQMS',name:'Wrapped QMS',address:BRIDGE.hub.wqms,decimals:18});
  }else if(BRIDGE.spokes[c.id]&&!c.tokens.some(t=>t.bridged)){
    c.tokens.push({symbol:'wQMS',name:'Wrapped QMS',address:BRIDGE.spokes[c.id].token,decimals:18,bridged:true});
  }
}
function sortChains(list){
  list.forEach(attachBridge);
  return new Map(list.sort((a,b)=>a.id===QMS.id?-1:b.id===QMS.id?1:a.name.localeCompare(b.name)).map(c=>[c.id,c]));
}

/* ---------- state ---------- */
const S={
  chains:new Map(),chainsSource:'',chainsAt:0,
  from:{chainId:QMS.id,token:ZERO},to:{chainId:84532,token:ZERO},
  amount:'',recipient:'',useRecipient:false,
  provider:null,account:null,walletChain:null,walletName:'',
  bal:{},q:{state:'idle'},busy:false,quoteSeq:0,slip:LS.get('tetrixbridge.slip')||'auto',
  history:LS.get('tetrixbridge.history.v1')||[],
  info:{} // live route info (limits, pause state) keyed by chain id
};
const chainOf=id=>S.chains.get(id);
const tokenOf=(cid,addr)=>{const c=chainOf(cid);return c&&(c.tokens.find(t=>t.address.toLowerCase()===String(addr).toLowerCase())||c.tokens[0])};
const fromChain=()=>chainOf(S.from.chainId),toChain=()=>chainOf(S.to.chainId);
const fromTok=()=>tokenOf(S.from.chainId,S.from.token),toTok=()=>tokenOf(S.to.chainId,S.to.token);
const txUrl=(c,hash)=>c&&c.explorer&&hash?c.explorer.replace(/\/$/,'')+'/tx/'+hash:null;
const addrUrl=(c,a)=>c&&c.explorer&&a?c.explorer.replace(/\/$/,'')+'/address/'+a:null;

async function loadChains(){
  const list=[...baseChains().values()];
  try{
    const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),15000);
    const r=await fetch(CHAINLIST_URL,{signal:ctl.signal});clearTimeout(t);
    const live=await r.json();
    if(Array.isArray(live)){
      const by=new Map(live.map(c=>[c.chainId,c]));
      for(const c of list){ // add extra public RPCs as fallbacks
        const l=by.get(c.id);
        if(l)for(const u of(l.rpc||[]).filter(goodRpc)){if(!c.rpcs.includes(u)&&c.rpcs.length<4)c.rpcs.push(u)}
      }
      for(const id of EXTRA_IDS){
        const l=by.get(id);if(!l||l.status==='deprecated')continue;
        const rpcs=(l.rpc||[]).filter(goodRpc).slice(0,3);
        const ex=l.explorers&&l.explorers[0]&&l.explorers[0].url;
        if(!rpcs.length||!ex)continue;
        const nc=l.nativeCurrency||{};
        list.push(mkChain(id,l.name,rpcs,ex,nc.symbol||'ETH',nc.name||nc.symbol||'Ether',nc.decimals));
      }
    }
  }catch(e){}
  S.chains=sortChains(list);S.chainsAt=Date.now();
  for(const side of['from','to']){
    if(!chainOf(S[side].chainId)){S[side].chainId=[...S.chains.keys()][0];S[side].token=ZERO}
    S[side].token=tokenOf(S[side].chainId,S[side].token).address;
  }
  if(S.from.chainId===S.to.chainId){const other=[...S.chains.keys()].find(k=>k!==S.from.chainId);S.to={chainId:other,token:ZERO}}
  matchToken();
}
const bridgeReady=()=>!!(BRIDGE.hub&&BRIDGE.hub.address);
const isSpoke=id=>!!(BRIDGE.spokes&&BRIDGE.spokes[id]);
// 'relay' = a normal route, 'own' = QMS <-> a supported network, 'blocked' = QMS with an unsupported network
const SUPPORTED_CHAIN_IDS = new Set([
  19480,   // QMS Testnet
  84532,   // Base Sepolia
  421614,  // Arbitrum Sepolia
  11155420 // OP Sepolia
]);

function routeKind(){
  const a = S.from.chainId;
  const b = S.to.chainId;

  // Block routes involving unsupported networks.
  if (!SUPPORTED_CHAIN_IDS.has(a) ||
      !SUPPORTED_CHAIN_IDS.has(b)) {
    return 'blocked';
  }

  // A bridge route must use two different networks.
  if (a === b) return 'blocked';

  // Routes between supported non-QMS networks use the relay.
  if (a !== QMS.id && b !== QMS.id) {
    return 'relay';
  }

  // QMS routes require a configured spoke contract.
  const other = a === QMS.id ? b : a;
  return bridgeReady() && isSpoke(other) ? 'own' : 'blocked';
}
const inFamily=(cid,t)=>cid===QMS.id?(t.native||(BRIDGE.hub.wqms&&t.address.toLowerCase()===BRIDGE.hub.wqms.toLowerCase())):!!t.bridged;
function matchToken(){ // destination token follows the source token
  const ft=fromTok(),dc=toChain();
  let pick=null;
  if(routeKind()==='own')pick=S.from.chainId===QMS.id?dc.tokens.find(t=>t.bridged):dc.tokens[0];
  if(!pick)pick=dc.tokens.find(t=>t.symbol===ft.symbol);
  S.to.token=(pick||dc.tokens[0]).address;
}
function fixTokens(){
  if(routeKind()==='own'){
    const f=fromChain();
    if(f.id!==QMS.id)S.from.token=(f.tokens.find(t=>t.bridged)||f.tokens[0]).address;
    else if(!inFamily(f.id,fromTok()))S.from.token=ZERO;
  }
  matchToken();
}
/* bridge contract on a given chain (hub on QMS, spoke elsewhere) or null */
const bridgeAt=id=>id===QMS.id?BRIDGE.hub.address:(BRIDGE.spokes[id]||{}).bridge||null;

/* ---------- RPC & balances ---------- */
async function rpc(chain,method,params=[]){
  const urls=chain.rpcs;
  let err;
  for(const u of urls){
    try{
      const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),8000);
      const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:ctl.signal});
      clearTimeout(t);
      const j=await r.json();if(j.error)throw new Error(j.error.message);return j.result;
    }catch(e){err=e}
  }
  throw err||new Error('RPC unavailable');
}
async function getBalance(chain,tok,acct){
  if(tok.native)return BigInt(await rpc(chain,'eth_getBalance',[acct,'latest']));
  const data='0x70a08231'+acct.slice(2).toLowerCase().padStart(64,'0');
  return BigInt(await rpc(chain,'eth_call',[{to:tok.address,data},'latest'])||'0x0');
}
const balKey=(c,t,a)=>c+':'+t.address.toLowerCase()+':'+a.toLowerCase();
async function refreshBalances(){
  if(!S.account)return;
  for(const[cid,tok]of[[S.from.chainId,fromTok()],[S.to.chainId,toTok()]]){
    const k=balKey(cid,tok,S.account);
    try{S.bal[k]=await getBalance(chainOf(cid),tok,S.account)}catch{S.bal[k]=null}
  }
  renderSides();renderPrimary();refreshGas();
}
const balOf=(cid,tok)=>S.account?S.bal[balKey(cid,tok,S.account)]:undefined;

/* Turn a wallet / RPC error into short user-facing text. */
function walletError(e,chain){
  const m=String((e&&(e.shortMessage||e.message))||e||'');
  const sym=chain&&chain.currency?chain.currency.symbol:'gas token';
  if(e&&(e.code===4001||/user rejected|user denied|rejected the request|denied transaction/i.test(m)))return{rejected:true,text:'Rejected in your wallet'};
  if(/insufficient funds|exceeds balance|gas required exceeds|insufficient balance for transfer/i.test(m))return{text:'Not enough '+sym+(chain?' on '+chain.name:'')+' to cover the amount plus network gas.'};
  if(/AmountOutOfRange/i.test(m))return{text:'Amount is outside the allowed limits for this route.'};
  if(/paused|EnforcedPause/i.test(m))return{text:'The bridge is paused right now. Try again later.'};
  if(/UnsupportedChain/i.test(m))return{text:'This destination is not enabled on the bridge contract.'};
  if(/nonce too low|replacement transaction|already known/i.test(m))return{text:'Your wallet has a pending transaction with a conflicting nonce. Wait for it or speed it up, then retry.'};
  if(/network|fetch|timeout|timed out|failed to/i.test(m)&&!/revert/i.test(m))return{text:'Network problem: '+m.slice(0,140)};
  return{text:m.slice(0,200)||'Something went wrong'};
}

/* ---------- dialog ---------- */
function openDialog(title,body,searchable,onSearch){
  $('dlgTitle').textContent=title;
  const wrap=$('dlgBody');wrap.replaceChildren();
  if(searchable){const i=h('input',{type:'search',placeholder:'Search',autocomplete:'off','aria-label':'Search'});i.addEventListener('input',()=>onSearch(i.value.toLowerCase()));wrap.append(i)}
  wrap.append(body);
  if(!$('dlg').open)$('dlg').showModal();
}
/* Resolves true when the user confirms. */
function confirmDialog(title,text,okLabel){
  return new Promise(res=>{
    let done=false;const finish=v=>{if(done)return;done=true;$('dlg').removeEventListener('close',onClose);if($('dlg').open)$('dlg').close();res(v)};
    const onClose=()=>finish(false);
    $('dlg').addEventListener('close',onClose);
    openDialog(title,h('div',{},h('p',{class:'muted',style:'margin-bottom:16px'},text),
      h('div',{style:'display:flex;gap:8px'},h('button',{class:'btn',style:'flex:1',onclick:()=>finish(false)},'Cancel'),h('button',{class:'btn solid',style:'flex:1',onclick:()=>finish(true)},okLabel||'Continue'))));
  });
}

/* ---------- wallet ---------- */
const wallets=new Map();
addEventListener('eip6963:announceProvider',e=>{if(e.detail&&e.detail.info)wallets.set(e.detail.info.uuid,e.detail)});
dispatchEvent(new Event('eip6963:requestProvider'));
let wHandlers=null;
function walletList(){
  const l=[...wallets.values()];
  if(!l.length&&window.ethereum)l.push({info:{name:'Browser wallet',rdns:'injected'},provider:window.ethereum});
  return l;
}
async function useWallet(w,silent){
  try{
    const accts=await w.provider.request({method:silent?'eth_accounts':'eth_requestAccounts'});
    if(!accts||!accts.length)return false;
    if(S.provider&&wHandlers){try{S.provider.removeListener('accountsChanged',wHandlers.a);S.provider.removeListener('chainChanged',wHandlers.c)}catch{}}
    S.provider=w.provider;S.account=accts[0];S.walletName=w.info.name;
    S.walletChain=parseInt(await w.provider.request({method:'eth_chainId'}),16);
    wHandlers={
      a:a=>{S.account=a&&a[0]||null;if(!S.account){S.provider=null}renderAll();refreshBalances();onAccountChange()},
      c:c=>{S.walletChain=parseInt(c,16);renderAll()}
    };
    w.provider.on&&w.provider.on('accountsChanged',wHandlers.a);
    w.provider.on&&w.provider.on('chainChanged',wHandlers.c);
    LS.set('tetrixbridge.wallet',w.info.rdns||w.info.name);
    renderAll();refreshBalances();scheduleQuote();onAccountChange();
    return true;
  }catch(e){
    if(!silent)toast(e&&e.code===4001?'Connection rejected':'Could not connect wallet');
    return false;
  }
}
function connect(){
  const l=walletList();
  if(!l.length){toast('No wallet detected. Install a browser wallet and reload.');return}
  if(l.length===1)return useWallet(l[0]);
  const body=h('div',{});
  for(const w of l)body.append(h('button',{class:'li',onclick:()=>{$('dlg').close();useWallet(w)}},
    w.info.icon?h('img',{src:w.info.icon,width:32,height:32,alt:'',style:'border-radius:8px'}):h('span',{class:'chip'},'W'),
    h('span',{class:'n'},h('b',{},w.info.name))));
  openDialog('Select wallet',body);
}
function disconnect(){
  S.account=null;S.provider=null;LS.set('tetrixbridge.wallet',null);
  if($('dlg').open)$('dlg').close();
  renderAll();scheduleQuote();onAccountChange();
}
function walletMenu(){
  const wc=S.walletChain&&chainOf(S.walletChain);
  const body=h('div',{},
    h('p',{class:'addr',style:'margin:0 0 4px'},S.account),
    h('p',{class:'muted',style:'font-size:12.5px;margin:0 0 14px'},S.walletName+(S.walletChain?' · '+(wc?wc.name:'chain '+S.walletChain):'')),
    h('div',{style:'display:flex;gap:8px;flex-wrap:wrap'},
      h('button',{class:'mini',onclick:()=>copyText(S.account,'Address copied')},ico('copy'),'Copy address'),
      h('button',{class:'mini',onclick:disconnect},'Disconnect')));
  openDialog('Wallet',body);
}
async function ensureChain(id){
  const cur=parseInt(await S.provider.request({method:'eth_chainId'}),16);
  if(cur===id)return;
  const hex='0x'+id.toString(16);
  try{await S.provider.request({method:'wallet_switchEthereumChain',params:[{chainId:hex}]})}
  catch(e){
    if(e&&(e.code===4902||e.code===-32603||/unrecognized|not added|add/i.test(e.message||''))){await addChain(id)}
    else throw e;
  }
  S.walletChain=parseInt(await S.provider.request({method:'eth_chainId'}),16);
  if(S.walletChain!==id)throw new Error('Switch your wallet to '+chainOf(id).name+' to continue.');
}
async function addChain(id){
  const c=chainOf(id);
  await S.provider.request({method:'wallet_addEthereumChain',params:[{
    chainId:'0x'+id.toString(16),chainName:c.name,
    nativeCurrency:{name:c.currency.name,symbol:c.currency.symbol,decimals:c.currency.decimals},
    rpcUrls:c.rpcs.slice(0,3),blockExplorerUrls:c.explorer?[c.explorer]:undefined
  }]});
}
async function addQms(){
  if(!S.provider){await connect();if(!S.provider)return}
  try{await addChain(QMS.id);toast('QMS Testnet added')}catch(e){if(!(e&&e.code===4001))toast('Could not add network')}
}
