'use strict';
/* QROS Gateway dashboard. Read-only until verified deployment config is supplied. */
(function(){
  const ABI=[
    'function getBalance(address user,address asset) view returns (uint256 available,uint256 inTransit,uint256 reserved,uint256 deployed)',
    'function deposit(address asset,uint256 amount) returns (uint256 received)',
    'function withdraw(address asset,uint256 amount,address recipient)',
    'function supportedAssets(address asset) view returns (bool)',
    'event OutboundTransferFinalized(bytes32 indexed transferId,address indexed adapter,uint256 amount)',
    'event OutboundTransferCancelled(bytes32 indexed transferId,address indexed user,uint256 amount)',
    'event OutboundTransferRecovered(bytes32 indexed transferId,address indexed user,uint256 amount)',
    'event InboundTransferCredited(bytes32 indexed transferId,address indexed user,address indexed asset,uint256 amount,uint256 sourceChainId)'
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
  const COORDINATOR_ABI=[
    'function requestTransfer(bytes32 transferId,address asset,uint256 amount,uint256 destinationChainId,address destinationAsset,address recipient,address adapter)',
    'function initiate(bytes32 transferId)',
    'event TransferRequested(bytes32 indexed transferId,address indexed user,address indexed asset,uint256 amount,uint256 destinationChainId,address adapter)',
    'event TransferInitiated(bytes32 indexed transferId,address indexed adapter)',
    'event OutboundTransferFinalized(bytes32 indexed transferId,address indexed adapter,uint256 amount)',
    'event OutboundTransferCancelled(bytes32 indexed transferId,address indexed user,uint256 amount)',
    'event OutboundTransferRecovered(bytes32 indexed transferId,address indexed user,uint256 amount)',
    'event InboundTransferCredited(bytes32 indexed transferId,address indexed user,address indexed asset,uint256 amount,uint256 sourceChainId)'
  ];
  let pendingTransferId=null;
  function configuredRoutes(){
    const c=cfg();
    return Array.isArray(c.routes)?c.routes.filter(r=>r.sourceAsset&&r.destinationAsset&&r.adapter&&Number(r.destinationChainId)>0&&ethers.isAddress(r.sourceAsset)&&ethers.isAddress(r.destinationAsset)&&ethers.isAddress(r.adapter)):[];
  }
  function renderTransferOptions(){
    const routes=configuredRoutes(),assetSelect=$g('gatewayTransferAsset'),routeSelect=$g('gatewayTransferRoute'),destSelect=$g('gatewayTransferDestinationAsset');
    if(!assetSelect||!routeSelect||!destSelect)return;
    const assets=cfg().assets||[];
    const oldAsset=assetSelect.value,oldRoute=routeSelect.value;
    assetSelect.replaceChildren();routeSelect.replaceChildren();destSelect.replaceChildren();
    for(const a of assets){if(!ethers.isAddress(a.address||''))continue;const o=document.createElement('option');o.value=a.address;o.textContent=(a.symbol||'Asset')+' · '+a.address.slice(0,6)+'…';assetSelect.append(o)}
    const filtered=routes.filter(r=>!assetSelect.value||r.sourceAsset.toLowerCase()===assetSelect.value.toLowerCase());
    for(const r of filtered){const o=document.createElement('option');o.value=r.id||[r.destinationChainId,r.destinationAsset,r.adapter].join(':');o.textContent=r.label||('Chain '+r.destinationChainId);routeSelect.append(o)}
    if([...assetSelect.options].some(o=>o.value.toLowerCase()===oldAsset.toLowerCase()))assetSelect.value=oldAsset;
    const selected=routes.find(r=>(r.id||[r.destinationChainId,r.destinationAsset,r.adapter].join(':'))===routeSelect.value)||filtered[0];
    if(selected){const o=document.createElement('option');o.value=selected.destinationAsset;o.textContent=selected.destinationSymbol||selected.destinationAsset;destSelect.append(o)}
    else{const o=document.createElement('option');o.textContent='No configured route';o.value='';destSelect.append(o)}
  }
  async function requestGatewayTransfer(){
    setBusy(true);const b=$g('gatewayTransferButton');if(b)b.disabled=true;
    const msg=$g('gatewayTransferMessage');if(msg)msg.textContent='';
    try{
      const routes=configuredRoutes(),asset=selectedAsset('gatewayTransferAsset');
      const route=routes.find(r=>(r.id||[r.destinationChainId,r.destinationAsset,r.adapter].join(':'))===$g('gatewayTransferRoute')?.value);
      if(!asset||!route)throw new Error('No verified Gateway transfer route is configured for this source asset.');
      const amount=parseAmount($g('gatewayTransferAmount')?.value,Number(asset.decimals??6));
      const recipient=($g('gatewayTransferRecipient')?.value||'').trim();
      if(!ethers.isAddress(recipient))throw new Error('Enter a valid destination wallet address.');
      const c=cfg();
      if(!c.coordinator||!ethers.isAddress(c.coordinator))throw new Error('Gateway transfer coordinator is not configured.');
      const {signer,ledger}=await transactionContext();
      if(!(await ledger.supportedAssets(asset.address)))throw new Error('Source asset is not enabled in the Gateway ledger.');
      const owner=await signer.getAddress(),balance=await ledger.getBalance(owner,asset.address);
      if(balance.available<amount)throw new Error('Insufficient available Gateway balance.');
      const id=ethers.hexlify(ethers.randomBytes(32));
      const coordinator=new ethers.Contract(c.coordinator,COORDINATOR_ABI,signer);
      status('Review transfer request in wallet…','loading');
      message('This reserves the selected amount in Gateway. Settlement initiation requires a separate wallet confirmation.');
      const tx=await coordinator.requestTransfer(id,asset.address,amount,Number(route.destinationChainId),route.destinationAsset,recipient,route.adapter);
      if(msg)msg.textContent='Transfer request submitted: '+tx.hash;
      await tx.wait();
      pendingTransferId=id;
      if($g('gatewayInitiateButton'))$g('gatewayInitiateButton').hidden=false;
      if(msg)msg.textContent='Transfer reserved on Gateway. Review and initiate settlement as a separate transaction.';
      $g('gatewayTransferAmount').value='';await refresh();
      await refreshTransferHistory();
    }catch(e){if(msg)msg.textContent=e?.shortMessage||e?.reason||e?.message||'Transfer request failed.';status('Transfer not requested','error')}
    finally{setBusy(false);if(b)b.disabled=false}
  }
  async function initiateGatewayTransfer(){
    if(!pendingTransferId)throw new Error('No pending transfer request in this session.');
    const b=$g('gatewayInitiateButton'),msg=$g('gatewayTransferMessage');if(b)b.disabled=true;
    try{
      const c=cfg();if(!c.coordinator||!ethers.isAddress(c.coordinator))throw new Error('Gateway coordinator is not configured.');
      const {signer}=await transactionContext(),coordinator=new ethers.Contract(c.coordinator,COORDINATOR_ABI,signer);
      status('Confirm settlement initiation in wallet…','loading');
      const tx=await coordinator.initiate(pendingTransferId);
      if(msg)msg.textContent='Settlement initiation submitted: '+tx.hash;
      await tx.wait();if(msg)msg.textContent='Settlement initiation confirmed. Destination delivery remains pending independent verification.';
      pendingTransferId=null;if(b)b.hidden=true;await refreshTransferHistory();status('Transfer initiated · awaiting settlement','ready');
    }catch(e){if(msg)msg.textContent=e?.shortMessage||e?.reason||e?.message||'Could not initiate settlement.';status('Initiation not completed','error')}
    finally{if(b)b.disabled=false}
  }
  async function refreshTransferHistory(){
    const root=$g('gatewayTransferHistory'),c=cfg();if(!root||!c.coordinator||!ethers.isAddress(c.coordinator)||typeof S==='undefined'||!S.provider||!S.account)return;
    try{
      const provider=new ethers.BrowserProvider(S.provider),contract=new ethers.Contract(c.coordinator,COORDINATOR_ABI,provider);
      const latest=await provider.getBlockNumber();const events=await contract.queryFilter(contract.filters.TransferRequested(null,S.account),Math.max(0,latest-5000),latest);
      root.replaceChildren();
      if(!events.length){root.textContent='No Gateway transfer requests found in the recent event window.';return}
      for(const ev of events.slice(-20).reverse()){
        const row=document.createElement('div');row.className='gateway-asset';const id=document.createElement('b');id.textContent=ev.args.transferId.slice(0,10)+'…';
        const detail=document.createElement('span');const asset=(c.assets||[]).find(a=>a.address?.toLowerCase()===ev.args.asset.toLowerCase());
        detail.textContent='Chain '+ev.args.destinationChainId+' · '+ethers.formatUnits(ev.args.amount,Number(asset?.decimals??18))+' '+(asset?.symbol||'tokens');
        const state=document.createElement('span');state.textContent='Requested · funds reserved in Gateway';
        try{
          const ledger=new ethers.Contract(c.ledger,ABI,provider);
          const end=latest;
          const finalized=await ledger.queryFilter(ledger.filters.OutboundTransferFinalized(ev.args.transferId),ev.blockNumber,end);
          const cancelled=await ledger.queryFilter(ledger.filters.OutboundTransferCancelled(ev.args.transferId),ev.blockNumber,end);
          const recovered=await ledger.queryFilter(ledger.filters.OutboundTransferRecovered(ev.args.transferId),ev.blockNumber,end);
          const initiated=await contract.queryFilter(contract.filters.TransferInitiated(ev.args.transferId),ev.blockNumber,end);
          if(recovered.length)state.textContent='Recovered · returned to available balance';
          else if(cancelled.length)state.textContent='Cancelled · returned to available balance';
          else if(finalized.length)state.textContent='Source dispatched · destination proof still required';
          else if(initiated.length)state.textContent='Initiation recorded · awaiting source dispatch';
        }catch{}
        row.append(id,detail,state);root.append(row);
      }
    }catch(e){root.textContent='Transfer history unavailable: '+(e?.shortMessage||e?.message||'RPC query failed')}
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
      renderAssets(items);renderAssetSelectors(items);renderTransferOptions();
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

  const EXECUTION_ROUTER_ABI=[
    'function nonces(address user) view returns (uint256)',
    'function approvedStrategies(bytes32 strategyId) view returns (bool)',
    'function ledger() view returns (address)',
    'function execute((address user,address asset,uint256 amount,bytes32 strategyId,bytes32 adapterDataHash,uint256 nonce,uint256 deadline) i,bytes adapterData,bytes signature) returns (bytes32 executionId,bytes32 positionId)'
  ];
  const EXECUTION_ADAPTER_ABI=[
    'function allowedPoolFees(uint24 fee) view returns (bool)',
    'function allowedSwapFees(uint24 fee) view returns (bool)',
    'function allowedStrategyPairs(bytes32 key) view returns (bool)'
  ];
  const EXECUTION_LEDGER_ABI=[
    'function executionAdapter() view returns (address)',
    'function getBalance(address user,address asset) view returns (uint256 available,uint256 inTransit,uint256 reserved,uint256 deployed)'
  ];
  let executionPanelReady=false;
  function executionElement(tag,attrs={},label){
    const el=document.createElement(tag);
    for(const [k,v] of Object.entries(attrs))if(k==='text')el.textContent=v;else if(k==='className')el.className=v;else el.setAttribute(k,v);
    if(label!==undefined)el.textContent=label;
    return el;
  }
  function renderGatewayExecution(){
    const layout=document.querySelector('#view-gateway .gateway-layout');
    if(!layout)return;
    let panel=$g('gatewayExecutionPanel');
    if(!panel){
      panel=executionElement('section',{id:'gatewayExecutionPanel',className:'gateway-panel',style:'margin-top:16px'});
      const title=executionElement('h3',{},'Uniswap V3 liquidity execution');
      const intro=executionElement('p',{},'Choose an approved strategy and authorize a bounded execution from your available Gateway balance. The Uniswap position NFT is sent directly to your wallet.');
      const form=executionElement('div',{className:'gateway-form'});
      const fields=[
        ['gatewayExecAmount','Amount from Gateway','text','0.00'],
        ['gatewayExecSwapAmount','Amount to swap','text','0.00'],
        ['gatewayExecMinSwapOut','Minimum swap output','text','0.00'],
        ['gatewayExecMin0','Minimum token0 in position','text','0.00'],
        ['gatewayExecMin1','Minimum token1 in position','text','0.00']
      ];
      for(const [id,label,type,placeholder] of fields){
        form.append(executionElement('label',{for:id},label));
        const input=executionElement('input',{id,type,inputmode:'decimal',placeholder,autocomplete:'off'});
        form.append(input);
      }
      const summary=executionElement('div',{id:'gatewayExecStrategySummary',className:'gateway-note'});
      const button=executionElement('button',{id:'gatewayExecSubmit',type:'button',className:'btn solid'},'Review and sign execution');
      const messageEl=executionElement('p',{id:'gatewayExecMessage',role:'status',style:'font-size:12px'});
      form.append(summary,button,messageEl);
      const positions=executionElement('div',{className:'gateway-position-list'});
      const positionHead=executionElement('div',{style:'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px'});
      positionHead.append(executionElement('h3',{},'Your Uniswap positions'));
      const positionRefresh=executionElement('button',{id:'gatewayPositionRefresh',type:'button',className:'btn sm'},'Refresh positions');
      positionHead.append(positionRefresh);
      const positionBody=executionElement('div',{id:'gatewayPositions',className:'gateway-empty'},'Connect your wallet and configure a position registry to view positions.');
      panel.append(title,intro,form,positionHead,positionBody);
      positionRefresh.addEventListener('click',refreshGatewayPositions);
      layout.after(panel);
      button.addEventListener('click',submitGatewayExecution);
    }
    const x=cfg().execution;
    const summary=$g('gatewayExecStrategySummary');
    if(!x||!x.router||!x.adapter||!x.strategyId||!x.asset||!x.token0||!x.token1){
      summary.textContent='Execution is not enabled in this deployment. A verified execution router, adapter, strategy ID, token pair, pool configuration and fee approvals are required.';
      $g('gatewayExecSubmit').disabled=true;
      return;
    }
    summary.textContent=(x.label||'Configured strategy')+' · '+(x.symbol0||'token0')+'/'+(x.symbol1||'token1')+
      ' · LP fee '+x.poolFee+' · swap fee '+x.swapFee+' · ticks '+x.tickLower+' to '+x.tickUpper+
      '. Only the configured strategy pair and fee tiers can execute.';
    $g('gatewayExecSubmit').disabled=false;
    executionPanelReady=true;
  }
  async function submitGatewayExecution(){
    const button=$g('gatewayExecSubmit'),messageEl=$g('gatewayExecMessage'),x=cfg().execution;
    if(!x)return;
    button.disabled=true;messageEl.textContent='Preparing signed execution…';
    try{
      const {provider,signer,ledger}=await transactionContext();
      const user=await signer.getAddress();
      const routerAddress=x.router,adapterAddress=x.adapter;
      if(!ethers.isAddress(routerAddress)||!ethers.isAddress(adapterAddress))throw new Error('Execution router or adapter address is invalid.');
      const [routerCode,adapterCode]=await Promise.all([provider.getCode(routerAddress),provider.getCode(adapterAddress)]);
      if(routerCode==='0x'||adapterCode==='0x')throw new Error('Configured execution router or adapter has no contract code.');
      const router=new ethers.Contract(routerAddress,EXECUTION_ROUTER_ABI,signer);
      const ledgerRead=new ethers.Contract(await ledger.getAddress(),EXECUTION_LEDGER_ABI,provider);
      const [configuredLedger,configuredAdapter]=await Promise.all([router.ledger(),ledgerRead.executionAdapter()]);
      if(configuredLedger.toLowerCase()!==(await ledger.getAddress()).toLowerCase())throw new Error('Execution router points to a different Gateway ledger.');
      if(configuredAdapter.toLowerCase()!==adapterAddress.toLowerCase())throw new Error('Configured Uniswap adapter does not match the ledger execution adapter.');
      if(!ethers.isHexString(x.strategyId,32))throw new Error('Execution strategy ID must be a bytes32 value.');
      if(!(await router.approvedStrategies(x.strategyId)))throw new Error('This execution strategy is not approved on-chain.');
      const token0=ethers.getAddress(x.token0),token1=ethers.getAddress(x.token1),asset=ethers.getAddress(x.asset);
      if(token0.toLowerCase()>=token1.toLowerCase()||![token0.toLowerCase(),token1.toLowerCase()].includes(asset.toLowerCase()))throw new Error('Strategy token pair or input asset is invalid.');
      if(!(await ledger.supportedAssets(asset)))throw new Error('Execution input asset is not enabled in the Gateway ledger.');
      const adapterRead=new ethers.Contract(adapterAddress,EXECUTION_ADAPTER_ABI,provider);
      const pairKey=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32','address','address'],[x.strategyId,token0,token1]));
      const [pairApproved,poolFeeApproved,swapFeeApproved]=await Promise.all([
        adapterRead.allowedStrategyPairs(pairKey),adapterRead.allowedPoolFees(Number(x.poolFee)),adapterRead.allowedSwapFees(Number(x.swapFee))
      ]);
      if(!pairApproved||!poolFeeApproved||!swapFeeApproved)throw new Error('This token pair or Uniswap fee tier is not approved by the configured execution adapter.');
      const d0=Number(x.decimals0??6),d1=Number(x.decimals1??6),inputDecimals=Number(x.decimals??(asset.toLowerCase()===token0.toLowerCase()?d0:d1));
      const amount=parseAmount($g('gatewayExecAmount').value,inputDecimals);
      const swapAmount=parseAmount($g('gatewayExecSwapAmount').value,inputDecimals);
      const outputDecimals=asset.toLowerCase()===token0.toLowerCase()?d1:d0;
      const minSwapOut=parseAmount($g('gatewayExecMinSwapOut').value,outputDecimals);
      const amount0Min=parseAmount($g('gatewayExecMin0').value,d0);
      const amount1Min=parseAmount($g('gatewayExecMin1').value,d1);
      if(swapAmount===0n||swapAmount>=amount)throw new Error('Swap amount must be greater than zero and less than the total input.');
      const balance=await ledger.getBalance(user,asset);
      if(balance.available<amount)throw new Error('Insufficient available Gateway balance for this execution.');
      const deadline=BigInt(Math.floor(Date.now()/1000)+600);
      const params=[
        token0,token1,Number(x.poolFee),Number(x.swapFee),swapAmount,minSwapOut,
        Number(x.tickLower),Number(x.tickUpper),amount0Min,amount1Min,deadline
      ];
      const adapterData=ethers.AbiCoder.defaultAbiCoder().encode(
        ['tuple(address token0,address token1,uint24 poolFee,uint24 swapFee,uint256 swapAmount,uint256 minSwapOut,int24 tickLower,int24 tickUpper,uint256 amount0Min,uint256 amount1Min,uint256 deadline)'],
        [params]
      );
      const strategyId=x.strategyId;
      const nonce=await router.nonces(user);
      const intent={
        user,asset,amount,strategyId,adapterDataHash:ethers.keccak256(adapterData),nonce,deadline
      };
      const network=await provider.getNetwork();
      if(x.chainId!==undefined&&BigInt(x.chainId)!==network.chainId)throw new Error('Execution strategy is configured for a different chain.');
      const domain={name:'QROS Execution Router',version:'1',chainId:network.chainId,verifyingContract:routerAddress};
      const types={ExecutionIntent:[
        {name:'user',type:'address'},{name:'asset',type:'address'},{name:'amount',type:'uint256'},
        {name:'strategyId',type:'bytes32'},{name:'adapterDataHash',type:'bytes32'},
        {name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}
      ]};
      messageEl.textContent='Review the exact strategy parameters and sign the authorization in your wallet.';
      const signature=await signer.signTypedData(domain,types,intent);
      messageEl.textContent='Authorization signed. Confirm execution submission in your wallet.';
      const tx=await router.execute(intent,adapterData,signature);
      messageEl.textContent='Execution submitted: '+tx.hash;
      await tx.wait();
      messageEl.textContent='Execution confirmed. Check your wallet for the Uniswap V3 position NFT and refresh Gateway balances.';
      for(const id of ['gatewayExecAmount','gatewayExecSwapAmount','gatewayExecMinSwapOut','gatewayExecMin0','gatewayExecMin1'])$g(id).value='';
      await refresh();
      await refreshGatewayPositions();
    }catch(e){
      messageEl.textContent=e?.shortMessage||e?.reason||e?.message||'Execution was not completed.';
    }finally{button.disabled=false}
  }

  async function refreshGatewayPositions(){
    const root=$g('gatewayPositions'),x=cfg().execution;
    if(!root)return;
    if(!x?.positionRegistry||!ethers.isAddress(x.positionRegistry)){
      root.textContent='Position registry is not configured for this deployment.';
      return;
    }
    if(typeof S==='undefined'||!S.account||!S.provider){root.textContent='Connect your wallet to view positions.';return}
    try{
      const provider=new ethers.BrowserProvider(S.provider);
      const registry=new ethers.Contract(x.positionRegistry,[
        'function getUserPositions(address user) view returns (bytes32[])',
        'function getPosition(bytes32 positionId) view returns ((address user,uint256 chainId,address positionManager,uint256 tokenId,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint8 status,uint64 createdAt))'
      ],provider);
      const ids=await registry.getUserPositions(S.account);
      root.replaceChildren();
      if(!ids.length){root.className='gateway-empty';root.textContent='No Uniswap V3 positions are registered to this wallet on this chain.';return}
      root.className='gateway-position-list';
      for(const id of ids.slice().reverse()){
        const p=await registry.getPosition(id);
        const card=executionElement('div',{className:'gateway-asset',style:'grid-template-columns:minmax(0,1fr) minmax(0,1fr);margin-top:8px'});
        const title=executionElement('b',{},(p.token0.slice(0,6)+'… / '+p.token1.slice(0,6)+'…'));
        const status=['Unknown','Active','Closing','Closed'][Number(p.status)]||'Unknown';
        const detail=executionElement('span',{},'NFT #'+p.tokenId+' · fee '+p.fee+' · liquidity '+p.liquidity);
        const range=executionElement('span',{},'Ticks '+p.tickLower+' to '+p.tickUpper+' · '+status);
        const idText=executionElement('span',{},id.slice(0,10)+'…');
        card.append(title,detail,range,idText);root.append(card);
      }
    }catch(e){root.textContent='Position lookup failed: '+(e?.shortMessage||e?.message||'RPC error')}
  }
  window.qrosGatewayRefresh=refresh;
  window.qrosGatewayPositionsRefresh=refreshGatewayPositions;
  document.addEventListener('DOMContentLoaded',()=>{
    renderGatewayExecution();
    const b=$g('gatewayRefresh');if(b)b.addEventListener('click',refresh);
    const d=$g('gatewayDepositButton');if(d)d.addEventListener('click',deposit);
    const w=$g('gatewayWithdrawButton');if(w)w.addEventListener('click',withdraw);
    const t=$g('gatewayTransferButton');if(t)t.addEventListener('click',requestGatewayTransfer);
    const i=$g('gatewayInitiateButton');if(i)i.addEventListener('click',initiateGatewayTransfer);
    const a=$g('gatewayTransferAsset');if(a)a.addEventListener('change',renderTransferOptions);
    const r=$g('gatewayTransferRoute');if(r)r.addEventListener('change',renderTransferOptions);
    renderAssetSelectors(cfg().assets||[]);renderTransferOptions();renderGatewayExecution();refreshGatewayPositions();
  });
  window.addEventListener('qros:wallet-updated',refresh);
})();