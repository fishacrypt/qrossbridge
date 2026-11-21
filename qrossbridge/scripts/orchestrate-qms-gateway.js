// Deploy and configure the QROS QMS/wQMS Gateway adapter across the configured Hub and Spokes.
// Existing Gateway ledgers, coordinators and settlement verifiers are supplied per chain.
// This script is deliberately fail-closed: it validates chain IDs, bytecode, ownership,
// signer threshold, route assets and existing configuration before sending transactions.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { HUB_ID, chains, rpcFor } = require('./chains');

const root = path.join(__dirname, '..');
const art = name => JSON.parse(fs.readFileSync(path.join(root, 'build', name + '.json'), 'utf8'));
const ZERO = ethers.ZeroAddress;
const norm = x => ethers.getAddress(x);
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
const requiredAddress = (value, label) => {
  if (!value || !ethers.isAddress(value) || same(value, ZERO)) throw new Error(label + ' must be a non-zero address');
  return norm(value);
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

async function deployedCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (!code || code === '0x' || code === '0x0') throw new Error(label + ' has no bytecode at ' + address);
}
async function assertOwner(contract, expected, label) {
  if (!contract.owner) throw new Error(label + ' ABI has no owner() method');
  const actual = await contract.owner();
  if (!same(actual, expected)) throw new Error(label + ' owner mismatch: expected ' + expected + ', got ' + actual);
}
async function send(label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(label + ' transaction failed');
  console.log('  ✓ ' + label + ' (' + receipt.hash + ')');
  return receipt;
}
async function ensureBool(label, read, write) {
  if (await read()) return false;
  await send(label, write());
  if (!(await read())) throw new Error(label + ' did not persist');
  return true;
}
async function ensureAddress(label, read, write, expected) {
  const current = await read();
  if (same(current, expected)) return false;
  if (!same(current, ZERO)) throw new Error(label + ' already points to a different address: ' + current);
  await send(label, write());
  if (!same(await read(), expected)) throw new Error(label + ' did not persist');
  return true;
}
async function main(env = process.env) {
  const key = env.DEPLOYER_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('DEPLOYER_KEY must be a 32-byte private key');
  const signerBase = new ethers.Wallet(key);
  const owner = requiredAddress(env.OWNER_ADDRESS || signerBase.address, 'OWNER_ADDRESS');
  if (!same(owner, signerBase.address)) throw new Error('DEPLOYER_KEY must belong to OWNER_ADDRESS; use the contract owner key for this orchestrator');

  const configFile = path.resolve(root, env.QMS_GATEWAY_CONFIG || 'qms-gateway.config.json');
  const bridgeDeploymentsFile = path.resolve(root, env.DEPLOYMENTS_FILE || 'deployments.json');
  const outputFile = path.resolve(root, env.QMS_GATEWAY_DEPLOYMENTS_FILE || 'qms-gateway-deployments.json');
  if (!fs.existsSync(configFile)) throw new Error('Missing config: ' + configFile + ' (copy qms-gateway.config.example.json first)');
  if (!fs.existsSync(bridgeDeploymentsFile)) throw new Error('Missing bridge deployments file: ' + bridgeDeploymentsFile);
  const config = readJson(configFile);
  const bridgeDeployments = readJson(bridgeDeploymentsFile);
  const hubChainId = Number(config.hubChainId || HUB_ID);
  if (hubChainId !== HUB_ID || Number(bridgeDeployments.hubChainId) !== hubChainId) throw new Error('Hub chain ID mismatch');

  const validatorAddresses = [...new Set((config.validators || []).map((x,i) => requiredAddress(x, 'validators['+i+']')))]
    .sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const threshold = Number(config.threshold || 2);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > validatorAddresses.length) {
    throw new Error('threshold must be between 1 and the number of unique validators');
  }
  if (!Array.isArray(config.chains) || config.chains.length < 2) throw new Error('Configure at least the Hub and one Spoke');
  const chainConfigs = new Map(config.chains.map(item => [Number(item.chainId), item]));
  if (chainConfigs.size !== config.chains.length || !chainConfigs.has(hubChainId)) throw new Error('Duplicate chain IDs or missing Hub config');

  const bridgeEntries = bridgeDeployments.chains || {};
  const selectedIds = [...chainConfigs.keys()].sort((a,b)=>a-b);
  for (const id of selectedIds) {
    if (!chains[id]) throw new Error('Unsupported chain ID in config: ' + id);
    if (!bridgeEntries[id]) throw new Error('Missing bridge deployment for chain ' + id);
    if (id !== hubChainId && !chainConfigs.has(id)) throw new Error('Missing Spoke config');
  }
  const hubBridge = requiredAddress(bridgeEntries[hubChainId].bridge, 'Hub bridge');
  const hubWQMS = requiredAddress(bridgeDeployments.wqms, 'Hub wQMS');

  const contexts = new Map();
  for (const id of selectedIds) {
    const item = chainConfigs.get(id);
    const provider = new ethers.JsonRpcProvider(rpcFor(id, env), id, { staticNetwork: true, cacheTimeout: -1 });
    const actual = BigInt(await provider.send('eth_chainId', []));
    if (actual !== BigInt(id)) throw new Error(chains[id].name + ' RPC chain ID mismatch: expected ' + id + ', got ' + actual);
    const wallet = new ethers.NonceManager(new ethers.Wallet(key, provider));
    const localBridge = requiredAddress(bridgeEntries[id].bridge, id + ' bridge');
    const localToken = id === hubChainId ? hubWQMS : requiredAddress(bridgeEntries[id].token, id + ' wQMS token');
    const ledgerAddress = requiredAddress(item.ledger, id + ' Gateway ledger');
    const coordinatorAddress = requiredAddress(item.coordinator, id + ' transfer coordinator');
    const settlementVerifierAddress = requiredAddress(item.settlementVerifier, id + ' settlement verifier');
    for (const [address,label] of [[localBridge,'bridge'],[localToken,'wQMS'],[ledgerAddress,'ledger'],[coordinatorAddress,'coordinator'],[settlementVerifierAddress,'settlement verifier']]) {
      await deployedCode(provider,address,chains[id].name+' '+label);
    }
    const ledger = new ethers.Contract(ledgerAddress, art('QrosGatewayLedger').abi, wallet);
    const coordinator = new ethers.Contract(coordinatorAddress, art('QrosTransferCoordinator').abi, wallet);
    const settlementVerifier = new ethers.Contract(settlementVerifierAddress, art('QrosQuorumAttestationVerifier').abi, wallet);
    const bridge = new ethers.Contract(localBridge, art(id===hubChainId?'QmsBridgeHub':'QmsBridgeSpoke').abi, wallet);
    await assertOwner(ledger,owner,id+' Gateway ledger');
    await assertOwner(coordinator,owner,id+' transfer coordinator');
    await assertOwner(settlementVerifier,owner,id+' settlement verifier');
    await assertOwner(bridge,owner,id+' QMS bridge');
    if (id === hubChainId) {
      if (!same(await bridge.wqms(), hubWQMS)) throw new Error('Hub bridge wQMS does not match deployments.json');
    } else {
      if (Number(await bridge.hubChainId()) !== hubChainId) throw new Error(chains[id].name + ' points to a different Hub chain');
      if (!same(await bridge.token(), localToken)) throw new Error(chains[id].name + ' Spoke token does not match deployments.json');
    }
    contexts.set(id,{id,item,provider,wallet,localBridge,localToken,ledgerAddress,coordinatorAddress,settlementVerifierAddress,ledger,coordinator,settlementVerifier,bridge});
  }

  const output = fs.existsSync(outputFile) ? readJson(outputFile) : { hubChainId, owner, threshold, validators: validatorAddresses, chains: {} };
  if (output.owner && !same(output.owner,owner)) throw new Error('Existing adapter manifest belongs to a different owner');
  if (output.hubChainId && Number(output.hubChainId)!==hubChainId) throw new Error('Existing adapter manifest has a different Hub');
  output.owner=owner; output.hubChainId=hubChainId; output.threshold=threshold; output.validators=validatorAddresses;
  output.updatedAt=new Date().toISOString();

  // Deploy the chain-local bridge verifier and adapter if absent. Existing addresses are reused only after bytecode and owner checks.
  for (const id of selectedIds) {
    const c=contexts.get(id), existing=output.chains[id] || {};
    let verifierAddress=existing.bridgeVerifier;
    if (verifierAddress) {
      verifierAddress=requiredAddress(verifierAddress,id+' bridge verifier');
      await deployedCode(c.provider,verifierAddress,id+' bridge verifier');
    } else {
      const deployed=await new ethers.ContractFactory(art('QrosQmsBridgeAttestationVerifier').abi,art('QrosQmsBridgeAttestationVerifier').bytecode,c.wallet)
        .deploy(owner,threshold);
      const receipt=await deployed.deploymentTransaction().wait();
      await deployed.waitForDeployment();
      verifierAddress=await deployed.getAddress();
      console.log('  ✓ deployed '+id+' QMS bridge verifier '+verifierAddress+' (block '+receipt.blockNumber+')');
    }
    const verifier=new ethers.Contract(verifierAddress,art('QrosQmsBridgeAttestationVerifier').abi,c.wallet);
    await assertOwner(verifier,owner,id+' QMS bridge verifier');
    let adapterAddress=existing.adapter;
    if (adapterAddress) {
      adapterAddress=requiredAddress(adapterAddress,id+' QMS adapter');
      await deployedCode(c.provider,adapterAddress,id+' QMS adapter');
    } else {
      const deployed=await new ethers.ContractFactory(art('QrosQmsBridgeAdapter').abi,art('QrosQmsBridgeAdapter').bytecode,c.wallet)
        .deploy(owner,c.ledgerAddress,c.settlementVerifierAddress,c.coordinatorAddress,verifierAddress,
          hubChainId,hubBridge,hubWQMS,c.localBridge,c.localToken);
      const receipt=await deployed.deploymentTransaction().wait();
      await deployed.waitForDeployment();
      adapterAddress=await deployed.getAddress();
      console.log('  ✓ deployed '+id+' QMS Gateway adapter '+adapterAddress+' (block '+receipt.blockNumber+')');
    }
    const adapter=new ethers.Contract(adapterAddress,art('QrosQmsBridgeAdapter').abi,c.wallet);
    await assertOwner(adapter,owner,id+' QMS Gateway adapter');
    output.chains[id]={...(output.chains[id]||{}),name:chains[id].name,role:id===hubChainId?'hub':'spoke',
      bridge:c.localBridge,token:c.localToken,ledger:c.ledgerAddress,coordinator:c.coordinatorAddress,
      settlementVerifier:c.settlementVerifierAddress,bridgeVerifier:verifierAddress,adapter:adapterAddress};
    contexts.get(id).bridgeVerifier=verifier;
    contexts.get(id).adapter=adapter;
    // Persist each chain as soon as its adapter pair is deployed, so an interrupted
    // multi-chain run can safely resume without deploying duplicate contracts.
    writeJson(outputFile,output);
  }

  // Apply chain-local asset, ledger, coordinator, verifier signer and threshold configuration.
  for (const id of selectedIds) {
    const c=contexts.get(id);
    console.log('\nConfiguring '+chains[id].name+' ('+id+')');
    await ensureBool('enable wQMS asset',()=>c.ledger.supportedAssets(c.localToken),()=>c.ledger.setAssetSupport(c.localToken,true));
    await ensureAddress('set Gateway settlement adapter',()=>c.ledger.settlementAdapter(),()=>c.ledger.setSettlementAdapter(c.adapter.target),c.adapter.target);
    await ensureAddress('set Gateway transfer coordinator',()=>c.ledger.transferCoordinator(),()=>c.ledger.setTransferCoordinator(c.coordinator.target),c.coordinator.target);
    await ensureBool('approve settlement adapter',()=>c.coordinator.approvedAdapters(c.adapter.target),()=>c.coordinator.setAdapter(c.adapter.target,true));
    if(id!==hubChainId) {
      await ensureBool('authorize Spoke Gateway adapter',()=>c.bridge.gatewayAdapters(c.adapter.target),()=>c.bridge.setGatewayAdapter(c.adapter.target,true));
    }
    const v=c.bridgeVerifier;
    for(const signer of validatorAddresses) {
      await ensureBool('enable bridge validator '+signer,()=>v.isSigner(signer),()=>v.setSigner(signer,true));
    }
    if(Number(await v.threshold())!==threshold) {
      await send('set bridge validator threshold',v.setThreshold(threshold));
    }
    const sv=c.settlementVerifier;
    for(const signer of validatorAddresses) {
      await ensureBool('enable settlement validator '+signer,()=>sv.isSigner(signer),()=>sv.setSigner(signer,true));
    }
    if(Number(await sv.threshold())!==threshold) await send('set settlement validator threshold',sv.setThreshold(threshold));
  }

  // Ensure the Hub permits deposits from every configured remote chain.
  const hubContext=contexts.get(hubChainId);
  for (const remoteId of selectedIds.filter(id=>id!==hubChainId)) {
    await ensureBool('enable Hub support for '+chains[remoteId].name,
      ()=>hubContext.bridge.supportedChain(remoteId),
      ()=>hubContext.bridge.setChainSupport(remoteId,true));
  }

  // Configure every directed pair. The source adapter gets the destination route;
  // destination verifiers accept proofs only for the exact reverse-direction endpoints.
  for(const sourceId of selectedIds) {
    const source=contexts.get(sourceId);
    for(const destinationId of selectedIds) {
      if(sourceId===destinationId) continue;
      const destination=contexts.get(destinationId);
      const route=await source.adapter.remoteRoutes(destinationId);
      const expected={bridge:destination.localBridge,token:destination.localToken,adapter:destination.adapter.target,ledger:destination.ledgerAddress};
      if(!route.enabled || !same(route.bridge,expected.bridge) || !same(route.token,expected.token) ||
         !same(route.adapter,expected.adapter) || !same(route.gatewayLedger,expected.ledger)) {
        await send('configure adapter route '+sourceId+' → '+destinationId,
          source.adapter.setRemoteRoute(destinationId,expected.bridge,expected.token,expected.adapter,expected.ledger,true));
      }
      // Destination settlement verifier verifies source->destination user credit.
      const settlementEnabled=await destination.settlementVerifier.enabledRoute(
        await destination.settlementVerifier.routeKey(sourceId,destinationId,source.localToken,destination.localToken,destination.ledgerAddress)
      );
      if(!settlementEnabled) await send('configure settlement proof route '+sourceId+' → '+destinationId,
        destination.settlementVerifier.setRoute(sourceId,destinationId,source.localToken,destination.localToken,destination.ledgerAddress,true));
      // Destination bridge verifier binds both bridge endpoints, both adapter endpoints and both wQMS tokens.
      const bridgeKey=await destination.bridgeVerifier.routeKey(
        sourceId,destinationId,source.localBridge,destination.localBridge,
        source.localToken,destination.localToken,source.adapter.target,destination.adapter.target
      );
      if(!(await destination.bridgeVerifier.enabledRoute(bridgeKey))) {
        await send('configure QMS bridge proof route '+sourceId+' → '+destinationId,
          destination.bridgeVerifier.setRoute(sourceId,destinationId,source.localBridge,destination.localBridge,
            source.localToken,destination.localToken,source.adapter.target,destination.adapter.target,true));
      }
    }
  }

  // Record deployment blocks and the effective directed route matrix.
  for(const id of selectedIds) {
    const c=contexts.get(id);
    output.chains[id].routes=selectedIds.filter(other=>other!==id).map(destinationId=>({
      destinationChainId:destinationId,enabled:true,adapter:contexts.get(destinationId).adapter.target,
      bridge:contexts.get(destinationId).localBridge,token:contexts.get(destinationId).localToken,
      gatewayLedger:contexts.get(destinationId).ledgerAddress
    }));
  }
  output.configuredAt=new Date().toISOString();
  writeJson(outputFile,output);
  console.log('\nQMS Gateway deployment/configuration complete.');
  console.log('Manifest: '+path.relative(root,outputFile));
  console.log('Chains: '+selectedIds.join(', '));
  console.log('Validator threshold: '+threshold+'/'+validatorAddresses.length);
  console.log('Important: validator monitoring/signing infrastructure is external; this script only configures on-chain signer allowlists and routes.');
  return output;
}

module.exports={main};
if(require.main===module) main().catch(error=>{console.error('\nQMS Gateway orchestrator failed:',error.stack||error);process.exit(1);});
