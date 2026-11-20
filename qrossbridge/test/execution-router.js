// Signed execution-intent integration test using an isolated local Ganache chain.
// Uses a mock adapter that returns all funds; it does not interact with Uniswap.
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const artifact = name => JSON.parse(fs.readFileSync(path.join(root, 'build', name + '.json'), 'utf8'));
const units = n => BigInt(n) * 1_000_000n;

(async () => {
  const chainId = 19480;
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId, networkId: chainId },
    wallet: { deterministic: true, defaultBalance: 1000 }
  });
  await server.listen(18883);
  try {
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:18883', chainId, { staticNetwork: true });
    const owner = await provider.getSigner(0);
    const user = await provider.getSigner(1);
    const outsider = await provider.getSigner(2);
    const ownerAddress = await owner.getAddress();
    const userAddress = await user.getAddress();

    const deploy = async (signer, name, args = []) => {
      const a = artifact(name);
      const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
      await c.waitForDeployment();
      return c;
    };
    const expectRevert = async (promise, label) => {
      let failed = false;
      try { await promise; } catch { failed = true; }
      assert(failed, label || 'expected revert');
    };

    const token = await deploy(owner, 'GatewayTestToken');
    const ledger = await deploy(owner, 'QrosGatewayLedger', [ownerAddress]);
    const adapter = await deploy(owner, 'MockExecutionAdapter');
    const router = await deploy(owner, 'QrosExecutionRouter', [ownerAddress, await ledger.getAddress()]);
    const asset = await token.getAddress();
    const routerAddress = await router.getAddress();
    const strategyId = ethers.id('uniswap-v3-test-strategy');

    await (await ledger.setAssetSupport(asset, true)).wait();
    await (await ledger.setExecutionAdapter(await adapter.getAddress())).wait();
    await (await ledger.setExecutionRouter(routerAddress)).wait();
    await (await router.setStrategy(strategyId, true)).wait();

    await (await token.mint(userAddress, units(20))).wait();
    await (await token.connect(user).approve(await ledger.getAddress(), units(20))).wait();
    await (await ledger.connect(user).deposit(asset, units(20))).wait();

    const adapterData = '0x12345678';
    const intent = {
      user: userAddress, asset, amount: units(7), strategyId,
      adapterDataHash: ethers.keccak256(adapterData), nonce: 0,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600)
    };
    const domain = { name: 'QROS Execution Router', version: '1', chainId, verifyingContract: routerAddress };
    const types = {
      ExecutionIntent: [
        { name: 'user', type: 'address' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'strategyId', type: 'bytes32' },
        { name: 'adapterDataHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };
    const signature = await user.signTypedData(domain, types, intent);

    await expectRevert(
      router.connect(outsider).execute(intent, '0xdeadbeef', signature),
      'tampered adapter parameters rejected'
    );
    await expectRevert(
      router.connect(outsider).execute(intent, adapterData, await outsider.signTypedData(domain, types, intent)),
      'non-owner signature rejected'
    );

    const tx = await router.connect(outsider).execute(intent, adapterData, signature);
    await tx.wait();
    const balance = await ledger.getBalance(userAddress, asset);
    assert.equal(balance.available, units(20), 'unused amount returned to available');
    assert.equal(balance.reserved, 0n, 'reservation cleared');
    assert.equal(balance.deployed, 0n, 'mock adapter did not deploy funds');
    assert.equal(await router.nonces(userAddress), 1n, 'user nonce consumed once');

    await expectRevert(
      router.connect(outsider).execute(intent, adapterData, signature),
      'intent replay rejected'
    );

    console.log('Execution router: EIP-712 signature, tamper rejection, relayed execution, balance return and replay protection passed');
  } finally {
    await server.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
