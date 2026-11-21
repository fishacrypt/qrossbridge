# QMS / wQMS Gateway settlement adapter

## Scope

`QrosQmsBridgeAdapter` is the chain-specific adapter for the existing QMS Testnet Hub and remote wQMS Spokes. It is separate from the generic prefunded stablecoin liquidity adapter.

Supported route shape:
- QMS Hub (chain ID 19480) -> one configured remote Spoke (Sepolia, Base Sepolia, Arbitrum Sepolia or OP Sepolia): the source adapter transfers hub wQMS into `QmsBridgeHub.depositWQMS`; the Hub unwraps it into its native QMS pool and emits the standard `Bridged` event. The existing relayer mints remote wQMS to the destination QROS adapter.
- Remote Spoke -> QMS Hub: the source adapter calls the new allowlisted `QmsBridgeSpoke.bridgeBackFor`, which burns the adapter's wQMS and emits the standard `Bridged` event. The existing relayer calls the Hub release path and delivers hub wQMS to the destination QROS adapter.
- The destination adapter transfers the received local wQMS into its Gateway ledger, then the shared settlement base credits the original wallet's destination-chain balance.

This implementation deliberately supports Hub <-> Spoke paths. It does not claim direct spoke-to-spoke settlement.

## New contracts and helpers

- `contracts/adapters/QrosQmsBridgeAdapter.sol`: source dispatch and destination wQMS release adapter.
- `contracts/settlement/QrosQmsBridgeAttestationVerifier.sol`: threshold EIP-712 verifier binding both chain IDs, both bridge endpoints, source and destination adapter addresses, both wQMS token addresses, beneficiary, amount, bridge message ID and expiry.
- `contracts/interfaces/IQrosQmsBridgeProofVerifier.sol`: bridge proof interface.
- `contracts/QmsBridgeSpoke.sol`: owner-controlled Gateway adapter allowlist and `bridgeBackFor`, allowing only an approved adapter to burn the wQMS it holds. The original user-facing `bridgeBack` path is unchanged.
- `scripts/qms-bridge-attestation.js`: validator proof signing and combined proof encoding helper.

## Proof and trust model

The QMS bridge contracts do not expose a cross-chain light-client proof. Therefore the destination adapter requires a separate QMS bridge attestation in addition to the generic Gateway settlement attestation.

The validator quorum must independently verify:
1. The source chain's exact `Bridged` event, including its source chain, nonce-derived message ID, sender adapter, destination chain, destination adapter recipient, amount and source token context.
2. The destination chain's corresponding message was actually consumed by the correct Hub/Spoke endpoint and the correct amount of wQMS was minted or released to the destination adapter.
3. The destination adapter holds the exact local wQMS amount before it submits the proof.

The bridge message ID is the existing bridge's `keccak256(abi.encode(sourceChainId, nonce))`. The verifier checks EIP-712 quorum signatures and route allowlisting. It cannot independently query the other chain. A validator quorum is a disclosed trust assumption, not cryptographic proof of finality. Never treat a relayer log or a single operator signature as sufficient proof.

The combined `proveAndFinalize` proof is ABI-encoded as `(bytes gatewaySettlementProof, bytes qmsBridgeProof)`. The settlement proof binds the original Gateway transfer and destination ledger; the QMS proof binds the underlying Hub/Spoke event and destination processing.

## Deployment and route configuration

Deploy one adapter and one QMS bridge attestation verifier on each participating chain. Constructor arguments for each adapter:
- owner;
- local QROS Gateway ledger;
- local generic settlement verifier;
- local transfer coordinator;
- local QMS bridge attestation verifier;
- QMS Hub chain ID (19480);
- canonical QMS Hub bridge address;
- canonical Hub wQMS token address;
- local bridge endpoint address (Hub on QMS, Spoke on remote chain);
- local wQMS token address (Hub wQMS on QMS, Spoke token on remote chain).

Deploy using `npm run compile`, then set these per-chain values in the protected local `.env` file and run `npm run deploy-qms-gateway-adapter`:

- `RPC_URL`, `DEPLOYER_KEY`, optional `OWNER_ADDRESS`;
- `QROS_GATEWAY_LEDGER`, `QROS_SETTLEMENT_VERIFIER`, `QROS_TRANSFER_COORDINATOR`;
- `QMS_HUB_CHAIN_ID=19480`, `QMS_HUB_BRIDGE`, `QMS_HUB_WQMS`;
- `QMS_LOCAL_BRIDGE`, `QMS_LOCAL_WQMS`;
- optional `QMS_ATTESTATION_THRESHOLD` (defaults to 2).

The command deploys the QMS-specific attestation verifier and adapter only. It does not configure signers, routes, ledger permissions, coordinator approval or the spoke adapter allowlist. Keep `.env` private and never commit the deployer or validator keys.

Then configure each adapter's remote route using the other chain's bridge endpoint, wQMS token, QROS adapter address and destination Gateway ledger address. For a given source/destination pair, configure the matching route on both adapters and configure the QMS bridge verifier's route on the destination chain with:
- source and destination chain IDs;
- source and destination bridge addresses;
- source and destination wQMS token addresses;
- source and destination QROS adapter addresses.

Add the local spoke adapter to `QmsBridgeSpoke.setGatewayAdapter(adapter, true)`. The hub does not need this role because `depositWQMS` uses ERC-20 allowance and its existing user-facing flow. The existing Hub must already have remote chain support enabled.

The existing QROS setup is also required:
- source and destination ledgers enable their local wQMS token;
- source and destination ledgers authorize their local settlement adapter;
- source ledger points to its transfer coordinator;
- source coordinator approves its adapter;
- generic settlement verifier routes are configured with the destination ledger;
- QMS bridge attestation verifier signer sets, threshold and route are configured;
- destination adapter receives the remote bridge mint/release as its recipient.

## Operational and safety limitations

- The existing QMS bridge relayer remains trusted to submit the destination mint/release transaction. The validator quorum independently checks that it actually succeeded before the Gateway ledger credits the user.
- Source finalization and bridge dispatch occur in one EVM transaction. If dispatch reverts, ledger finalization rolls back.
- The QMS bridge has no native automated refund/cancel path after a successful source dispatch. The adapter's recovery hook only restores funds after the exact wQMS is returned to the source adapter through a separately authorized recovery operation. Do not promise automatic recovery or use a timeout alone to refund.
- A pre-dispatch cancellation can restore the source Gateway balance through the generic settlement verifier's cancellation authorization.
- Only the QMS Hub <-> remote Spoke directions are covered. Cross-spoke routing needs an additional settlement design.
- QMS/wQMS is not USDC. Do not label these routes as CCTP or stablecoin settlement.
- The source and destination token addresses must be the actual deployed wQMS contracts. Do not use the native QMS currency address as an ERC-20 ledger asset.
- The adapter and verifier are reference code and have not been audited. Do not enable routes with production value before compilation, integration tests, relayer compatibility review, independent validator operations and a security review.

## User experience

A Gateway handoff reserves the source wQMS balance. Once the Hub/Spoke bridge has completed and the quorum proof is submitted, the destination adapter credits the same EVM wallet address with destination wQMS in the destination Gateway ledger's `available` bucket. The user can keep that balance idle or separately authorize a supported execution strategy. No automatic DeFi position is created by bridging.
