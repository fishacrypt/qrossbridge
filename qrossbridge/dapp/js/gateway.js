'use strict';
/* QROS Gateway dashboard. Read-only until verified deployment config is supplied. */
(function(){
  const ABI=[
    'function getBalance(address user,address asset) view returns (uint256 available,uint256 inTransit,uint256 reserved,uint256 deployed)',
    'function deposit(address asset,uint256 amount) returns (uint256 received)',
    'function withdraw(address asset,uint256 amount,address recipient)',
    'function supportedAssets(address asset) view returns (bool)'
  ];
  const TOKEN_ABI=['function allowance(address owner,address spender) view returns (uint256)','function approve(address spender,uint256 amount) returns (bool)','function decimals() view returns (uint8)','function balanceOf(address owner) view returns (uint256)'];
  const cfg=()=>window.QROS_GATEWAY_CONFIG||{};
  const $g=id=>document.getElementById(id);
  let busy=false;
  const fmt=(v,d=6)=>{try{const n=ethers.formatUnits(v,d);return Number(n).toLocaleString(undefined,{maximumFractionDigits:6})}catch{return '—'}};
  function status(text,state){const el=$g('gatewayStatus');if(el){el.textContent=text;el.dataset.state=state||'idle'}}
  function set(id,value){const el=$g(id);if(el)el.textContent=value}
  function renderAssetSelectors(items){
    for(const id of ['gatewayDepositAsset','gatewayWithdrawAsset']){
      const el=$g(id);if(!el)continue;
      const previous=el.value;el.replaceChildren();
      for(const a of items){if(!a.address||!ethers.isAddress(a.address))continue;const o=document.createElement('option');o.value=a.address;o.textContent=a.symbol||a.address;el.append(o)}
      if(items.some(a=>a.address.toLowerCase()===previous.toLowerCase()))el.value=previous;
    }
  }
  function selectedAsset(id){const c=cfg(),address=$g(id)?.value;return (c.assets||[]).find(a=>a.address?.toLowerCase()===String(address||'').toLowerCase())}
  function setBusy(v){for(const id of ['gatewayDepositButton','gatewayWithdrawButton']){const b=$g(id);if(b)b.disabled=v}}
  function message(text,error=false){const m=$g('gatewayMessage');if(m){m.textContent=text;m.classList.toggle('gateway-error',error)}}
  function parseAmount(value,decimals){
    if(!/^\\d+(\\.\\d+)?$/.test(String(value||'')))throw new Error('Enter a valid positive amount.');
    const [whole,fraction='']=String(value).split('.');
    if(fraction.length>decimals)throw new Error('This token supports up to '+decimals+' decimal places.');
    const amount=ethers.parseUnits(value,decimals);if(amount<=0n)throw new Error('Amount must be greater than zero.');
    return amount;
  }
  async function transactionContext(){
    const c=cfg();
    if(typeof S==='undefined'||!S.account||!S.provider)throw new Error('Connect your wallet first.');
    if(!c.ledger||!ethers.isAddress(c.ledger))throw new Error('Gateway ledger address is not configured.');
    if(!Number.isInteger(Number(c.chainId)))throw new Error('Gateway chain ID is not configured.');
    if(Number(S.walletChain)!==Number(c.chainId))throw new Error('Switch your wallet to the configured Gateway network.');
    const provider=new ethers.BrowserProvider(S.provider);
    const signer=await provider.getSigner();
    return {provider,signer,ledger:new ethers.Contract(c.ledger,ABI,signer)};
  }
  async function deposit(){
    setBusy(true);message('');
    try{
      const a=selectedAsset('gatewayDepositAsset');if(!a)throw new Error('No supported Gateway asset is configured.');
      const decimals=Number(a.decimals??6),amount=parseAmount($g('gatewayDepositAmount')?.value,decimals);
      const {signer,ledger}=await transactionContext();
      if(!(await ledger.supportedAssets(a.address)))throw new Error('This asset is not enabled in the Gateway ledger.');
      const token=new ethers.Contract(a.address,TOKEN_ABI,signer),owner=await signer.getAddress();
      const allowance=await token.allowance(owner,await ledger.getAddress());
      if(allowance<amount){
        status('Approve token in wallet…','loading');message('Approve the token first. A second wallet confirmation will submit the deposit.');
        const approval=await token.approve(await ledger.getAddress(),amount);await approval.wait();
      }
      status('Confirm deposit in wallet…','loading');
      const tx=await ledger.deposit(a.address,amount);message('Deposit submitted: '+tx.hash);
      await tx.wait();message('Deposit confirmed. Your funds are now available in Gateway.');
      $g('gatewayDepositAmount').value='';await refresh();
    }catch(e){message(e?.shortMessage||e?.reason||e?.message||'Deposit failed.',true);status('Deposit not completed','error')}
    finally{setBusy(false)}
  }
  async function withdraw(){
    setBusy(true);message('');
    try{
      const a=selectedAsset('gatewayWithdrawAsset');if(!a)throw new Error('No supported Gateway asset is configured.');
      const decimals=Number(a.decimals??6),amount=parseAmount($g('gatewayWithdrawAmount')?.value,decimals);
      const {signer,ledger}=await transactionContext();
      if(!(await ledger.supportedAssets(a.address)))throw new Error('This asset is not enabled in the Gateway ledger.');
      const recipient=($g('gatewayWithdrawRecipient')?.value||'').trim()||await signer.getAddress();
      if(!ethers.isAddress(recipient))throw new Error('Enter a valid recipient address.');
      const owner=await signer.getAddress(),b=await ledger.getBalance(owner,a.address);
      if(b.available<amount)throw new Error('Insufficient available Gateway balance.');
      status('Confirm withdrawal in wallet…','loading');
      const tx=await ledger.withdraw(a.address,amount,recipient);message('Withdrawal submitted: '+tx.hash);
      await tx.wait();message('Withdrawal confirmed on the Gateway network.');
      $g('gatewayWithdrawAmount').value='';await refresh();
    }catch(e){message(e?.shortMessage||e?.reason||e?.message||'Withdrawal failed.',true);status('Withdrawal not completed','error')}
    finally{setBusy(false)}
  }
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
      renderAssets(items);renderAssetSelectors(items);
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
  document.addEventListener('DOMContentLoaded',()=>{
    const b=$g('gatewayRefresh');if(b)b.addEventListener('click',refresh);
    const d=$g('gatewayDepositButton');if(d)d.addEventListener('click',deposit);
    const w=$g('gatewayWithdrawButton');if(w)w.addEventListener('click',withdraw);
    renderAssetSelectors(cfg().assets||[]);
  });
  window.addEventListener('qros:wallet-updated',refresh);
})();