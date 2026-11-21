// Gateway ledger accounting and access-control tests on an isolated local EVM.
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const artifact = name => JSON.parse(
  fs.readFileSync(path.join(root, 'build', name + '.json'), 'utf8')
);
const units = n => BigInt(n) * 1_000_000n;

(async () => {
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 19480, networkId: 19480 },
    wallet: { deterministic: true, defaultBalance: 1000 }
  });
  await server.listen(18777);

  try {
    const provider = new ethers.JsonRpcProvider(
      'http://127.0.0.1:18777', 19480,
      { staticNetwork: true, cacheTimeout: -1 }
    );
    const [owner, user, settlement, execution, outsider] =
      await provider.listAccounts();

    const deploy = async (name, signer, args = []) => {
      const a = artifact(name);
      const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
      await c.waitForDeployment();
      return c;
    };

    const token = await deploy('GatewayTestToken', owner);
    const ledger = await deploy('QrosGatewayLedger', owner, [owner.address]);
    const asset = await token.getAddress();
    const ledgerAddress = await ledger.getAddress();

    const expectRevert = async (promise, label) => {
      let failed = false;
      try { await promise; } catch { failed = true; }
      assert(failed, label || 'expected transaction to revert');
    };

    await (await ledger.setAssetSupport(asset, true)).wait();
    await (await ledger.setSettlementAdapter(settlement.address)).wait();
    await (await ledger.setExecutionAdapter(execution.address)).wait();
    await (await token.mint(user.address, units(100))).wait();
    await (await token.connect(user).approve(ledgerAddress, units(100))).wait();

    // Deposit credits only the depositor and creates matching custody liability.
    await (await ledger.connect(user).deposit(asset, units(60))).wait();
    let b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(60));
    assert.equal(await ledger.custodyLiability(asset), units(60));

    // Another wallet cannot spend the user's available balance.
    await expectRevert(
      ledger.connect(outsider).withdraw(asset, units(1), outsider.address),
      'third-party withdrawal blocked'
    );

    // Outbound transfer moves available -> inTransit without changing custody.
    const transferId = ethers.keccak256(ethers.toUtf8Bytes('outbound-1'));
    await (await ledger.connect(user).beginOutboundTransfer(
      transferId, asset, units(10), 84532, asset, user.address
    )).wait();
    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(50));
    assert.equal(b.inTransit, units(10));
    assert.equal(await ledger.custodyLiability(asset), units(60));

    // Only configured settlement adapter can cancel; cancellation restores available.
    await expectRevert(ledger.connect(outsider).cancelOutboundTransfer(transferId));
    await (await ledger.connect(settlement).cancelOutboundTransfer(transferId)).wait();
    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(60));
    assert.equal(b.inTransit, 0n);

    // A second outbound transfer finalized by the adapter leaves custody.
    const transferId2 = ethers.keccak256(ethers.toUtf8Bytes('outbound-2'));
    await (await ledger.connect(user).beginOutboundTransfer(
      transferId2, asset, units(5), 84532, asset, user.address
    )).wait();
    await (await ledger.connect(settlement).finalizeOutboundTransfer(transferId2)).wait();
    assert.equal(await token.balanceOf(settlement.address), units(5));
    assert.equal(await ledger.custodyLiability(asset), units(55));

    // Inbound funds must arrive before the adapter can credit a user.
    const inboundId = ethers.keccak256(ethers.toUtf8Bytes('inbound-1'));
    await (await token.mint(ledgerAddress, units(7))).wait();
    await (await ledger.connect(settlement).creditInboundTransfer(
      inboundId, user.address, asset, units(7), 84532
    )).wait();
    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(62));
    assert.equal(await ledger.custodyLiability(asset), units(62));
    await expectRevert(
      ledger.connect(settlement).creditInboundTransfer(
        inboundId, user.address, asset, units(7), 84532
      ),
      'inbound replay blocked'
    );

    // Execution reservation requires a nonzero strategy and available balance.
    const strategy = ethers.keccak256(ethers.toUtf8Bytes('uniswap-v3-eth-usdc'));
    const reserveTx = await ledger.connect(user).reserveExecution(asset, units(20), strategy);
    const reserveReceipt = await reserveTx.wait();
    const reserveEvent = reserveReceipt.logs
      .map(log => { try { return ledger.interface.parseLog(log); } catch { return null; } })
      .find(event => event && event.name === 'ExecutionReserved');
    const executionId = reserveEvent.args.executionId;

    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(42));
    assert.equal(b.reserved, units(20));

    // A user can release a reservation before it is handed to an adapter.
    const releaseId = await ledger.connect(user).reserveExecution.staticCall(asset, units(2), strategy);
    await (await ledger.connect(user).reserveExecution(asset, units(2), strategy)).wait();
    await (await ledger.connect(user).releaseExecution(releaseId)).wait();

    // Completion is adapter-only and moves reserved -> deployed while transferring input.
    await expectRevert(ledger.connect(outsider).completeExecution(executionId));
    await (await ledger.connect(execution).completeExecution(executionId)).wait();
    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.reserved, 0n);
    assert.equal(b.deployed, units(20));
    assert.equal(await token.balanceOf(execution.address), units(20));
    assert.equal(await ledger.custodyLiability(asset), units(42));

    // User can withdraw only their remaining available balance.
    await (await ledger.connect(user).withdraw(asset, units(12), user.address)).wait();
    b = await ledger.getBalance(user.address, asset);
    assert.equal(b.available, units(30));
    assert.equal(await ledger.custodyLiability(asset), units(30));

    console.log('Gateway ledger: 10 accounting and authorization assertions passed');
  } finally {
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
