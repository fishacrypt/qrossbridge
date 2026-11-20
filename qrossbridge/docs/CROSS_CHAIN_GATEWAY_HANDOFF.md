# QROS cross-chain Gateway-to-execution handoff

Status: contract and dApp handoff interface implemented; chain-specific settlement adapter and destination deployments remain integration requirements.

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

The generic `IQrosSettlementAdapter` boundary is deliberately not a bridge implementation. A production adapter must:
- be approved by the source `QrosTransferCoordinator`;
- be the source ledger's configured `settlementAdapter` before it can finalize source custody;
- read the coordinator's `getTransfer(transferId)` record and reject mismatched chain/token/recipient fields;
- dispatch exactly the reserved amount and record the underlying bridge message identifier;
- never finalize the source transfer before the bridge has accepted the source tokens;
- verify destination message authenticity and finality using the bridge's canonical verifier, not a relayer-supplied boolean;
- verify the destination ledger, token, amount, source chain and beneficiary against the original intent;
- transfer destination tokens into the destination ledger and call `creditInboundTransfer` atomically;
- use a globally unique transfer identifier and bridge-native replay protection;
- support only bridge-authenticated terminal recovery. Cancellation is allowed only before irreversible source dispatch; post-dispatch recovery must return the exact source asset before calling `recoverFinalizedOutboundTransfer`.

The current coordinator `initiate` call is orchestration only. It does not prove settlement. The ledger's `creditInboundTransfer` is an adapter-gated accounting primitive, not a proof verifier. Do not deploy a permissive adapter that accepts arbitrary proof bytes or trusts the relayer.

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
