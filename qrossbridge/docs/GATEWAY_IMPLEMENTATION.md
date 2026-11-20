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


## Concrete settlement integration — quorum-attested prefunded liquidity

This implementation adds a concrete **quorum-attested prefunded-liquidity adapter**. It is a real token-custody and accounting path, but it is not a trustless bridge and does not automatically integrate Circle CCTP or the legacy native-QMS bridge.

### Components

- `contracts/settlement/QrosQuorumAttestationVerifier.sol`: EIP-712 threshold signer verifier for delivery, cancellation, recovery and source-escrow release attestations.
- `contracts/adapters/QrosAttestedLiquidityAdapter.sol`: source escrow, destination inventory release, source refund and source escrow release.
- `scripts/settlement-attestation.js`: ethers v6 helpers for generating ABI-encoded validator proof payloads. This belongs in a trusted validator/operations environment only; never bundle it into browser code or expose validator private keys.
- `interfaces/IQrosSettlementProofVerifier.sol`: exact typed return fields for delivery and recovery proofs.

### Operational flow

1. Deploy a verifier and adapter on each participating chain. Configure the matching Gateway ledger's `settlementAdapter` to that chain's adapter. Configure the source coordinator to approve its source adapter; the adapter's coordinator address must match.
2. Configure the source adapter route with source asset, destination chain ID and destination asset. Configure the destination verifier's route for source chain, destination chain and destination asset.
3. Prefund the destination adapter with the destination token inventory using `fundLiquidity`. Configure the source adapter's `settlementTreasury` to the liquidity provider/treasury that receives source assets after destination delivery.
4. The user requests and separately initiates the Gateway transfer. The source ledger transfers the exact source token amount into adapter escrow and emits `OutboundLiquidityLocked`. The transfer ID and all route details are retained in the event and escrow record.
5. Validators independently reconcile the source event and the destination payout process. They sign a destination `Delivery` attestation. Anyone can submit it to the destination adapter's `proveAndFinalize`; the destination adapter releases prefunded destination inventory to its ledger, which credits the recipient once.
6. Validators independently verify the destination ledger credit and sign an `OutboundSettled` attestation. Anyone can submit it to the source adapter's `settleOutbound`; only then is the source escrow released to the configured settlement treasury.
7. If the destination payout cannot be completed, validators may sign a `Recovery` attestation. The source adapter returns the exact escrowed source token to the source ledger, and the ledger restores the user's available balance. A pre-dispatch `Cancellation` proof is a separate path and only applies while the ledger still records the transfer as in transit.

### Attestation format

The helper exports:
- `deliveryProof`: source chain, destination chain, source asset, recipient, destination asset, amount, deadline and sorted signatures.
- `outboundSettlementProof`: source chain, destination chain, source asset, amount, deadline and sorted signatures.
- `recoveryProof`: source chain, source asset, exact amount, deadline and sorted signatures.
- `cancellationProof`: source chain and deadline.

All signatures use EIP-712 domain name `QROS Quorum Settlement Attestation`, version `1`, the chain ID where the verifier is deployed, and that verifier's address. The contract rejects duplicate or unsorted signer addresses. Signers must independently verify the underlying source/destination events; the contract cannot make dishonest validators honest.

For verifier setup, deploy initially with threshold `1`, add the validator signer addresses, then set the intended threshold (for example, 2-of-3). The verifier owner can change signers, threshold and routes. A delivery route is keyed by source chain, destination chain, source token and destination token; these powers require multisig custody, timelocks and monitoring before production.

### Important trust and liquidity model

This adapter is explicitly **quorum-trusted**. Validators attest that a source transfer is eligible for a destination payout and that the destination credit actually occurred. It is not a light client, fraud proof, zk proof, or Circle attestation verifier. A compromised threshold can authorize an invalid payout or refund. Validator independence, key security, monitoring and economic/liquidity controls are essential.

Destination payout uses prefunded inventory. The source token remains escrowed until a separate quorum attestation confirms destination credit, after which it is transferred to the settlement treasury/liquidity provider. This is a liquidity-provider model; it is not a native token burn-and-mint bridge. Fees, exchange rates, decimals, inventory rebalancing and liquidity-provider economics must be explicitly configured before enabling any route. The current adapter transfers the exact same integer amount across source/destination units, so it is suitable only for routes whose token units are intentionally 1:1 and decimal-compatible. Do not enable mismatched-decimal or FX routes with this implementation.

### Legacy bridge compatibility

The existing QMS hub-and-spoke bridge transfers native QMS and mints/burns wQMS. The Gateway ledger currently accounts for ERC-20 assets. The legacy bridge events also do not carry the Gateway transfer ID in a way this adapter can verify end-to-end. Therefore this adapter does **not** silently claim to be integrated with the legacy QMS bridge. A dedicated bridge-specific adapter and Gateway-aware hub/spoke entrypoints are still required if that is the chosen settlement route.

### Safety boundary

No route should be enabled until both chain deployments, token addresses/decimals, verifier signer set, liquidity inventory, treasury, ledger adapter and coordinator approval have been independently verified. No private key belongs in the frontend. This implementation is a testnet reference for an explicitly trusted validator model, not audited production infrastructure.


### Added integration coverage (not yet executed)

`test/settlement-adapter.js` now exercises two isolated local chains and covers:
- Gateway deposit and transfer request;
- source escrow handoff through the coordinator;
- destination proof validation and ledger credit;
- duplicate destination proof rejection;
- source escrow release after a separate destination-completion quorum;
- pre-dispatch cancellation;
- post-dispatch source-token recovery.

The package test command includes this suite after the existing bridge, dApp and Gateway ledger suites. The tests have been authored but not run; artifacts must be rebuilt before the consolidated validation pass.


## Execution stage hardening and integration test

The Uniswap V3 execution adapter now requires explicit governance approvals for:
- the strategy-specific ordered token pair (`strategyId`, `token0`, `token1`);
- the Uniswap V3 LP pool fee tier;
- the swap pool fee tier whenever a swap is requested.

It also:
- rejects protocol configuration addresses without deployed code and verifies the position manager's factory;
- checks that both the LP pool and optional swap pool exist in that factory;
- checks that the requested tick bounds align with the LP pool's tick spacing;
- bounds execution deadlines to a configurable window (default 30 minutes; owner may set 1 minute–2 hours);
- requires a nonzero minimum swap output when swapping and rejects an unused swap minimum otherwise;
- verifies that the newly minted NFT is initially held by the adapter, registers it, transfers it to the user, then verifies user ownership;
- requires the registry to confirm that the approved adapter actually holds the NFT before registering its metadata.

### Execution authorization test

`test/execution-router.js` uses a local Ganache chain and a test-only mock adapter. It checks EIP-712 user signatures, altered adapter-data rejection, non-owner signature rejection, third-party submission of a valid user authorization, returned-unused balance accounting, nonce consumption and replay rejection.

The mock deliberately returns all input to the Gateway. It tests authorization and ledger accounting only; it does not simulate a Uniswap swap or mint. The real Uniswap adapter still requires canonical-contract integration tests against the target chain's official factory, SwapRouter and NonfungiblePositionManager.

### Required route setup before enabling a strategy

For each strategy, governance must:
1. Approve the strategy ID in `QrosExecutionRouter`.
2. Approve the exact ordered token pair in `UniswapV3LiquidityAdapter.setStrategyPair`.
3. Approve the LP fee tier with `setPoolFee`.
4. If the strategy swaps, approve the actual swap fee tier with `setSwapFee`.
5. Configure verified chain-specific SwapRouter, PositionManager and PositionRegistry addresses; approve the adapter in the registry; and configure it as the ledger execution adapter.
6. Confirm the pool exists, the fee tier is valid, the ticks match tick spacing, and the signed `minSwapOut`, `amount0Min` and `amount1Min` represent acceptable slippage bounds.

The EIP-712 intent authorizes the exact adapter-data hash, input token, amount, strategy ID, nonce and deadline. It is user-signed and can be submitted by a relayer, but the user must still review and sign the authorization. The NFT is delivered to the user wallet; the adapter cannot manage it afterward unless the user separately approves that specific NFT or grants operator approval.

### Test status

The execution authorization integration test has been added to the consolidated `npm test` script. It is authored but has not been executed. The Uniswap adapter has not been validated against live canonical Uniswap V3 contracts, and no protocol deployment or strategy activation is implied.


## Gateway execution UI and position visibility

The Gateway view now includes a configured Uniswap V3 execution panel. It is deliberately inactive unless the deployment supplies a complete, verified execution configuration:

```js
window.QROS_GATEWAY_CONFIG = {
  chainId: 19480, // chain hosting this ledger/router/adapter
  ledger: "0x<verified-ledger>",
  assets: [
    { symbol: "USDC", address: "0x<verified-token>", decimals: 6 }
  ],
  execution: {
    chainId: 19480,
    router: "0x<verified-QrosExecutionRouter>",
    adapter: "0x<verified-UniswapV3LiquidityAdapter>",
    positionRegistry: "0x<verified-QrosPositionRegistry>",
    strategyId: "0x<32-byte-approved-strategy-id>",
    asset: "0x<verified-input-token>",
    token0: "0x<lower-address-token>",
    token1: "0x<higher-address-token>",
    symbol0: "USDC",
    symbol1: "WETH",
    decimals: 6,
    decimals0: 6,
    decimals1: 18,
    poolFee: 3000,
    swapFee: 3000,
    tickLower: -887220,
    tickUpper: 887220,
    label: "USDC / WETH · 0.30%"
  }
};
```

The UI verifies that the configured router points to the configured ledger, that the ledger points to the configured adapter, that the input asset is enabled, and that the strategy ID, ordered token pair and fee tiers are approved on-chain. It then builds the exact adapter parameter tuple, hashes it into the EIP-712 intent, requests the user's signature, and submits the signed intent to the router. The user supplies total input, swap amount, minimum swap output and minimum token amounts for minting. The UI uses a short execution deadline and displays the configured pool range.

After execution, the UI reads the user's position IDs from the configured registry and displays the NFT ID, token pair, fee tier, tick range, liquidity and status. The NFT itself is transferred to the user's wallet; the registry is an index, not NFT custody.

**Configuration warning:** the example values are placeholders, not deployed addresses or a live QMS/Uniswap route. The tick range is illustrative and must be selected for the target pool and price. Do not copy the example configuration into production. The UI must only be enabled with official chain-specific Uniswap addresses, verified token decimals, a real pool, approved strategy pair and fee tiers, and a reviewed deployment.

The current panel covers execution authorization and position visibility. It does not yet implement a user interface for fee collection, liquidity reduction or closing an NFT position. Those actions remain available only through the adapter's explicit user-approved contract methods or the canonical Uniswap interface.


## Position management and Gateway reconciliation

The Uniswap V3 adapter and Gateway now support three user-authorized position actions:

- **Collect fees:** collect accrued token0/token1 fees. The user chooses direct wallet delivery or Gateway credit.
- **Reduce liquidity:** remove a specified liquidity amount, collect the resulting principal and fees, and route both assets to the wallet or Gateway.
- **Close position:** remove all remaining liquidity, collect all owed tokens, burn the empty NFT and mark the registry entry closed. The user chooses wallet or Gateway delivery.

The dashboard displays active position metadata and exposes these actions. Before the adapter acts, the user must approve that exact NFT to the adapter (or have already granted operator approval). The UI asks for confirmation before granting a token-specific approval and before closing a position. The adapter verifies the registry owner, active status, NFT ownership and approval.

### Accounting model

At mint time the registry records the original Gateway input asset and the amount actually spent as that position's deployed cost basis. Unspent input is returned to the user's available Gateway balance by the existing execution path.

For a liquidity reduction, the adapter releases a proportional share of the recorded cost basis (all remaining basis when all liquidity is removed). On close it releases the full remaining basis. This is a cost-basis allocation, not a valuation of the NFT or a claim that the user has recovered that amount.

For each action the user explicitly chooses one destination:

- **Wallet:** collected tokens are sent directly to the connected user. The corresponding deployed cost basis is released from the Gateway's informational deployed bucket; no available Gateway balance is credited.
- **Gateway:** collected tokens are transferred into the ledger, which verifies receipt against custody liabilities and credits each supported token to the user's available balance. The associated deployed cost basis is reduced in the same transaction.

Fee collection does not reduce principal cost basis. Reduce/close amounts include both the decrease-liquidity proceeds and all fees collected in that transaction. All movements and registry updates are atomic: if token transfer or Gateway accounting fails, the entire action reverts.

### Operational boundaries

- The Gateway must have each token enabled before it can credit proceeds in that token. If a position includes an unsupported token, the user must choose wallet delivery or governance must first enable that asset.
- Partial cost-basis allocation is proportional to liquidity removed. It is an accounting convention, not a mark-to-market calculation.
- The position NFT is held by the user between actions. QROS cannot manage it without the user's explicit NFT approval.
- The UI now exposes explicit minimum token0/token1 output fields for reduce/close actions. Values are entered in raw token units; users should verify token decimals and choose meaningful bounds from a current quote before signing. The UI does not yet fetch or display a live quote.
- No automatic conversion between token0 and token1 is performed when proceeds return to Gateway. Each token is credited separately, preserving asset-specific accounting.
- Position actions, ledger crediting, and NFT lifecycle changes have been implemented but have not been compiled or exercised in this stage. They are not a production-readiness claim.
