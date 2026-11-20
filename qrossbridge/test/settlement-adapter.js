// End-to-end test for the quorum-attested prefunded-liquidity settlement path.
// Runs on two isolated local Ganache chains; no public RPC or real funds.
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { deliveryProof, recoveryProof, cancellationProof, outboundSettlementProof } =
  require('../scripts/settlement-attestation');

const root = path.join(__dirname, '..');
const artifact = name => JSON.parse(fs.readFileSync(path.join(root, 'build', name + '.json'), 'utf8'));
const units = n => BigInt(n) * 1_000_000n;

(async () => {
  const sourceId = 19480, destinationId = 84532;
  const sourceServer = ganache.server({ logging: { quiet: true }, chain: { chainId: sourceId, networkId: sourceId }, wallet: { deterministic: true, defaultBalance: 1000 } });
  const destinationServer = ganache.server({ logging: { quiet: true }, chain: { chainId: destinationId, networkId: destinationId }, wallet: { deterministic: true, defaultBalance: 1000 } });
  await sourceServer.listen(18881);
  await destinationServer.listen(18882);

  try {
    const source = new ethers.JsonRpcProvider('http://127.0.0.1:18881', sourceId, { staticNetwork: true });
    const destination = new ethers.JsonRpcProvider('http://127.0.0.1:18882', destinationId, { staticNetwork: true });
    const owner = await source.getSigner(0);
    const user = await source.getSigner(1);
    const validator = await source.getSigner(2);
    const destOwner = await destination.getSigner(0);
    const destCoordinatorOwner = destOwner;
    const validatorAddress = await validator.getAddress();
    const ownerAddress = await owner.getAddress();
    const userAddress = await user.getAddress();

    const deploy = async (providerSigner, name, args = []) => {
      const a = artifact(name);
      const c = await new ethers.ContractFactory(a.abi, a.bytecode, providerSigner).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const expectRevert = async (promise, label) => {
      let failed = false;
      try { await promise; } catch { failed = true; }
      assert(failed, label || 'expected revert');
    };

    const sourceToken = await deploy(owner, 'GatewayTestToken');
    const destinationToken = await deploy(destOwner, 'GatewayTestToken');
    const sourceLedger = await deploy(owner, 'QrosGatewayLedger', [ownerAddress]);
    const destinationLedger = await deploy(destOwner, 'QrosGatewayLedger', [await destOwner.getAddress()]);
    const sourceVerifier = await deploy(owner, 'QrosQuorumAttestationVerifier', [ownerAddress, 1]);
    const destinationVerifier = await deploy(destOwner, 'QrosQuorumAttestationVerifier', [await destOwner.getAddress(), 1]);
    const sourceCoordinator = await deploy(owner, 'QrosTransferCoordinator', [ownerAddress, await sourceLedger.getAddress()]);
    const destinationCoordinator = await deploy(destCoordinatorOwner, 'QrosTransferCoordinator', [await destOwner.getAddress(), await destinationLedger.getAddress()]);
    const sourceAdapter = await deploy(owner, 'QrosAttestedLiquidityAdapter', [
      ownerAddress, await sourceLedger.getAddress(), await sourceVerifier.getAddress(), await sourceCoordinator.getAddress()
    ]);
    const destinationAdapter = await deploy(destOwner, 'QrosAttestedLiquidityAdapter', [
      await destOwner.getAddress(), await destinationLedger.getAddress(), await destinationVerifier.getAddress(), await destinationCoordinator.getAddress()
    ]);

    const sourceAsset = await sourceToken.getAddress();
    const destinationAsset = await destinationToken.getAddress();
    const sourceAdapterAddress = await sourceAdapter.getAddress();
    const destinationAdapterAddress = await destinationAdapter.getAddress();
    const sourceCoordinatorAddress = await sourceCoordinator.getAddress();
    const sourceVerifierAddress = await sourceVerifier.getAddress();
    const destinationVerifierAddress = await destinationVerifier.getAddress();

    await (await sourceLedger.setAssetSupport(sourceAsset, true)).wait();
    await (await destinationLedger.setAssetSupport(destinationAsset, true)).wait();
    await (await sourceLedger.setSettlementAdapter(sourceAdapterAddress)).wait();
    await (await destinationLedger.setSettlementAdapter(destinationAdapterAddress)).wait();
    await (await sourceLedger.setTransferCoordinator(sourceCoordinatorAddress)).wait();
    await (await sourceCoordinator.setAdapter(sourceAdapterAddress, true)).wait();
    await (await sourceAdapter.setOutboundRoute(sourceAsset, destinationId, destinationAsset, true)).wait();
    await (await sourceAdapter.setSettlementTreasury(ownerAddress)).wait();
    await (await sourceVerifier.setSigner(validatorAddress, true)).wait();
    await (await destinationVerifier.setSigner(validatorAddress, true)).wait();
    await (await sourceVerifier.setRoute(sourceId, destinationId, sourceAsset, destinationAsset, ethers.ZeroAddress, true)).wait();
    await (await sourceVerifier.setRoute(sourceId, destinationId, sourceAsset, destinationAsset, await destinationLedger.getAddress(), true)).wait();
    await (await destinationVerifier.setRoute(sourceId, destinationId, sourceAsset, destinationAsset, ethers.ZeroAddress, true)).wait();
    await (await destinationVerifier.setRoute(sourceId, destinationId, sourceAsset, destinationAsset, await destinationLedger.getAddress(), true)).wait();

    await (await sourceToken.mint(userAddress, units(30))).wait();
    await (await sourceToken.connect(user).approve(await sourceLedger.getAddress(), units(30))).wait();
    await (await sourceLedger.connect(user).deposit(sourceAsset, units(30))).wait();

    await (await destinationToken.mint(await destOwner.getAddress(), units(30))).wait();
    await (await destinationToken.connect(destOwner).approve(destinationAdapterAddress, units(30))).wait();
    await (await destinationAdapter.connect(destOwner).fundLiquidity(destinationAsset, units(30))).wait();

    const transferId = ethers.keccak256(ethers.toUtf8Bytes('settlement-success'));
    await (await sourceCoordinator.connect(user).requestTransfer(
      transferId, sourceAsset, units(10), destinationId, destinationAsset, userAddress, sourceAdapterAddress
    )).wait();
    await (await sourceCoordinator.connect(user).initiate(transferId)).wait();
    let sourceBalance = await sourceLedger.getBalance(userAddress, sourceAsset);
    assert.equal(sourceBalance.inTransit, 0n);
    assert.equal(await sourceToken.balanceOf(sourceAdapterAddress), units(10));

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const proof = await deliveryProof({
      wallets: [validator], verifier: destinationVerifierAddress, transferId,
      sourceChainId: sourceId, destinationChainId: destinationId, sourceAsset,
      recipient: userAddress, destinationAsset, destinationLedger: ethers.ZeroAddress, amount: units(10), deadline
    });
    await (await destinationAdapter.connect(destOwner).proveAndFinalize(transferId, proof)).wait();
    const credited = await destinationLedger.getBalance(userAddress, destinationAsset);
    assert.equal(credited.available, units(10));
    await expectRevert(destinationAdapter.proveAndFinalize(transferId, proof), 'destination replay blocked');

    const settledProof = await outboundSettlementProof({
      wallets: [validator], verifier: sourceVerifierAddress, transferId,
      sourceChainId: sourceId, destinationChainId: destinationId,
      sourceAsset, destinationAsset, recipient: userAddress, destinationLedger: ethers.ZeroAddress,
      amount: units(10), deadline
    });
    await (await sourceAdapter.settleOutbound(transferId, settledProof)).wait();
    assert.equal(await sourceToken.balanceOf(ownerAddress), units(10));
    assert.equal(await sourceToken.balanceOf(sourceAdapterAddress), 0n);

    // Gateway-to-Gateway handoff keeps the Gateway ledger as recipient while crediting the original user.
    const handoffId = ethers.keccak256(ethers.toUtf8Bytes('settlement-gateway-handoff'));
    const destinationLedgerAddress = await destinationLedger.getAddress();
    await (await sourceCoordinator.connect(user).requestGatewayHandoff(
      handoffId, sourceAsset, units(8), destinationId, destinationAsset, destinationLedgerAddress, sourceAdapterAddress
    )).wait();
    await (await sourceCoordinator.connect(user).initiate(handoffId)).wait();
    const handoffProof = await deliveryProof({
      wallets: [validator], verifier: destinationVerifierAddress, transferId: handoffId,
      sourceChainId: sourceId, destinationChainId: destinationId, sourceAsset,
      recipient: userAddress, destinationAsset, destinationLedger: destinationLedgerAddress,
      amount: units(8), deadline
    });
    await (await destinationAdapter.proveAndFinalize(handoffId, handoffProof)).wait();
    const handoffBalance = await destinationLedger.getBalance(userAddress, destinationAsset);
    assert.equal(handoffBalance.available, units(18));
    await expectRevert(destinationAdapter.proveAndFinalize(handoffId, handoffProof), 'Gateway handoff replay blocked');
    const handoffSettledProof = await outboundSettlementProof({
      wallets: [validator], verifier: sourceVerifierAddress, transferId: handoffId,
      sourceChainId: sourceId, destinationChainId: destinationId, sourceAsset,
      destinationAsset, recipient: userAddress, destinationLedger: destinationLedgerAddress,
      amount: units(8), deadline
    });
    await (await sourceAdapter.settleOutbound(handoffId, handoffSettledProof)).wait();

    // Pre-dispatch cancellation restores the exact amount to available.
    const cancelId = ethers.keccak256(ethers.toUtf8Bytes('settlement-cancel'));
    await (await sourceCoordinator.connect(user).requestTransfer(
      cancelId, sourceAsset, units(5), destinationId, destinationAsset, userAddress, sourceAdapterAddress
    )).wait();
    const cancelProof = await cancellationProof({
      wallets: [validator], verifier: sourceVerifierAddress, transferId: cancelId,
      sourceChainId: sourceId, deadline
    });
    await (await sourceAdapter.cancelOrRecover(cancelId, cancelProof)).wait();

    // Post-dispatch recovery returns source escrow only after a separate proof.
    const recoverId = ethers.keccak256(ethers.toUtf8Bytes('settlement-recovery'));
    await (await sourceCoordinator.connect(user).requestTransfer(
      recoverId, sourceAsset, units(3), destinationId, destinationAsset, userAddress, sourceAdapterAddress
    )).wait();
    await (await sourceCoordinator.connect(user).initiate(recoverId)).wait();
    const refundProof = await recoveryProof({
      wallets: [validator], verifier: sourceVerifierAddress, transferId: recoverId,
      sourceChainId: sourceId, sourceAsset, amount: units(3), deadline
    });
    await (await sourceAdapter.cancelOrRecover(recoverId, refundProof)).wait();
    sourceBalance = await sourceLedger.getBalance(userAddress, sourceAsset);
    assert.equal(sourceBalance.available, units(12));
    assert.equal(sourceBalance.inTransit, 0n);
    assert.equal(sourceBalance.reserved, 0n);

    console.log('Gateway settlement: wallet delivery, Gateway handoff, replay protection, escrow release, cancellation and recovery passed');
  } finally {
    await sourceServer.close();
    await destinationServer.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
