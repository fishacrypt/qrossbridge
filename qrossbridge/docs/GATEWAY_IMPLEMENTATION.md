# QROS Gateway implementation notes

This document describes the implementation modules on `qros-unified-gateway-architecture`. The code is an implementation in progress and has not yet passed a consolidated compile, test, security or deployment review.

## Contracts added

- `QrosGatewayLedger.sol`: user/asset accounting buckets, custody liabilities, deposits, withdrawals, transfer lifecycle, adapter-gated inbound credit, execution reservations and atomic adapter execution.
- `QrosTransferCoordinator.sol`: creates user-scoped outbound transfer intents, reserves the user's ledger balance and invokes an approved settlement adapter.
- `QrosExecutionRouter.sol`: EIP-712 signed execution intents. The signature binds user, asset, amount, strategy ID, adapter-data hash, nonce and deadline. Execution is atomic through the ledger.
- `QrosPositionRegistry.sol`: records external position metadata and lifecycle status.
- `adapters/UniswapV3LiquidityAdapter.sol`: single-input-token flow that can swap part of the input through Uniswap V3 SwapRouter, mint a V3 position through NonfungiblePositionManager, register it and transfer the NFT to the user's address. It also supports user-approved fee collection, partial liquidity reduction and full close/burn.
- `interfaces/IQrosExecutionAdapter.sol` and `interfaces/IQrosSettlementAdapter.sol`: protocol boundaries for replaceable adapters.

## Execution lifecycle

1. User deposits an allowlisted ERC-20. The full received amount is credited to `available`.
2. A user signs an EIP-712 execution intent. The signature binds the exact encoded adapter parameters by hash.
3. The router checks the signer, chain-bound EIP-712 domain, deadline, sequential user nonce, strategy allowlist and adapter-data hash.
4. The router reserves the input in the ledger and calls `executeReserved`.
5. The ledger transfers the reserved input to the configured adapter and calls it in the same transaction.
6. The Uniswap adapter optionally swaps a signed portion of the input, mints the LP NFT, records the position and transfers the NFT to the user.
7. Any unspent input is returned to the ledger's `available` bucket. Input consumed by execution moves from `reserved` to the informational `deployed` bucket. If any call reverts, the entire transaction reverts.

The adapter data is ABI encoding of `UniswapV3LiquidityAdapter.Params`:
`(token0, token1, poolFee, swapFee, swapAmount, minSwapOut, tickLower, tickUpper, amount0Min, amount1Min, deadline)`.

## Position lifecycle

The position NFT is transferred to the user's wallet after minting. To use the adapter's management functions, the user must explicitly approve the adapter for that specific NFT (or grant operator approval) in the Uniswap V3 Position Manager.

- `collectFees(positionId, deadline)`: collects currently owed token0/token1 directly to the user.
- `reduceLiquidity(positionId, liquidityToRemove, amount0Min, amount1Min, deadline)`: decreases the selected liquidity, collects the resulting tokens and accrued fees directly to the user, and updates the registry's remaining liquidity.
- `closePosition(positionId, amount0Min, amount1Min, deadline)`: removes all remaining liquidity, collects proceeds and fees to the user, burns the now-empty NFT and marks the registry record closed.

The user remains the NFT owner throughout. These functions do not route proceeds back into the Gateway ledger; the tokens are delivered to the user's wallet. A later iteration can add an explicit, separately authorized "return proceeds to Gateway" option.

## Required configuration

- Deploy the ledger.
- Allowlist the exact input token contracts.
- Deploy the position registry and execution adapter.
- Configure the adapter with the official chain-specific SwapRouter, NonfungiblePositionManager and registry addresses.
- Approve the adapter in the registry.
- Approve only verified pool fee tiers.
- Set the adapter on the ledger and set the router on the ledger.
- Deploy the execution router, set it on the ledger, and allowlist the intended strategy IDs.
- A strategy ID is not itself a protocol allowlist: the adapter configuration and signed data must also be reviewed and constrained before enabling users.

## Important limitations

- Position management functions are implemented, but still require tests against the canonical Uniswap V3 contracts. Proceeds are currently delivered directly to the user's wallet, not reconciled back into Gateway balance buckets.
- The position registry records NFT metadata; it is not a valuation oracle and does not calculate current USD value, fees earned or impermanent loss.
- The ledger's `deployed` bucket is an informational principal record, not a spendable token balance or redeemable claim.
- The current execution adapter is configured by the ledger owner. Production needs a multisig/timelock, narrowly scoped roles, emergency controls and independent security review.
- The transfer coordinator is an orchestration boundary, not a bridge proof verifier. A real settlement adapter must independently verify finality, source message authenticity, destination mint/receipt, replay protection and recovery before finalizing a transfer.
- QMS Testnet is not currently established as a Circle CCTP-supported source. Do not configure or describe QMS-to-Base as native CCTP without explicit Circle confirmation for QMS and the exact token contract.
- Do not deploy or enable these modules for real-value use until the consolidated compile, unit/fuzz/invariant/integration tests, official protocol-address verification and independent audit are complete.

## Validation status

No compile or test result is claimed for these additions yet. Per the agreed workflow, implementation is being completed before the next consolidated environment-validation pass.


## dApp Gateway dashboard

The dApp now includes a Gateway navigation view and a read-only balance dashboard. It reads `getBalance(user, asset)` from the configured ledger and displays available, in-transit, reserved and deployed amounts separately. It deliberately does not expose deposit/withdraw/transfer buttons until a verified ledger deployment, supported asset list and transaction flows are configured.

The browser configuration contract is:

```js
window.QROS_GATEWAY_CONFIG = {
  ledger: "0x<verified-ledger-address>",
  assets: [
    { symbol: "USDC", address: "0x<verified-token-address>", decimals: 6 }
  ]
};
```

This configuration must be supplied by the deployment process with chain-specific verified addresses. Do not insert placeholder addresses or reuse addresses from another chain. When multiple assets are configured, the dashboard keeps their balances separate rather than summing unlike tokens. For a single configured asset, the summary metrics show that asset's four buckets.

The dashboard is a read-only integration step, not a claim that Gateway contracts have been deployed or that deposit, withdrawal, settlement or strategy execution is live.


## Gateway deposit and withdrawal UI

The Gateway view now exposes wallet-authorized deposit and withdrawal flows when deployment configuration is present.

Required browser configuration:

```js
window.QROS_GATEWAY_CONFIG = {
  chainId: 19480, // replace with the actual chain hosting this ledger
  ledger: "0x<verified-ledger-address>",
  assets: [
    { symbol: "USDC", address: "0x<verified-token-address>", decimals: 6 }
  ]
};
```

Before a deposit, the UI checks the ledger's `supportedAssets` flag, requests ERC-20 allowance and asks the user to approve the exact amount if needed, then calls `deposit(asset, amount)`. Withdrawals call `withdraw(asset, amount, recipient)` and check the connected user's available balance before submitting. Both require the wallet to be on the configured ledger chain. Transaction completion is awaited before the displayed balances refresh.

The interface does not initiate transfers or execution as a side effect of either operation. No default chain, token or ledger address is supplied by the frontend. The deployment configuration must only contain addresses verified for the selected chain. These flows remain subject to contract-level security review and end-to-end validation; they are not evidence of a deployed or audited Gateway.
