'use strict';
/* QROS Stablecoin Execution UI.
   Separate from the native QMS bridge. Initial testnet route: QMS (19480) -> Base Sepolia (84532). */

const EXEC_CFG = {
  sourceChain: 19480,
  destinationChain: 84532,
  gateway: '0x9Bb95Ad4f02266C44728e54CEe8ab8E70aAe2683',
  vault: '0x4beA4C50Fa0b38F2951a169a19DD73116AD8d568',
  sourceAssets: {
    USDC: '0xDd4D61DF875cc613E1372c78827a5F4C2741bf11',
    USDT: '0x5D1386fC130143F92511bC2D18124D3E414ed429'
  },
  destinationAssets: {
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    USDT: '0x9Bb95Ad4f02266C44728e54CEe8ab8E70aAe2683'
  },
  strategyId: '0x' + '00'.repeat(32),
  historyKey: 'qros.execution.history.v1'
};
const EXEC_STATUS = {0:'Not found',1:'Pending',2:'Source settled',3:'Failed',4:'Refunded'};
const POS_STATUS = {0:'Not reserved',1:'Liquidity reserved',2:'Position active',3:'Position closed',4:'Reservation cancelled'};
let execAsset='USDC', execAmount='', execBusy=false, execTimer=null;

function exCall(signature, types=[], values=[]) {
  if (!window.ethers) throw new Error('Execution encoder unavailable. Reload the page and try again.');
  return ethers.id(signature).slice(0,10) + ethers.AbiCoder.defaultAbiCoder().encode(types,values).slice(2);
}
async function exRead(chainId,to,data,types) {
  const result=await rpc(chainOf(chainId),'eth_call',[{to,data},'latest']);
  return ethers.AbiCoder.defaultAbiCoder().decode(types,result);
}
const exUnits=s=>parseUnits(s,6);
const exFmt=v=>formatUnits(BigInt(v),6);
const exShort=s=>s?short(s):'—';
function exHistory(){try{return JSON.parse(localStorage.getItem(EXEC_CFG.historyKey)||'[]')}catch{return[]}}
function exSave(items){try{localStorage.setItem(EXEC_CFG.historyKey,JSON.stringify(items.slice(0,30)))}catch{}}
function exSetMessage(message,type='info'){
  const el=$('execMsg');if(!el)return;
  el.textContent=message;el.className='exec-message '+type;
}
function exPage(){
  if($('view-execution'))return;
  const section=h('section',{class:'view exec-view',id:'view-execution','data-view':'execution',hidden:true});
  section.append(
    h('div',{class:'page-h'},h('h1',{},'Stablecoin execution'),h('p',{},'Move stablecoins from QMS Testnet to prefunded liquidity on Base Sepolia. This is a separate testnet flow; it does not change native QMS bridging.')),
    h('div',{class:'exec-layout'},
      h('div',{class:'card exec-card'},
        h('div',{class:'card-h'},h('h3',{},'Create execution request'),h('span',{class:'badge acc'},'QMS → Base')),
        h('div',{class:'exec-route'},
          h('div',{class:'exec-chain'},h('span',{class:'exec-kicker'},'FROM'),h('b',{},'QMS Testnet'),h('small',{},'Chain 19480')),
          ico('arrow'),
          h('div',{class:'exec-chain'},h('span',{class:'exec-kicker'},'TO'),h('b',{},'Base Sepolia'),h('small',{},'Chain 84532'))),
        h('label',{class:'field',for:'execAsset'},'Stablecoin'),
        h('select',{id:'execAsset',class:'exec-select'},
          h('option',{value:'USDC'},'USDC'),
          h('option',{value:'USDT'},'USDT')),
        h('label',{class:'field',for:'execAmount'},'Amount'),
        h('div',{class:'exec-amount-wrap'},h('input',{id:'execAmount',class:'exec-amount',inputmode:'decimal',placeholder:'0.00',autocomplete:'off'}),h('span',{class:'exec-unit'},'USD')),
        h('div',{class:'exec-balances'},h('span',{id:'execSourceBalance'},'Wallet balance: connect wallet'),h('button',{class:'linkbtn',id:'execMax'},'MAX')),
        h('div',{class:'exec-preview',id:'execPreview'},h('div',{class:'kv'},h('span',{},'You send'),h('b',{id:'execSendPreview'},'—')),h('div',{class:'kv'},h('span',{},'Destination liquidity'),h('b',{id:'execLiquidity'},'Loading…')),h('div',{class:'kv'},h('span',{},'Protocol fee'),h('b',{},'0% (configured route)'))),
        h('p',{class:'exec-note'},'Strategy ID is the zero-bytes32 demo placeholder. This request does not deposit into an external yield protocol or generate yield.'),
        h('div',{id:'execMsg',class:'exec-message',role:'status'},'Connect your wallet to begin.'),
        h('button',{id:'execSubmit',class:'primary',disabled:true},'Connect wallet')),
      h('aside',{class:'card exec-side'},
        h('h3',{},'How execution works'),
        h('ol',{class:'exec-steps'},
          h('li',{},h('b',{},'Approve'),h('span',{},'Allow the QMS gateway to transfer the selected stablecoin.')),
          h('li',{},h('b',{},'Request'),h('span',{},'Submit the request on QMS Testnet.')),
          h('li',{},h('b',{},'Reserve'),h('span',{},'The separate execution worker reserves matching Base liquidity.')),
          h('li',{},h('b',{},'Settle and activate'),h('span',{},'The worker settles the source and activates your destination position.'))),
        h('p',{class:'exec-warning'},'Testnet only. Transactions require wallet approval and QMS gas. Liquidity is finite; requests may remain pending if the worker is offline or liquidity is unavailable.'))),
    h('div',{class:'section exec-history-section'},h('div',{class:'row wrapr'},h('h2',{},'Your execution requests'),h('button',{class:'mini',id:'execRefresh'},'Refresh status')),h('div',{id:'execHistory',class:'exec-history'},h('div',{class:'empty'},'No execution requests from this browser yet.')))
  );
  section.hidden=currentView!=='execution';
  $('view-home').parentElement.append(section);
  $('execAsset').addEventListener('change',e=>{execAsset=e.target.value;exRefreshView()});
  $('execAmount').addEventListener('input',e=>{execAmount=e.target.value.replace(',','.').replace(/[^\d.]/g,'');e.target.value=execAmount;exUpdatePreview()});
  $('execMax').onclick=async()=>{if(!S.account){toast('Connect your wallet first');return}try{const b=await exTokenBalance();$('execAmount').value=exFmt(b);execAmount=$('execAmount').value;exUpdatePreview()}catch(e){exSetMessage(e.message,'error')}};
  $('execSubmit').onclick=exSubmit;
  $('execRefresh').onclick=()=>exRefreshHistory(true);
}
function exRoute(){
  if(!S.account){$('execSourceBalance').textContent='Wallet balance: connect wallet';$('execSubmit').textContent='Connect wallet';$('execSubmit').disabled=false;return}
  $('execSubmit').textContent='Review execution';$('execSubmit').disabled=execBusy;
}
async function exTokenBalance(){
  if(!S.account)throw new Error('Connect your wallet first');
  const addr=EXEC_CFG.sourceAssets[execAsset];
  const [balance]=await exRead(EXEC_CFG.sourceChain,addr,exCall('balanceOf(address)',['address'],[S.account]),['uint256']);
  return BigInt(balance);
}
async function exRefreshView(){
  exPage();
  $('execAsset').value=execAsset;
  $('execSendPreview').textContent=execAmount?execAmount+' '+execAsset:'—';
  $('execSourceBalance').textContent='Wallet balance: loading…';
  $('execLiquidity').textContent='Loading…';
  try{
    const dest=EXEC_CFG.destinationAssets[execAsset];
    const [available]=await exRead(EXEC_CFG.destinationChain,EXEC_CFG.vault,exCall('availableLiquidity(address)',['address'],[dest]),['uint256']);
    $('execLiquidity').textContent=exFmt(available)+' '+execAsset+' available';
  }catch{$('execLiquidity').textContent='Unable to read vault liquidity'}
  if(S.account){
    try{$('execSourceBalance').textContent='Wallet balance: '+exFmt(await exTokenBalance())+' '+execAsset}
    catch{$('execSourceBalance').textContent='Wallet balance: unavailable'}
  }else $('execSourceBalance').textContent='Wallet balance: connect wallet';
  exRoute();
}
function exUpdatePreview(){
  $('execSendPreview').textContent=execAmount?execAmount+' '+execAsset:'—';
  exRoute();
}
async function exWaitReceipt(hash){
  return waitReceipt(hash,EXEC_CFG.sourceChain);
}
async function exRequestFromReceipt(hash){
  const receipt=await exWaitReceipt(hash);
  const topic=ethers.id('ExecutionRequested(bytes32,address,address,address,uint256,uint256,uint256,bytes32)').toLowerCase();
  const log=(receipt.logs||[]).find(x=>x.address.toLowerCase()===EXEC_CFG.gateway.toLowerCase()&&x.topics&&x.topics[0].toLowerCase()===topic);
  if(!log)throw new Error('Transaction confirmed, but the execution request event was not found. Keep the transaction hash.');
  return log.topics[1];
}
async function exSubmit(){
  if(execBusy)return;
  if(!S.account||!S.provider){await connect();return}
  const amount=exUnits(execAmount||'');
  if(amount===null||amount<=0n){exSetMessage('Enter a valid amount greater than zero.','error');return}
  execBusy=true;$('execSubmit').disabled=true;$('execSubmit').textContent='Preparing…';
  try{
    await ensureChain(EXEC_CFG.sourceChain);
    const asset=EXEC_CFG.sourceAssets[execAsset];
    const bal=await exTokenBalance();
    if(amount>bal)throw new Error('Insufficient '+execAsset+' balance in your wallet.');
    const allowance=await exRead(EXEC_CFG.sourceChain,asset,exCall('allowance(address,address)',['address','address'],[S.account,EXEC_CFG.gateway]),['uint256']);
    if(BigInt(allowance[0])<amount){
      exSetMessage('Approve '+execAsset+' in your wallet.','info');$('execSubmit').textContent='Approve token';
      const approveData=exCall('approve(address,uint256)',['address','uint256'],[EXEC_CFG.gateway,amount]);
      const approveHash=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:asset,data:approveData,value:'0x0'}]});
      await exWaitReceipt(approveHash);
    }
    exSetMessage('Confirm the execution request in your wallet.','info');$('execSubmit').textContent='Confirm request';
    const data=exCall('requestExecution(address,uint256,bytes32)',['address','uint256','bytes32'],[asset,amount,EXEC_CFG.strategyId]);
    const hash=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:EXEC_CFG.gateway,data,value:'0x0'}]});
    const item={hash,requestId:null,asset:execAsset,amount:amount.toString(),account:S.account.toLowerCase(),createdAt:Date.now()};
    exSave([item,...exHistory()]);
    exSetMessage('Request submitted: '+short(hash)+'. Waiting for QMS confirmation…','info');
    renderExecHistory();
    const requestId=await exRequestFromReceipt(hash);
    item.requestId=requestId;exSave([item,...exHistory().filter(x=>x.hash!==hash)]);
    exSetMessage('Request confirmed. Destination reservation and settlement are handled by the execution worker.','success');
    await exRefreshHistory(true);
    $('execAmount').value='';execAmount='';
  }catch(e){
    const er=walletError(e,chainOf(EXEC_CFG.sourceChain));
    exSetMessage(er.text||e.message||'Execution request failed.',er.rejected?'info':'error');
  }finally{
    execBusy=false;$('execSubmit').disabled=false;$('execSubmit').textContent=S.account?'Review execution':'Connect wallet';
    exRefreshView();
  }
}
async function exGetRequest(item){
  if(!item.requestId){
    const receipt=await rpc(chainOf(EXEC_CFG.sourceChain),'eth_getTransactionReceipt',[item.hash]);
    if(!receipt)return {label:'Confirming on QMS',detail:'Waiting for source-chain confirmation'};
    const topic=ethers.id('ExecutionRequested(bytes32,address,address,address,uint256,uint256,uint256,bytes32)').toLowerCase();
    const log=(receipt.logs||[]).find(x=>x.address.toLowerCase()===EXEC_CFG.gateway.toLowerCase()&&x.topics&&x.topics[0].toLowerCase()===topic);
    if(!log)return {label:'Confirmed · event unavailable',detail:'Check the QMS transaction'};
    item.requestId=log.topics[1];exSave(exHistory().map(x=>x.hash===item.hash?item:x));
  }
  const request=await exRead(EXEC_CFG.sourceChain,EXEC_CFG.gateway,exCall('requests(bytes32)',['bytes32'],[item.requestId]),['address','address','address','address','uint256','uint256','bytes32','uint8']);
  const position=await exRead(EXEC_CFG.destinationChain,EXEC_CFG.vault,exCall('positions(bytes32)',['bytes32'],[item.requestId]),['address','address','uint256','bytes32','uint8']);
  const gatewayStatus=Number(request[7]),positionStatus=Number(position[4]);
  let label=EXEC_STATUS[gatewayStatus]||'Unknown';
  if(gatewayStatus===2&&positionStatus===2)label='Complete · position active';
  else if(gatewayStatus===2)label='Source settled · '+(POS_STATUS[positionStatus]||'Destination pending');
  else if(gatewayStatus===1&&positionStatus===1)label='Liquidity reserved · settling';
  else if(gatewayStatus===1)label='Pending · awaiting liquidity';
  else if(gatewayStatus===3)label='Failed · refund available';
  return {label,detail:'Gateway: '+(EXEC_STATUS[gatewayStatus]||gatewayStatus)+' · Vault: '+(POS_STATUS[positionStatus]||positionStatus),gatewayStatus,positionStatus};
}
function renderExecHistory(){
  const root=$('execHistory');if(!root)return;
  const rows=exHistory().filter(x=>!S.account||x.account===S.account.toLowerCase());
  if(!rows.length){root.replaceChildren(h('div',{class:'empty'},'No execution requests from this browser yet.'));return}
  root.replaceChildren(...rows.map(item=>{
    const status=item.status||{label:'Loading status…'};
    const card=h('div',{class:'exec-history-item'},
      h('div',{class:'exec-history-main'},h('div',{},h('b',{},item.amount?exFmt(item.amount):'—',' ',item.asset),h('small',{},new Date(item.createdAt).toLocaleString())),h('span',{class:'exec-status'},status.label||status)),
      h('div',{class:'exec-history-meta'},h('span',{},'Request: '+exShort(item.requestId)),h('a',{href:txUrl(chainOf(EXEC_CFG.sourceChain),item.hash),target:'_blank',rel:'noopener'},'QMS transaction')),
      status.detail?h('small',{class:'muted'},status.detail):null);
    if(status.gatewayStatus===3&&item.requestId){
      card.append(h('button',{class:'mini',onclick:()=>exClaimRefund(item)},'Claim refund'));
    }
    return card;
  }));
}
async function exRefreshHistory(showToast=false){
  const items=exHistory().filter(x=>!S.account||x.account===S.account.toLowerCase());
  for(const item of items){
    try{item.status=await exGetRequest(item)}catch(e){item.status={label:'Status unavailable',detail:e.message}}
  }
  exSave(items.concat(exHistory().filter(x=>S.account&&x.account!==S.account.toLowerCase())));
  renderExecHistory();if(showToast)toast('Execution statuses refreshed');
}
async function exClaimRefund(item){
  try{
    await ensureChain(EXEC_CFG.sourceChain);
    const data=exCall('claimRefund(bytes32)',['bytes32'],[item.requestId]);
    const hash=await S.provider.request({method:'eth_sendTransaction',params:[{from:S.account,to:EXEC_CFG.gateway,data,value:'0x0'}]});
    await exWaitReceipt(hash);toast('Refund claimed');await exRefreshHistory(true);
  }catch(e){const er=walletError(e,chainOf(EXEC_CFG.sourceChain));toast(er.text||e.message)}
}
function renderExecutionPage(){
  exPage();exRefreshView();renderExecHistory();exRefreshHistory(false);
  if(execTimer)clearInterval(execTimer);
  execTimer=setInterval(()=>{if(currentView==='execution')exRefreshHistory(false)},15000);
}
