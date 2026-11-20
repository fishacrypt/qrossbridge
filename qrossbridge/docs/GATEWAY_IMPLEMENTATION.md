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


## Cross-chain Gateway transfer UI

The Gateway dApp includes a configured-route transfer form. Deployment configuration must include a coordinator address and explicit routes; the UI does not infer token mappings or settlement adapters from the legacy bridge network list.

```js
window.QROS_GATEWAY_CONFIG = {
  chainId: 19480, // actual chain hosting the ledger and coordinator
  ledger: "0x<verified-ledger-address>",
  coordinator: "0x<verified-transfer-coordinator>",
  assets: [
    { symbol: "USDC", address: "0x<verified-source-token>", decimals: 6 }
  ],
  routes: [
    {
      id: "qms-to-base-usdc",
      label: "Base Sepolia",
      sourceAsset: "0x<verified-source-token>",
      destinationChainId: 84532,
      destinationAsset: "0x<verified-destination-token>",
      destinationSymbol: "USDC",
      adapter: "0x<approved-settlement-adapter>"
    }
  ]
};
```

A request checks the user's available Gateway balance and asks the wallet to call `QrosTransferCoordinator.requestTransfer`. The ledger moves the amount from available to inTransit. After that transaction confirms, the UI offers a separate `initiate(transferId)` wallet transaction. The adapter is selected from the explicit configured route and must also be approved in the coordinator contract.

The browser keeps the newly requested transfer ID in memory for the second step. Transfer history is read from coordinator events for the connected wallet over a recent block window. It is an activity view, not a final settlement oracle.

**Critical limitation:** the current coordinator's `initiate` call only asks the configured adapter to begin settlement. It does not establish destination finality. The destination balance must not be credited until an independently verified settlement adapter proves the source event/message and destination receipt, enforces replay protection, and calls the ledger's inbound-credit path. Cancellation must likewise only be possible when the adapter can prove that no irreversible settlement occurred. Do not configure placeholder adapter addresses or enable a route without a reviewed adapter implementation.


## Settlement proof, finalization and recovery lifecycle

### New protocol boundaries

- `interfaces/IQrosSettlementProofVerifier.sol` defines a verifier contract that authenticates a delivery proof and returns the source chain, recipient, destination asset and amount. Recovery proofs are verified separately.
- `adapters/QrosSettlementAdapterBase.sol` is an abstract security boundary for chain-specific adapters. It is intentionally not a deployable bridge implementation.
- The base adapter requires a configured ledger, verifier and coordinator. Only the coordinator may initiate an outbound transfer through it.

### Outbound lifecycle

1. `requestTransfer` records the transfer and moves the user's ledger amount from `available` to `inTransit`.
2. The user separately calls the coordinator's `initiate`.
3. The coordinator calls the approved adapter. In one atomic transaction, the adapter calls `finalizeOutboundTransfer` (the ledger transfers source tokens into adapter custody) and then dispatches the transfer through its chain-specific protocol implementation. If dispatch reverts, the entire transaction, including the ledger handoff, reverts.
4. Source dispatch is not destination settlement. The UI labels this state "Source dispatched · destination proof still required".
5. The destination adapter accepts a proof only if its configured verifier authenticates the transfer ID and returns the exact source chain, recipient, destination asset and amount. The adapter must deliver those exact destination tokens into the destination ledger before calling `creditInboundTransfer`. The ledger checks actual token custody and replay protection.

### Recovery lifecycle

- **Pre-dispatch cancellation:** while the source ledger transfer is still `InTransit`, the adapter may cancel only if its protocol-specific `_verifyPreDispatchCancellation` proves no irreversible action occurred. The ledger restores `inTransit` to `available`.
- **Post-dispatch recovery:** once the source ledger status is `Finalized`, cancellation is forbidden. A separate recovery proof must be accepted by `verifyRecovery`; the chain-specific adapter must return the exact original source asset to the source ledger, then call `recoverFinalizedOutboundTransfer`. The ledger checks that the returned funds are actually present before restoring the user's available balance.
- A transfer ID can be recovered only once. The ledger has distinct `Cancelled` and `Recovered` terminal states.

### What a production adapter must implement

A concrete adapter must implement all four protocol-specific hooks:

- `_dispatchOutbound`: transfer or burn/lock the source asset and emit the protocol's authenticated message, binding the QROS transfer ID, source and destination chain, destination asset, amount and recipient.
- `_releaseInbound`: release/mint the exact destination asset to the destination ledger only after the proof verifier accepts the matching message.
- `_verifyPreDispatchCancellation`: prove the outbound action did not happen and cannot later happen.
- `_returnRecoveredAsset`: return the original source asset to the source ledger after an authenticated refund/recovery.

The verifier is a critical trust boundary. It must verify protocol-native message authenticity and finality, chain/domain identifiers, token mapping, recipient, amount, transfer ID, and replay protection. It must not simply trust a relayer-supplied boolean or payload. Verifier upgrades and adapter changes require strict governance and timelocks.

### Configuration and limitations

The ledger's `settlementAdapter` must be set to the exact adapter that will call its settlement methods. The coordinator must approve the same adapter, and the adapter must point to the matching ledger and coordinator on that chain. Destination adapters are configured independently against their destination ledger. The adapter must be allowlisted as the ledger's settlement adapter before it can credit inbound funds.

No concrete protocol implementation or verifier is included in this stage. Do not deploy this abstract base directly, configure placeholder verifier addresses, or enable a route yet. A QMS-to-Base adapter must use a settlement protocol actually supported by both networks and the exact token contracts; it must not be labelled Circle CCTP unless Circle confirms QMS support and token integration.

The Gateway transfer activity panel now distinguishes requested, initiated, source-dispatched, cancelled and recovered states. "Source dispatched" is explicitly not shown as destination settled. Destination credit is a separate ledger event on the destination chain.

### Validation status

These are implementation commits only. No compile, integration, security or deployment validation has been performed in this implementation pass. The complete consolidated validation remains scheduled after the remaining Gateway modules are built.
