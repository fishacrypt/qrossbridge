# QROS cross-chain Gateway-to-execution handoff

Status: quorum-attested prefunded-liquidity adapter implemented as a concrete reference settlement path. It is not a trustless bridge, a direct QMS Bridge integration, or a CCTP implementation. Destination deployments, validator operations and route funding remain integration requirements.

## Intended user journey

1. The user holds an available balance on the source Gateway ledger.
2. The user selects a configured route whose `destinationLedger` is the verified Gateway ledger on the destination chain.
3. The dApp calls `QrosTransferCoordinator.requestGatewayHandoff`. The source ledger atomically moves the user's source asset from `available` to `inTransit`. The transfer intent binds the source token, amount, destination chain ID, destination token, destination ledger, user and approved settlement adapter.
4. The user separately calls `initiate(transferId)`. The coordinator calls the approved adapter. The adapter must read the immutable transfer intent from the coordinator and start the actual bridge settlement.
5. The source settlement adapter finalizes the source ledger transfer only when it atomically receives the source tokens and dispatches them into the bridge. The source asset leaves source custody and the source `inTransit` liability is retired.
6. The destination settlement adapter independently verifies the bridge's authenticated message, source domain, destination domain, transfer ID, recipient ledger, destination token, amount and finality. It must ensure the destination tokens have arrived, transfer them to the destination Gateway ledger, then call `creditInboundTransfer(transferId,user,destinationAsset,receivedAmount,sourceChainId)` in the same transaction.
7. The destination ledger's replay protection credits the same EVM wallet address to `available`. The user switches their wallet to the destination chain and sees the new asset balance.
8. The user separately selects an approved local execution strategy (for example, Uniswap V3), reviews its parameters and signs the destination-chain EIP-712 intent. The execution router reserves the destination available balance and invokes the destination execution adapter. A bridge handoff never auto-executes a strategy.

## Route configuration

Add a route only after all contracts and tokens have been verified on both networks:

```js
{
  id: "qms-to-base-gateway",
  label: "QMS Testnet → Base Sepolia · Gateway",
  sourceAsset: "0x<source-token>",
  destinationChainId: 84532,
  destinationAsset: "0x<destination-token>",
  destinationSymbol: "USDC",
  destinationLedger: "0x<destination-QROS-ledger>",
  adapter: "0x<approved-source-settlement-adapter>"
}
```

When `destinationLedger` is configured, the dApp calls `requestGatewayHandoff` and the destination ledger address is the settlement recipient. Without it, the existing `requestTransfer` wallet-recipient path remains available. The route's source asset must be configured in the source dApp's `assets` list and enabled on the source ledger. The destination asset must be enabled on the destination ledger. The same wallet address is the destination beneficiary; no destination wallet address field is required for a Gateway handoff.

The destination chain must independently deploy/configure:
- its own `QrosGatewayLedger`, with the destination asset enabled;
- a destination settlement adapter authorized as that ledger's `settlementAdapter`;
- the same bridge-specific message verification and replay-protection scheme;
- the execution router and strategy adapter if the user intends to execute there.

## Required settlement adapter contract

The concrete `QrosAttestedLiquidityAdapter` implements the current reference settlement path. It escrows the exact source token on the source chain, releases pre-funded destination inventory only after a threshold EIP-712 validator attestation, and releases source escrow to the configured treasury only after a matching outbound-settlement attestation. It supports Gateway handoff by binding both the destination ledger and the original user beneficiary in its escrow record and proof. It is a prefunded-liquidity settlement service, not a token-lock-and-mint light client.

The generic `IQrosSettlementAdapter` boundary remains the extension point for a native bridge/CCTP adapter. Any production adapter must:
- be approved by the source `QrosTransferCoordinator`;
- be the source ledger's configured `settlementAdapter` before it can finalize source custody;
- read the coordinator's `getTransfer(transferId)` record and reject mismatched chain/token/recipient fields;
- dispatch exactly the reserved amount and record the underlying bridge message identifier;
- never finalize the source transfer before the bridge has accepted the source tokens;
- verify destination message authenticity and finality using the selected protocol's canonical verifier, or an explicitly disclosed validator quorum where no on-chain proof system exists;
- verify the destination ledger, token, amount, source chain and beneficiary against the original intent; the current EIP-712 delivery and outbound-settlement attestations bind all of these fields, including the destination ledger;
- transfer destination tokens into the destination ledger and call `creditInboundTransfer` atomically;
- use a globally unique transfer identifier and bridge-native replay protection;
- support only bridge-authenticated terminal recovery. Cancellation is allowed only before irreversible source dispatch; post-dispatch recovery must return the exact source asset before calling `recoverFinalizedOutboundTransfer`.

The current coordinator `initiate` call is orchestration only. It does not prove settlement. The ledger's `creditInboundTransfer` is an adapter-gated accounting primitive, not a proof verifier. The current quorum verifier authenticates EIP-712 signatures from configured validators; validators must independently inspect source and destination chain state, bridge message IDs, finality and token receipts. A quorum signature is a trust assumption, not cryptographic proof of chain consensus. Do not deploy a permissive adapter that accepts arbitrary proof bytes or trusts a single relayer.

## User-visible lifecycle

- Requested: source amount reserved; available decreases and inTransit increases.
- Initiated: adapter was asked to start settlement; not proof of bridge dispatch.
- Source dispatched: source ledger finalized and source tokens left custody.
- Destination credited: destination ledger emitted `InboundTransferCredited`; available balance is now spendable on the destination chain.
- Recovered/cancelled: source funds returned to available after a valid terminal recovery path.

The current browser history reads source-chain coordinator/ledger events. It cannot independently query another chain unless a separately configured destination RPC/indexer is added. After source dispatch, the user must switch to the destination network and refresh the Gateway dashboard to verify destination credit. Do not display "complete" based only on `TransferInitiated` or `OutboundTransferFinalized`.

## QMS / CCTP constraint

This handoff abstraction is bridge-neutral. It does not imply that QMS Testnet is a native Circle CCTP domain. QMS-to-Base must remain disabled for CCTP labeling unless Circle confirms support for QMS and the exact source token. A different bridge can be used only through its own authenticated, reviewed settlement adapter.

## Acceptance invariants before enabling a route

- source request reduces only the initiating user's available balance;
- transfer ID cannot be reused;
- only approved coordinator adapter can initiate;
- only configured source settlement adapter can finalize/cancel/recover;
- no destination credit before authenticated destination settlement;
- destination replay attempt cannot credit twice;
- destination ledger receives exact supported destination token amount;
- destination credit belongs to the original user;
- user can choose not to execute and retain the destination available balance;
- execution requires a separate destination-chain user signature, nonce, strategy allowlist and deadline;
- a failed destination proof leaves the transfer pending/recoverable, never falsely credited.

No chain-specific adapter, destination deployment, compilation, test or live transaction is claimed by this document.


## Concrete reference adapter and validator operations

The implemented reference contracts are:
- `contracts/adapters/QrosSettlementAdapterBase.sol`: coordinator intent binding, source ledger finalization, proof-gated destination credit and cancellation/recovery state transitions.
- `contracts/adapters/QrosAttestedLiquidityAdapter.sol`: source escrow, route allowlisting, prefunded destination inventory, destination delivery and source treasury settlement.
- `contracts/settlement/QrosQuorumAttestationVerifier.sol`: threshold EIP-712 signatures with signer ordering, expiry, chain/verifier domain separation and route allowlisting.
- `scripts/settlement-attestation.js`: off-chain EIP-712 proof encoding helpers. Validator private keys must remain in a secured validator environment and must never be placed in the dApp.
- `test/settlement-adapter.js`: isolated two-chain Ganache scenarios for Gateway handoff, beneficiary credit, destination replay rejection, source escrow release, pre-dispatch cancellation and post-dispatch recovery.

Delivery and outbound-settlement signatures bind the transfer ID, source and destination chain IDs, source and destination token addresses, original beneficiary, destination Gateway ledger, exact amount and deadline. A proof for another destination ledger or beneficiary must not verify. The verifier route key includes the destination ledger.

The current adapter's economic model is prefunded liquidity: destination inventory must be funded before delivery. Source escrow is held until validators attest destination completion, then released to a configured treasury. This is not the same as burning/minting through the existing QMS bridge. The existing QMS bridge moves native QMS/wQMS and uses a trusted relayer; it does not natively transport arbitrary USDC assets. A separate QMS bridge adapter must be written and reviewed before connecting these Gateway balances to that bridge.

### Deployment/configuration order (per chain)

1. Deploy the Gateway ledger and enable the exact token.
2. Deploy the chain's quorum verifier, configure the validator set and a threshold lower than or equal to the signer count.
3. Deploy the settlement adapter with that ledger, verifier and coordinator addresses.
4. Set the ledger's settlement adapter and transfer coordinator; approve the adapter in the coordinator.
5. On the source adapter, enable the exact source-token/destination-chain/destination-token route and configure the settlement treasury.
6. On both source and destination verifiers, enable the matching route including the destination ledger address.
7. Fund the destination adapter with the exact destination token inventory before accepting transfers.
8. Configure the dApp route with the source asset, destination chain, destination asset, destination ledger and approved source adapter.

Do not enable a route until independent validators, key custody, quorum rotation, liquidity monitoring, treasury controls, emergency pause and proof/recovery runbooks are operational. The code is a reference implementation and has not been security-audited.
