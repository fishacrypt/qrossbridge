'use strict';
/* QROS Gateway dashboard. Read-only until verified deployment config is supplied. */
(function(){
  const ABI=['function getBalance(address user,address asset) view returns (uint256 available,uint256 inTransit,uint256 reserved,uint256 deployed)'];
  const cfg=()=>window.QROS_GATEWAY_CONFIG||{};
  const $g=id=>document.getElementById(id);
  let busy=false;
  const fmt=(v,d=6)=>{try{const n=ethers.formatUnits(v,d);return Number(n).toLocaleString(undefined,{maximumFractionDigits:6})}catch{return '—'}};
  function status(text,state){const el=$g('gatewayStatus');if(el){el.textContent=text;el.dataset.state=state||'idle'}}
  function set(id,value){const el=$g(id);if(el)el.textContent=value}
  function renderAssets(items){
    const root=$g('gatewayAssets');if(!root)return;
    root.replaceChildren();
    if(!items.length){root.innerHTML='<div class="gateway-empty">No assets configured. Add verified token addresses to the Gateway deployment configuration.</div>';return}
    for(const a of items){
      const row=document.createElement('div');row.className='gateway-asset';
      const name=document.createElement('b');name.textContent=a.symbol||'Asset';
      row.append(name);
      for(const label of ['available','inTransit','reserved','deployed']){
        const val=document.createElement('span');val.dataset.balance=label;val.textContent='—';row.append(val);
      }
      row.dataset.asset=(a.address||'').toLowerCase();root.append(row);
    }
  }
  async function refresh(){
    if(busy)return;busy=true;
    try{
      const c=cfg(),items=Array.isArray(c.assets)?c.assets:[];
      renderAssets(items);
      if(typeof S==='undefined'||!S.account||!S.provider){status('Connect wallet to view balances','idle');set('gatewayOwner','Wallet not connected');return}
      set('gatewayOwner',S.account);
      if(!c.ledger||!ethers.isAddress(c.ledger)){status('Gateway contract not configured','idle');set('gatewayTotal','—');return}
      if(!items.length){status('Asset configuration required','idle');return}
      status('Reading Gateway ledger…','loading');
      const provider=new ethers.BrowserProvider(S.provider);
      const ledger=new ethers.Contract(c.ledger,ABI,provider);
      let firstBalances=null;
      for(const a of items){
        if(!ethers.isAddress(a.address))continue;
        const b=await ledger.getBalance(S.account,a.address);
        const vals=[b.available,b.inTransit,b.reserved,b.deployed];
        if(items.length===1)firstBalances=vals;
        const row=$g('gatewayAssets').querySelector('[data-asset="'+a.address.toLowerCase()+'"]');
        if(row)row.querySelectorAll('[data-balance]').forEach((el,i)=>el.textContent=fmt(vals[i],Number(a.decimals??6))+' '+(a.symbol||''));
      }
      set('gatewayTotal',items.length+' configured assets');
      if(items.length===1&&firstBalances){['available','inTransit','reserved','deployed'].forEach((k,i)=>{const el=document.querySelector('[data-gateway-metric="'+k+'"]');if(el)el.textContent=fmt(firstBalances[i],Number(items[0].decimals??6))+' '+(items[0].symbol||'')})}
      status('Ledger connected · read-only','ready');
    }catch(e){status('Unable to read Gateway ledger','error');const m=$g('gatewayMessage');if(m)m.textContent=e?.shortMessage||e?.message||'RPC read failed'}
    finally{busy=false}
  }
  window.qrosGatewayRefresh=refresh;
  document.addEventListener('DOMContentLoaded',()=>{const b=$g('gatewayRefresh');if(b)b.addEventListener('click',refresh)});
  window.addEventListener('qros:wallet-updated',refresh);
})();