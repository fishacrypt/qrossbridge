// Deploy and configure QROS QMS Gateway adapters across the Hub and selected Spokes.
// Existing Gateway ledgers, transfer coordinators, settlement verifiers and bridge endpoints
// are supplied in qms-adapter.config.json. This script deploys the QMS bridge verifier +
// adapter on each chain and wires both directions. It never deploys or moves user funds.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { HUB_ID, chains, rpcFor } = require('./chains');

const ROOT = path.join(__dirname, '..');
const artifact = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'build', name + '.json'), 'utf8'));
const ZERO = ethers.ZeroAddress;
const addr = (value, label) => {
  if (!ethers.isAddress(value || '') || value.toLowerCase() === ZERO.toLowerCase()) {
    throw new Error(label + ' must be a non-zero address');
  }
  return ethers.getAddress(value);
};
const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();

function loadConfig(file) {
  if (!fs.existsSync(file)) throw new Error('Missing config file: ' + file + '. Copy scripts/qms-adapter.config.example.json to qms-adapter.config.json and fill in deployed addresses.');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Number(cfg.hubChainId || HUB_ID) !== HUB_ID) throw new Error('This QMS adapter currently supports the configured QMS Hub chain only: ' + HUB_ID);
  if (!Array.isArray(cfg.validators) || cfg.validators.length === 0) throw new Error('config.validators must contain validator addresses');
  cfg.validators = [...new Set(cfg.validators.map((v,i) => addr(v, 'validators['+i+']').toLowerCase()))].map(ethers.getAddress);
  cfg.threshold = Number(cfg.threshold || 2);
  if (!Number.isInteger(cfg.threshold) || cfg.threshold < 1 || cfg.threshold > cfg.validators.length) throw new Error('threshold must be between 1 and the number of unique validators');
  if (!cfg.chains || typeof cfg.chains !== 'object') throw new Error('config.chains is required');
  const hub = cfg.chains[String(HUB_ID)];
  if (!hub || hub.role !== 'hub') throw new Error('config.chains must include the QMS Hub entry with role "hub"');
  const spokes = Object.entries(cfg.chains).filter(([id,c]) => Number(id) !== HUB_ID && c.role === 'spoke');
  if (!spokes.length) throw new Error('At least one spoke chain is required');
  for (const [id,c] of Object.entries(cfg.chains)) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || !chains[n]) throw new Error('Unsupported configured chain ID: ' + id);
    if (n === HUB_ID && c.role !== 'hub' || n !== HUB_ID && c.role !== 'spoke') throw new Error('Incorrect role for chain ' + id);
    c.bridge = addr(c.bridge, id + '.bridge');
    c.ledger = addr(c.ledger, id + '.ledger');
    c.settlementVerifier = addr(c.settlementVerifier, id + '.settlementVerifier');
    c.coordinator = addr(c.coordinator, id + '.coordinator');
    if (n === HUB_ID) c.token = addr(c.token, id + '.token (hub wQMS)');
    else c.token = addr(c.token, id + '.token (spoke wQMS)');
  }
  return { ...cfg, hubChainId: HUB_ID, spokes };
}

async function main() {
  const configPath = path.resolve(ROOT, process.env.QMS_ADAPTER_CONFIG || 'qms-adapter.config.json');
  const manifestPath = path.resolve(ROOT, process.env.QMS_ADAPTER_DEPLOYMENTS_FILE || 'deployments/qms-gateway-adapters.json');
  const cfg = loadConfig(configPath);
  const privateKey = process.env.DEPLOYER_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || '')) throw new Error('DEPLOYER_KEY must be a 32-byte private key');
  const deployerAddress = ethers.getAddress(new ethers.Wallet(privateKey).address);
  const owner = addr(cfg.owner || deployerAddress, 'config.owner');
  if (!same(owner, deployerAddress)) throw new Error('For the initial orchestration transaction, DEPLOYER_KEY must belong to config.owner. Transfer ownership separately after setup if desired.');

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath,'utf8')) : {
    protocol: 'QROS QMS/wQMS Gateway Adapter',
    hubChainId: HUB_ID,
    owner,
    threshold: cfg.threshold,
    validators: cfg.validators,
    createdAt: new Date().toISOString(),
    chains: {}
  };
  if (manifest.hubChainId && Number(manifest.hubChainId) !== HUB_ID) throw new Error('Existing manifest belongs to a different Hub');
  manifest.owner = owner;
  manifest.threshold = cfg.threshold;
  manifest.validators = cfg.validators;

  const deployed = {};
  const runtime = {};

  async function deploy(wallet, name, args) {
    const a = artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, wallet).deploy(...args);
    const receipt = await c.deploymentTransaction().wait();
    await c.waitForDeployment();
    return { contract: c, address: await c.getAddress(), blockNumber: receipt.blockNumber };
  }
  async function requireCode(provider, address, label) {
    const code = await provider.getCode(address);
    if (!code || code === '0x' || code === '0x0') throw new Error(label + ' has no contract code at ' + address);
  }
  async function assertOwner(contract, expected, label) {
    const actual = await contract.owner();
    if (!same(actual, expected)) throw new Error(label + ' owner is ' + actual + ', but DEPLOYER_KEY/config.owner is ' + expected + '. No ownership was changed.');
  }
  async function tx(label, promise) {
    const sent = await promise;
    const receipt = await sent.wait();
    console.log('  ✓ ' + label + ' [' + receipt.hash + ']');
    return receipt;
  }

  // Connect and validate every configured chain before making configuration transactions.
  for (const [idText, c] of Object.entries(cfg.chains)) {
    const id = Number(idText);
    const provider = new ethers.JsonRpcProvider(rpcFor(id), id, { staticNetwork: true, cacheTimeout: -1 });
    const actual = Number((await provider.getNetwork()).chainId);
    if (actual !== id) throw new Error(chains[id].name + ' RPC chain ID mismatch: expected ' + id + ', got ' + actual);
    const wallet = new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
    for (const [label,address] of Object.entries({ bridge:c.bridge, token:c.token, ledger:c.ledger, settlementVerifier:c.settlementVerifier, coordinator:c.coordinator })) {
      await requireCode(provider,address,id + '.' + label);
    }
    const bridgeAbi = artifact(id === HUB_ID ? 'QmsBridgeHub' : 'QmsBridgeSpoke').abi;
    const bridge = new ethers.Contract(c.bridge,bridgeAbi,wallet);
    const ledger = new ethers.Contract(c.ledger,artifact('QrosGatewayLedger').abi,wallet);
    const coordinator = new ethers.Contract(c.coordinator,artifact('QrosTransferCoordinator').abi,wallet);
    const settlementVerifier = new ethers.Contract(c.settlementVerifier,artifact('QrosQuorumAttestationVerifier').abi,wallet);
    await assertOwner(bridge,owner,id + '.bridge');
    await assertOwner(ledger,owner,id + '.ledger');
    await assertOwner(coordinator,owner,id + '.coordinator');
    await assertOwner(settlementVerifier,owner,id + '.settlementVerifier');

    if (id === HUB_ID) {
      const bridgeWqms = await bridge.wqms();
      if (!same(bridgeWqms,c.token)) throw new Error('Hub bridge wqms() does not match configured Hub token');
    } else {
      const bridgeToken = await bridge.token();
      if (!same(bridgeToken,c.token)) throw new Error('Spoke bridge token() does not match configured token on chain ' + id);
      const spokeHub = Number(await bridge.hubChainId());
      if (spokeHub !== HUB_ID) throw new Error('Spoke ' + id + ' is connected to Hub ' + spokeHub + ', expected ' + HUB_ID);
    }

    const previous = manifest.chains[id] || {};
    let verifierAddress = previous.qmsBridgeAttestationVerifier;
    let adapterAddress = previous.qrosQmsBridgeAdapter;
    let verifier, adapter;
    if (verifierAddress && adapterAddress) {
      verifierAddress = addr(verifierAddress,id+'.manifest verifier');
      adapterAddress = addr(adapterAddress,id+'.manifest adapter');
      const verifierCode = await provider.getCode(verifierAddress);
      const adapterCode = await provider.getCode(adapterAddress);
      if (verifierCode !== '0x' && adapterCode !== '0x') {
        verifier = new ethers.Contract(verifierAddress,artifact('QrosQmsBridgeAttestationVerifier').abi,wallet);
        adapter = new ethers.Contract(adapterAddress,artifact('QrosQmsBridgeAdapter').abi,wallet);
        if (!same(await verifier.owner(),owner) || !same(await adapter.owner(),owner)) throw new Error('Existing QMS adapter deployment on '+id+' is not owned by config.owner');
        console.log(chains[id].name+': reusing existing adapter/verifier deployment');
      }
    }
    if (!verifier || !adapter) {
      console.log(chains[id].name+': deploying QMS bridge verifier and Gateway adapter');
      const vd = await deploy(wallet,'QrosQmsBridgeAttestationVerifier',[owner,cfg.threshold]);
      verifierAddress = vd.address;
      verifier = vd.contract;
      const localToken = c.token;
      const ad = await deploy(wallet,'QrosQmsBridgeAdapter',[
        owner,c.ledger,c.settlementVerifier,c.coordinator,verifierAddress,
        HUB_ID,cfg.chains[String(HUB_ID)].bridge,cfg.chains[String(HUB_ID)].token,
        c.bridge,localToken
      ]);
      adapterAddress = ad.address;
      adapter = ad.contract;
      console.log('  verifier: '+verifierAddress+' (block '+vd.blockNumber+')');
      console.log('  adapter:  '+adapterAddress+' (block '+ad.blockNumber+')');
    }

    runtime[id] = { id, config:c, provider, wallet, bridge, ledger, coordinator, settlementVerifier, verifier, adapter, verifierAddress, adapterAddress };
    deployed[id] = {
      name: chains[id].name, role:c.role, bridge:c.bridge, token:c.token,
      ledger:c.ledger, settlementVerifier:c.settlementVerifier, coordinator:c.coordinator,
      qmsBridgeAttestationVerifier:verifierAddress, qrosQmsBridgeAdapter:adapterAddress
    };
    manifest.chains[id] = deployed[id];
    fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  }

  const hub = runtime[HUB_ID];
  // Ensure the Hub permits all configured remote spokes.
  for (const [idText] of cfg.spokes) {
    const id=Number(idText);
    if (!(await hub.bridge.supportedChain(id))) await tx('enable Hub route to '+chains[id].name,hub.bridge.setChainSupport(id,true));
  }

  // Chain-local permissions, ledger asset support and adapter/coordinator linkage.
  for (const item of Object.values(runtime)) {
    const {id,config:c,ledger,coordinator,adapter,adapterAddress,bridge} = item;
    if (!(await ledger.supportedAssets(c.token))) await tx(chains[id].name+' enable wQMS ledger asset',ledger.setAssetSupport(c.token,true));
    if (!same(await ledger.settlementAdapter(),adapterAddress)) await tx(chains[id].name+' set Gateway settlement adapter',ledger.setSettlementAdapter(adapterAddress));
    if (!same(await ledger.transferCoordinator(),c.coordinator)) await tx(chains[id].name+' bind Gateway transfer coordinator',ledger.setTransferCoordinator(c.coordinator));
    if (!(await coordinator.approvedAdapters(adapterAddress))) await tx(chains[id].name+' approve QMS adapter in coordinator',coordinator.setAdapter(adapterAddress,true));
    if (id !== HUB_ID && !(await bridge.gatewayAdapters(adapterAddress))) {
      await tx(chains[id].name+' authorize adapter on QMS Spoke',bridge.setGatewayAdapter(adapterAddress,true));
    }
    for (const validator of cfg.validators) {
      if (!(await item.verifier.isSigner(validator))) await tx(chains[id].name+' add bridge validator '+validator,item.verifier.setSigner(validator,true));
    }
  }

  // Configure each chain's outbound route table. Hub has one route per spoke; each spoke routes back to Hub.
  for (const [idText,c] of Object.entries(cfg.chains)) {
    const id=Number(idText), item=runtime[id];
    if (id===HUB_ID) {
      for (const [spokeIdText,spokeCfg] of cfg.spokes) {
        const spokeId=Number(spokeIdText), remote=runtime[spokeId];
        await tx('Hub adapter route -> '+chains[spokeId].name,item.adapter.setRemoteRoute(
          spokeId,spokeCfg.bridge,spokeCfg.token,remote.adapterAddress,spokeCfg.ledger,true
        ));
      }
    } else {
      await tx(chains[id].name+' adapter route -> QMS Hub',item.adapter.setRemoteRoute(
        HUB_ID,cfg.chains[String(HUB_ID)].bridge,cfg.chains[String(HUB_ID)].token,
        hub.adapterAddress,cfg.chains[String(HUB_ID)].ledger,true
      ));
    }
  }

  // For every directed Hub<->Spoke route, configure the destination-chain settlement
  // verifier and bridge verifier. The destination ledger is always local to that verifier.
  for (const [spokeIdText,spokeCfg] of cfg.spokes) {
    const spokeId=Number(spokeIdText), spoke=runtime[spokeId];
    const hubCfg=cfg.chains[String(HUB_ID)];

    await tx(chains[spokeId].name+' settlement verifier route Hub -> Spoke',
      spoke.settlementVerifier.setRoute(HUB_ID,spokeId,hubCfg.token,spokeCfg.token,spokeCfg.ledger,true));
    await tx(chains[spokeId].name+' bridge verifier route Hub -> Spoke',
      spoke.verifier.setRoute(HUB_ID,spokeId,hubCfg.bridge,spokeCfg.bridge,
        hubCfg.token,spokeCfg.token,hub.adapterAddress,spoke.adapterAddress,true));

    await tx('Hub settlement verifier route Spoke -> Hub',
      hub.settlementVerifier.setRoute(spokeId,HUB_ID,spokeCfg.token,hubCfg.token,hubCfg.ledger,true));
    await tx('Hub bridge verifier route Spoke -> Hub',
      hub.verifier.setRoute(spokeId,HUB_ID,spokeCfg.bridge,hubCfg.bridge,
        spokeCfg.token,hubCfg.token,spoke.adapterAddress,hub.adapterAddress,true));
  }

  manifest.configuredAt = new Date().toISOString();
  manifest.threshold = cfg.threshold;
  manifest.validators = cfg.validators;
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  console.log('\nQMS Gateway adapter orchestration complete.');
  console.log('Deployment manifest: '+path.relative(ROOT,manifestPath));
  console.log(JSON.stringify({hubChainId:HUB_ID,chains:deployed},null,2));
  console.log('Security note: validator signatures are an explicit trust boundary, not a trustless cross-chain proof. Configure validators to independently reconcile source events and destination bridge processing.');
}

main().catch(error=>{ console.error('\nQMS adapter orchestration failed:',error.stack||error); process.exitCode=1; });
