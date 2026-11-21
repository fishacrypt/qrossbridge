/* QROS Gateway deployment configuration — public testnet contract addresses only.
 * QMS Testnet (19480) and Base Sepolia (84532).
 * Validator signing keys remain off-chain and are never exposed to this browser app.
 */
(function () {
  const qms = {
    chainId: 19480,
    ledger: '0xbae53eb7a08fd4eeaa62ba0d2b22e3e8060718d3',
    coordinator: '0x4cb36358a0fb51f5c9e2072396fad9b7b53003f0',
    assets: [{
      symbol: 'QROS Test USDT',
      decimals: 6,
      address: '0x258ce7483f37363a7e6ee94f10b918b1f88581b1'
    }],
    routes: [{
      id: 'qms-to-base-test-usdt',
      label: 'Base Sepolia · QROS Test USDT',
      sourceAsset: '0x258ce7483f37363a7e6ee94f10b918b1f88581b1',
      destinationChainId: 84532,
      destinationAsset: '0x9bb95ad4f02266c44728e54cee8ab8e70aae2683',
      destinationLedger: '0xa298a68b7b588ae2dbb1e50dd89540687ee8a65c',
      adapter: '0xc99808da32c2ac22dd44d1fced689846afeb919b',
      destinationSymbol: 'QROS Test USDT'
    }]
  };
  const base = {
    chainId: 84532,
    ledger: '0xa298a68b7b588ae2dbb1e50dd89540687ee8a65c',
    coordinator: '0x71f319b319616bca5b6a1dca0b2a1877938fe7ec',
    assets: [{
      symbol: 'QROS Test USDT',
      decimals: 6,
      address: '0x9bb95ad4f02266c44728e54cee8ab8e70aae2683'
    }],
    routes: [{
      id: 'base-to-qms-test-usdt',
      label: 'QMS Testnet · QROS Test USDT',
      sourceAsset: '0x9bb95ad4f02266c44728e54cee8ab8e70aae2683',
      destinationChainId: 19480,
      destinationAsset: '0x258ce7483f37363a7e6ee94f10b918b1f88581b1',
      destinationLedger: '0xbae53eb7a08fd4eeaa62ba0d2b22e3e8060718d3',
      adapter: '0x84954e5b607d767dbd048aee5c32bcb55a0f3011',
      destinationSymbol: 'QROS Test USDT'
    }]
  };
  const deployments = { 19480: qms, 84532: base };
  Object.defineProperty(window, 'QROS_GATEWAY_CONFIG', {
    configurable: true,
    get: function () {
      const chainId = typeof S !== 'undefined' ? Number(S.walletChain) : 0;
      return deployments[chainId] || {};
    }
  });
})();