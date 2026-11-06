// Loads the REAL dapp in jsdom with a mock wallet against local chains + deployed contracts + a running relayer,
// then clicks through each QMS route type. Verifies the page's hand-encoded calldata matches the contracts.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ganache = require('ganache');
const { JSDOM, requestInterceptor } = require('jsdom');
const { ethers } = require('ethers');
const { Relayer } = require('../relayer/relayer');
const deploy = require('../scripts/deploy');
const { apply } = require('../scripts/apply-config');
const { HUB_ID, chains } = require('../scripts/chains');

const root = path.join(__dirname, '..');
const art = n => JSON.parse(fs.readFileSync(path.join(root, 'build', n + '.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const E = ethers.parseEther;
const waitFor = async (fn, ms = 40000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(150); } };

(async () => {
  const ids = Object.keys(chains).map(Number);
  const servers = {}, urls = {}, prov = {};
  let port = 18700;
  for (const id of ids) {
    servers[id] = ganache.server({ logging: { quiet: true }, chain: { chainId: id, networkId: id }, wallet: { deterministic: true, defaultBalance: 100000 } });
    await servers[id].listen(++port); urls[id] = 'http://127.0.0.1:' + port;
    prov[id] = new ethers.JsonRpcProvider(urls[id], id, { staticNetwork: true, cacheTimeout: -1 });
  }
  const accts = Object.entries(await servers[HUB_ID].provider.getInitialAccounts()).map(([a, v]) => ({ address: ethers.getAddress(a), key: v.secretKey }));
  const [deployer, relayerAcct, user] = accts;

  const mockA = art('MockWQMS');
  const wq = await (await new ethers.ContractFactory(mockA.abi, mockA.bytecode, new ethers.Wallet(deployer.key, prov[HUB_ID])).deploy()).waitForDeployment();
  const WQMS = await wq.getAddress();
  const env = {
  ...process.env,
  DEPLOYER_KEY: deployer.key,
  RELAYER_ADDRESS: relayerAcct.address,
  WQMS_ADDRESS: WQMS,
  DEPLOYMENTS_FILE: path.join(os.tmpdir(), `deployments-dapp-test-${process.pid}.json`)
};
  for (const id of ids) env['RPC_' + id] = urls[id];
  const log0 = console.log; console.log = () => {};
  const dep = await deploy.main(env);
  // The page is split into html + css + js files. Serve a temp copy of the whole dapp/ folder so the page loads
  // exactly as it does when deployed, with the freshly deployed contract addresses patched into the config block.
  const tmpDapp = fs.mkdtempSync(path.join(os.tmpdir(), 'qros-dapp-'));
  fs.cpSync(path.join(root, 'dapp'), path.join(tmpDapp, 'dapp'), { recursive: true });
  const tmpHtml = path.join(tmpDapp, 'dapp/tetrix-bridge.html');
  apply(tmpHtml, env.DEPLOYMENTS_FILE);
  // Serve dapp files from the temp copy; answer every external request (fonts) with an empty response.
  const localResources = {
    interceptors: [requestInterceptor(request => {
      const u = new URL(request.url);
      if (u.origin === 'http://localhost') {
        try { return new Response(fs.readFileSync(path.join(tmpDapp, u.pathname)), { headers: { 'Content-Type': u.pathname.endsWith('.css') ? 'text/css' : u.pathname.endsWith('.js') ? 'application/javascript' : 'text/html' } }); }
        catch { return new Response('not found', { status: 404 }); }
      }
      return new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } });
    })]
  };
  console.log = log0;

  const relayer = new Relayer({
    chains: Object.fromEntries(Object.entries(dep.chains).map(([id, c]) => [id, { name: chains[id].name, role: c.role, bridge: c.bridge, startBlock: c.startBlock, provider: prov[id] }])),
    hubChainId: HUB_ID, key: relayerAcct.key, confirmations: 0, maxRange: 100, log: () => {}
  });
  relayer.run(300);

  // ---- mock EIP-1193 wallet bound to `user`, forwarding to whichever local chain is selected
  let walletChain = 11155111;
  const mockWallet = {
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [user.address];
        case 'eth_chainId': return '0x' + walletChain.toString(16);
        case 'wallet_switchEthereumChain': walletChain = parseInt(params[0].chainId, 16); return null;
        case 'eth_sendTransaction': {
          const tx = { ...params[0] };
          const gas = await prov[walletChain].send('eth_estimateGas', [tx]); // like a real wallet: reverts surface here
          tx.gas = '0x' + ((BigInt(gas) * 13n) / 10n).toString(16);
          return prov[walletChain].send('eth_sendTransaction', [tx]);
        }
        default: return prov[walletChain].send(method, params);
      }
    },
    on() {}, removeListener() {}
  };

  const pageErrors = [];
  const dom = new JSDOM(fs.readFileSync(tmpHtml, 'utf8'), {
    runScripts: 'dangerously', resources: localResources, pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) {w.AbortController = AbortController; w.scrollTo = () => {};
      w.addEventListener('error', e => pageErrors.push(String(e.message || e.error)));
      w.fetch = (u, o) => String(u).startsWith('http://127.0.0.1') ? fetch(u, o) : Promise.reject(new Error('offline'));
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      w.ethereum = mockWallet;
    }
  });


  const w = dom.window, d = w.document, ev = c => w.eval(c);
  await waitFor(() => { try { return ev('typeof S') === 'object' && ev('S.chains.size') > 0 && d.readyState === 'complete'; } catch { return false; } }, 15000, 'page scripts loaded');
  await sleep(1200); // init + chainlist failure fallback

  for (const id of ids) {
    ev(`S.chains.get(${id}).rpcs=['${urls[id]}']`);
  }

  // Explicitly test the unsupported Sepolia -> QMS route.
  ev(`S.from={chainId:11155111,token:'${ethers.ZeroAddress}'};
       S.to={chainId:${HUB_ID},token:'${ethers.ZeroAddress}'};
       fixTokens();`);

  assert.equal(
    ev('routeKind()'),
    'blocked',
    'default Sepolia -> QMS is blocked'
  );


  await sleep(1200); // init + chainlist failure fallback
  for (const id of ids) ev(`S.chains.get(${id}).rpcs=['${urls[id]}']`);

console.log('DEBUG route state:', {
  from: ev('S.from.chainId'),
  to: ev('S.to.chainId'),
  supported: ev('[...SUPPORTED_CHAIN_IDS]'),
  route: ev('routeKind()')
});

assert.equal(ev('routeKind()'), 'blocked', 'default Sepolia -> QMS is blocked');


  d.getElementById('walletBtn').click();
  await waitFor(() => ev('S.account'), 5000, 'wallet connect');

  const typeAmount = async v => { const a = d.getElementById('amt'); a.value = v; a.dispatchEvent(new w.Event('input')); await waitFor(() => ev('S.q.state') !== 'loading' && ev('S.q.state') !== 'idle', 8000, 'quote'); };
  const route = (fromId, toId) => { ev(`S.from={chainId:${fromId},token:'${ethers.ZeroAddress}'};S.to={chainId:${toId},token:'${ethers.ZeroAddress}'};fixTokens();afterChange()`); };
  const runBridge = async () => {
    const btn = d.getElementById('go');
    await waitFor(() => !btn.disabled, 5000, 'bridge button enabled').catch(e => { throw new Error(e.message + ' | button="' + btn.textContent + '" q=' + JSON.stringify(ev('S.q')).slice(0,200) + ' amount=' + ev('S.amount') + ' msg=' + d.getElementById('msg').textContent); });
    btn.click();
    await waitFor(() => /Funds arrive[\s\S]*Received/.test(d.getElementById('prog').textContent) || /!/.test([...d.querySelectorAll('.st.error')].map(x => x.textContent).join('')) , 60000, 'bridge finish');
    const err = [...d.querySelectorAll('.st.error')].map(x => x.textContent).join(' | ');
    assert(!err, 'bridge step errored: ' + err);
    await waitFor(() => !ev('S.busy'), 5000, 'idle');
  };
  const tok = (id) => new ethers.Contract(dep.chains[id].token, art('WrappedQMS').abi, prov[id]);
  const out = [];
  const ok = n => { out.push(n); log0('  ok  ' + n); };
  const fresh = () => ethers.Wallet.createRandom().address;
  const setRecipient = r => { if (!ev('S.useRecipient'))d.getElementById('recipToggle').click(); const i = d.getElementById('recipIn'); i.value = r; i.dispatchEvent(new w.Event('input')); };

  // 1. QMS native -> Base Sepolia
  route(HUB_ID, 84532);
  assert.equal(ev('toTok().symbol'), 'wQMS');
  await typeAmount('2');
  assert.equal(d.getElementById('out').value, '2');
  const before = await tok(84532).balanceOf(user.address);
  await runBridge();
  assert.equal((await tok(84532).balanceOf(user.address)) - before, E('2'));
  ok('dapp: QMS (native) -> Base Sepolia mints wQMS');


const wqmsTok = ev(`chainOf(${HUB_ID}).tokens.find(t=>t.symbol==='WQMS').address`);
  // 4. Arbitrum Sepolia: get wQMS first, then wQMS -> WQMS (choose WQMS as the destination token)
  if (ev('S.useRecipient')) d.getElementById('recipToggle').click(); // back to my own wallet
  route(HUB_ID, 421614); await typeAmount('2'); await runBridge();
  assert.equal(await tok(421614).balanceOf(user.address), E('2'));
  route(421614, HUB_ID);
  ev(`S.to.token='${wqmsTok}';afterChange()`);
  assert.equal(ev('toTok().symbol'), 'WQMS');
  const r4 = fresh(); setRecipient(r4);
  await typeAmount('1.5');
  await runBridge();
  assert.equal(await wq.balanceOf(r4), E('1.5'));
  ok('dapp: Arbitrum Sepolia wQMS -> QMS delivered as WQMS');

  // 5. OP Sepolia round trip
  if (ev('S.useRecipient')) d.getElementById('recipToggle').click();
  route(HUB_ID, 11155420); await typeAmount('1'); await runBridge();
  assert.equal(await tok(11155420).balanceOf(user.address), E('1'));
  ok('dapp: QMS -> OP Sepolia');

  // 6. validation + blocked routes
  route(HUB_ID, 84532);
  await typeAmount('0.00001');
  assert.equal(ev('S.q.state'), 'error'); assert(/Minimum/.test(d.getElementById('msg').textContent));
  await typeAmount('99999');
  assert.equal(ev('S.q.state'), 'error'); assert(/Maximum/.test(d.getElementById('msg').textContent));
  ok('dapp: min / max validation');
  route(HUB_ID, 80002);
  assert.equal(ev('S.q.state'), 'unavailable');
  assert(d.getElementById('go').disabled);
  const vis = d.body.cloneNode(true); vis.querySelectorAll('script').forEach(x => x.remove());
  assert(!/\brelay\b/i.test(vis.textContent), 'no mention of the Relay route provider in the visible UI (the word "relayer" is fine)');
  ok('dapp: QMS <-> unsupported network is blocked, UI never mentions Relay');

  // 7. history reflects deliveries
  const hist = JSON.parse(w.localStorage.getItem('tetrixbridge.history.v1') || '[]');
  assert(hist.length >= 3 && hist.every(h => h.status === 'success' && h.own), 'history has completed entries');
  ok('dapp: history records completed transfers');

  // 8. navigation: every page renders, only one is visible, no script errors
  for (const [hash, id] of [['#/activity', 'activity'], ['#/networks', 'networks'], ['#/docs', 'docs'], ['#/bridge', 'bridge'], ['#/', 'home'], ['#/nope', 'home']]) {
    w.location.hash = hash; await sleep(250);
    const visible = [...d.querySelectorAll('[data-view]')].filter(x => !x.hidden).map(x => x.dataset.view);
    assert.deepEqual(visible, [id], hash + ' shows only the ' + id + ' view');
    assert.equal(d.querySelector('[data-route][aria-current=page]').dataset.route, id, 'nav highlights ' + id);
  }
  assert.deepEqual(pageErrors, [], 'no uncaught script errors while navigating: ' + pageErrors.join(' | '));
  ok('dapp: router shows one view at a time, nav state follows, no script errors');

  // 9. transfer stages are real: pause the relayer, send, and verify nothing is marked complete early
  relayer.stop(); await sleep(500);
  if (ev('S.useRecipient')) d.getElementById('recipToggle').click();
  w.location.hash = '#/bridge'; await sleep(200);
  route(HUB_ID, 84532); await typeAmount('1');
  const btn = d.getElementById('go');
  await waitFor(() => !btn.disabled, 5000, 'bridge button enabled');
  btn.click();
  const entry = await waitFor(() => { const e = JSON.parse(w.localStorage.getItem('tetrixbridge.history.v1') || '[]').find(x => x.status !== 'success'); return e; }, 10000, 'entry persisted at submission');
  assert(entry.txIn && entry.account === user.address.toLowerCase(), 'entry saved with tx hash and owner as soon as it is sent');
  await waitFor(() => !ev('S.busy'), 30000, 'form released after source confirmation');
  let live = JSON.parse(w.localStorage.getItem('tetrixbridge.history.v1')).find(x => x.txIn === entry.txIn);
  assert.equal(live.srcOk, true, 'source confirmation detected from the receipt');
  assert.equal(live.status, 'pending', 'source confirmed but not delivered is NOT complete');
  assert(/Confirmed on QMS Testnet/.test(d.getElementById('prog').textContent), 'timeline shows the source confirmation');
  assert(!/Received/.test(d.getElementById('prog').textContent), 'timeline does not claim receipt');
  ok('dapp: source-chain success is not shown as complete; entry persisted at submission');

  ev(`findEntry('${entry.txIn}').srcTs = Date.now() - 4*60*1000`);
  await ev(`refreshEntry(findEntry('${entry.txIn}'))`);
  assert.equal(ev(`findEntry('${entry.txIn}').status`), 'delayed', 'late delivery is flagged as delayed');
  assert(/longer than usual/.test(d.getElementById('prog').textContent), 'delayed state explains itself');
  ok('dapp: delayed delivery is flagged');

  relayer.stopped = false; relayer.run(300);
  await waitFor(() => ev(`findEntry('${entry.txIn}').status`) === 'success', 40000, 'delivery after relayer resumes');
  await ev(`refreshEntry(findEntry('${entry.txIn}'))`);
  assert(ev(`findEntry('${entry.txIn}').txOut`), 'delivery transaction located');
  assert(/Received/.test(d.getElementById('prog').textContent), 'timeline shows receipt once delivered');
  ok('dapp: delivery detected from destination chain state once the relayer resumes');

  // 10. activity is scoped to the connected wallet and can look up a transfer by hash
  ev(`S.history.unshift({id:'0x${'ab'.repeat(32)}',own:true,ts:Date.now(),from:'QMS Testnet',to:'Base Sepolia',fromId:${HUB_ID},toId:84532,sym:'QMS',outSym:'wQMS',amtIn:'9',amtOut:'9',status:'success',txIn:'0x${'cd'.repeat(32)}',account:'${deployer.address.toLowerCase()}'})`);
  w.location.hash = '#/activity'; await sleep(300);
  const rows = () => d.querySelectorAll('#actList .hi').length;
  assert.equal(rows(), ev('S.history.filter(x=>x.account===S.account.toLowerCase()).length'), 'only my transfers are listed');
  assert(!/\b9 QMS/.test(d.getElementById('actList').textContent), 'another wallet\'s transfer is not displayed');
  const hub = new ethers.Contract(dep.chains[HUB_ID].bridge, art('QmsBridgeHub').abi, new ethers.Wallet(deployer.key, prov[HUB_ID]));
  const foreign = await (await hub.depositNative(84532, deployer.address, { value: E('1') })).wait();
  await assert.rejects(ev(`lookupTx(${HUB_ID}, '${foreign.hash}')`), /different wallet/);
  ev(`S.history = S.history.filter(x => x.txIn !== '${entry.txIn}')`);
  const back = await ev(`lookupTx(${HUB_ID}, '${entry.txIn}')`);
  assert.equal(back.txIn, entry.txIn); assert.equal(back.amtIn, '1');
  assert.equal(ev(`S.history.filter(x => x.txIn === '${entry.txIn}').length`), 1, 'lookup restores tracking');
  ok('dapp: activity only shows the connected wallet; hash lookup rejects other wallets and restores own transfers');
  assert.deepEqual(pageErrors, [], 'no uncaught script errors: ' + pageErrors.join(' | '));

  relayer.stop();
  for (const id of ids) await servers[id].close();
  try { fs.unlinkSync(env.DEPLOYMENTS_FILE); fs.rmSync(tmpDapp, { recursive: true, force: true }); } catch {} // temp files only: never touch the real deployments.json
  log0(`\n${out.length} dapp scenarios passed`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
