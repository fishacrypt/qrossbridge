'use strict';
/* QROS Bridge: app shell. Router, header, navigation, theme, settings and startup. */

const VIEWS=['home','bridge','activity','networks','docs'];
const THEMES=[['dark','Dark'],['light','Light'],['system','System']];
const SLIP=[['auto','Auto'],['50','0.5%'],['100','1%'],['300','3%']];
const SOURCE_URL='https://github.com/fishacrypt/qrossbridge';
const currentTheme=()=>LS.get('tetrixbridge.theme')||'dark';

/* ---------- theme + settings ---------- */
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);LS.set('tetrixbridge.theme',t);renderThemeBtn()}
function cycleTheme(){const i=THEMES.findIndex(x=>x[0]===currentTheme());applyTheme(THEMES[(i+1)%THEMES.length][0])}
function renderThemeBtn(){
  const t=currentTheme(),b=$('themeBtn');
  b.replaceChildren(ico(t==='light'?'sun':t==='system'?'monitor':'moon'));
  b.setAttribute('aria-label','Theme: '+t+'. Click to change.');b.title='Theme: '+t;
}
function setSlip(v){S.slip=v;LS.set('tetrixbridge.slip',v);scheduleQuote()}
function openSettings(){
  const body=h('div',{});
  const seg=(items,active,on)=>h('div',{class:'seg',role:'group'},items.map(([v,l])=>h('button',{class:v===active?'on':'','aria-pressed':v===active,onclick:()=>on(v)},l)));
  const draw=()=>{
    const preset=SLIP.some(x=>x[0]===S.slip);
    const inp=h('input',{type:'text',inputmode:'decimal',placeholder:'Custom %',value:preset?'':String(+S.slip/100),'aria-label':'Custom slippage percent'});
    inp.addEventListener('change',()=>{
      const p=parseFloat(inp.value.replace(',','.'));
      if(!(p>=0.01&&p<=50)){toast('Enter a value from 0.01 to 50');return}
      setSlip(String(Math.round(p*100)));draw();
    });
    body.replaceChildren(
      h('label',{class:'field'},'Slippage tolerance'),
      h('p',{class:'muted',style:'font-size:12.5px;margin:0 0 8px'},'Applies to routes between non-QMS networks. QMS transfers are always one-to-one.'),
      seg(SLIP,S.slip,v=>{setSlip(v);draw()}),
      h('div',{style:'margin-top:8px'},inp),
      S.slip!=='auto'&&+S.slip>500?h('p',{style:'color:var(--warn);font-size:12.5px;margin:6px 0 0'},'High slippage can lead to an unfavourable rate.'):null,
      h('label',{class:'field',style:'margin-top:16px'},'Theme'),
      seg(THEMES,currentTheme(),v=>{applyTheme(v);draw()}));
  };
  draw();openDialog('Settings',body);
}

/* ---------- header ---------- */
function moreItems(){
  return[
    {t:'Testnet faucet',href:QMS.faucet,ico:'drop',ext:true},
    {t:'QMS explorer',href:QMS.explorer,ico:'ext',ext:true},
    {t:'Add QMS Testnet to wallet',act:addQms,ico:'wallet'},
    {t:'Source code',href:SOURCE_URL,ico:'book',ext:true},
    {t:'Settings',act:openSettings,ico:'gear'}
  ];
}
function itemEl(it,after){
  const kids=[ico(it.ico),it.t];
  if(it.href)return h('a',{href:it.href,target:'_blank',rel:'noopener',onclick:after},...kids);
  return h('button',{class:'dl',onclick:()=>{after&&after();it.act()}},...kids);
}
function buildChrome(){
  hydrateIcons();
  const menu=$('moreMenu');
  menu.replaceChildren(...moreItems().map(it=>itemEl(it,closeMenus)));
  $('ftrNav').replaceChildren(
    h('a',{href:'#/docs'},'Docs'),h('a',{href:QMS.faucet,target:'_blank',rel:'noopener'},'Faucet'),
    h('a',{href:QMS.explorer,target:'_blank',rel:'noopener'},'Explorer'),h('a',{href:SOURCE_URL,target:'_blank',rel:'noopener'},'Source'));
  const dr=$('drawer');
  dr.replaceChildren(...VIEWS.map(v=>h('a',{href:'#/'+(v==='home'?'':v),'data-route':v},v[0].toUpperCase()+v.slice(1))),
    h('hr'),...moreItems().map(it=>itemEl(it,closeMenus)),
    h('hr'),h('button',{class:'dl',onclick:cycleTheme},ico('moon'),'Change theme'));
  renderThemeBtn();
}
function closeMenus(){
  $('moreMenu').hidden=true;$('moreBtn').setAttribute('aria-expanded','false');
  $('drawer').hidden=true;$('burger').setAttribute('aria-expanded','false');
}
function toggleMore(e){
  e.stopPropagation();const m=$('moreMenu'),open=m.hidden;
  closeMenus();m.hidden=!open;$('moreBtn').setAttribute('aria-expanded',String(open));
}
function toggleDrawer(e){
  e.stopPropagation();const d=$('drawer'),open=d.hidden;
  closeMenus();d.hidden=!open;$('burger').setAttribute('aria-expanded',String(open));
  $('burger').replaceChildren(ico(open?'x':'menu'));
}
function renderWalletBtn(){
  const b=$('walletBtn');
  b.textContent=S.account?short(S.account):'Connect wallet';
  b.classList.toggle('on',!!S.account);
  const p=$('netPill');
  if(!S.account||!S.walletChain){p.hidden=true;return}
  const c=chainOf(S.walletChain),ok=SUPPORTED_CHAIN_IDS.has(S.walletChain);
  p.hidden=false;
  p.replaceChildren(h('span',{class:'dotl '+(ok?'':'warn')}),h('span',{class:'t'},c?c.name:'Chain '+S.walletChain));
  p.title=ok?'Connected to '+(c?c.name:S.walletChain):'This network is not supported by QROS Bridge. Click to switch.';
  p.setAttribute('aria-label',p.title);
}
function pickWalletNetwork(){
  const body=h('div',{});
  body.append(h('p',{class:'muted',style:'font-size:13px;margin:0 0 8px'},'Switch your wallet to a supported network.'));
  for(const id of SUPPORTED_CHAIN_IDS){
    const c=chainOf(id);if(!c)continue;
    body.append(h('button',{class:'li',onclick:async()=>{
      $('dlg').close();
      try{await ensureChain(id)}catch(e){const er=walletError(e,c);if(!er.rejected)toast(er.text)}
      renderAll();
    }},chip(c),h('span',{class:'n'},h('b',{},c.name),h('small',{},'Chain '+c.id)),S.walletChain===id?h('span',{class:'badge acc'},'Current'):null));
  }
  openDialog('Switch network',body);
}

/* ---------- router ---------- */
function route(){
  const raw=location.hash.replace(/^#\/?/,'');
  const[name,qs]=raw.split('?');
  const v=VIEWS.includes(name)?name:'home';
  currentView=v;
  document.querySelectorAll('[data-view]').forEach(s=>{s.hidden=s.dataset.view!==v});
  document.querySelectorAll('[data-route]').forEach(a=>{if(a.dataset.route===v)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
  closeMenus();$('burger').replaceChildren(ico('menu'));
  window.scrollTo(0,0);
  document.title=(v==='home'?'':v[0].toUpperCase()+v.slice(1)+' · ')+'QROS Protocol';
  if(v==='bridge'&&qs){
    const p=new URLSearchParams(qs),f=Number(p.get('from')),t=Number(p.get('to'));
    if(chainOf(f)&&chainOf(t)&&f!==t)selectRoute(f,t);
  }
  enterView(v);
}
function enterView(v){
  if(v==='home')renderHome();
  else if(v==='bridge'){renderRouteInfo();refreshRouteInfo();loadClaimable();renderBanner()}
  else if(v==='activity'){renderActivity();loadClaimable();trackAll()}
  else if(v==='networks'){refreshNetStatus()}
  else if(v==='docs'){renderDocs();loadBridgeInfo(QMS.id).then(()=>{if(currentView==='docs')renderDocs()}).catch(()=>{})}
}
function renderAll(){renderSides();renderBanner();renderQuote();renderWalletBtn();refreshViews();if(currentView==='bridge')renderRouteInfo()}

/* resume the most recent unfinished transfer after a refresh */
function resumeLive(){
  if(S.liveEntry||!S.account)return;
  const x=myEntries().find(e=>!isFinal(e)&&Date.now()-e.ts<6*3600*1000);
  if(!x)return;
  steps=[];S.liveEntry=x.txIn||x.id;S.showNew=true;
  drawProgress('Transfer in progress: '+x.amtIn+' '+x.sym+' → '+x.outSym);
}

/* ---------- wiring ---------- */
$('fromChain').onclick=()=>pickChain('from');
$('toChain').onclick=()=>pickChain('to');
$('fromTok').onclick=()=>pickToken('from');
$('toTok').onclick=()=>pickToken('to');
$('flip').onclick=flip;
$('walletBtn').onclick=()=>S.account?walletMenu():connect();
$('netPill').onclick=pickWalletNetwork;
$('settingsBtn').onclick=openSettings;
$('themeBtn').onclick=cycleTheme;
$('moreBtn').onclick=toggleMore;
$('burger').onclick=toggleDrawer;
$('dlgClose').onclick=()=>$('dlg').close();
$('dlg').addEventListener('click',e=>{if(e.target===$('dlg'))$('dlg').close()});
$('dlg').addEventListener('close',()=>{S.openEntry=null});
document.addEventListener('click',e=>{if(!e.target.closest('.menu-wrap'))$('moreMenu').hidden=true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenus()});
addEventListener('hashchange',route);
$('amt').addEventListener('input',e=>{
  let v=e.target.value.replace(',','.').replace(/[^\d.]/g,'');
  const p=v.split('.');if(p.length>2)v=p[0]+'.'+p.slice(1).join('');
  const d=fromTok().decimals;if(p[1]&&p[1].length>d)v=p[0]+'.'+p[1].slice(0,d);
  e.target.value=v;S.amount=v;scheduleQuote();
});
$('maxBtn').onclick=()=>{
  const f=fromTok(),b=balOf(S.from.chainId,f);if(!b)return;
  let v=b;if(f.native)v=b>GAS_RESERVE?b-GAS_RESERVE:0n;
  S.amount=formatUnits(v,f.decimals);$('amt').value=S.amount;scheduleQuote();
};
$('recipToggle').onclick=()=>{
  S.useRecipient=!S.useRecipient;
  $('recip').classList.toggle('show',S.useRecipient);
  $('recipToggle').textContent=S.useRecipient?'Send to my connected wallet':'Send to a different address';
  if(!S.useRecipient){S.recipient='';$('recipIn').value=''}
  scheduleQuote();
};
$('recipIn').addEventListener('input',e=>{
  S.recipient=e.target.value.trim();
  e.target.classList.toggle('bad',!!S.recipient&&!isAddr(S.recipient));
  scheduleQuote();
});

(async function init(){
  buildChrome();
  // placeholder render so the shell never looks empty while chains load
  S.chains=baseChains();renderAll();route();
  await loadChains();
  renderAll();scheduleQuote();enterView(currentView);
  setTimeout(async()=>{
    const saved=LS.get('tetrixbridge.wallet');
    if(saved){const w=walletList().find(x=>(x.info.rdns||x.info.name)===saved);if(w)await useWallet(w,true)}
    resumeLive();
  },350);
  trackAll();
})();
