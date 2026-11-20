# QMS / wQMS Gateway adapter integration harness

The harness in `test/qms-gateway-adapter.js` exercises the dedicated QMS Gateway adapter against two isolated local EVMs. It deploys the repository's actual `QmsBridgeHub`, `QmsBridgeSpoke`, `WrappedQMS`-compatible hub token, Gateway ledgers, transfer coordinators, settlement verifiers, bridge attestation verifiers and QMS adapters. It also runs the production `Relayer` implementation against those local bridge deployments.

## Run

From the `qrossbridge` package directory:

```sh
npm run compile
npm run test:qms-adapter
```

The focused harness is also included at the end of the consolidated `npm test` suite. It does not use public RPC endpoints, testnet deployments, wallet secrets from `.env`, or real funds. Ganache accounts and a temporary relayer state file are created for the run and discarded afterward.

## Coverage

1. **Hub to Spoke Gateway handoff**
   - User deposits hub wQMS into the Hub Gateway ledger.
   - Coordinator records the Gateway-to-Gateway intent.
   - Hub adapter finalizes source custody and dispatches through `depositWQMS`.
   - Production relayer observes the canonical Hub `Bridged` event and calls the Spoke mint path.
   - Destination adapter requires both the QROS settlement attestation and the QMS bridge-delivery attestation before transferring wQMS into the destination ledger and crediting the user.

2. **Spoke to Hub Gateway handoff**
   - Destination Spoke adapter burns its escrowed wQMS through the explicitly authorized `bridgeBackFor` entry point.
   - Production relayer observes the Spoke `Bridged` event and releases hub wQMS to the Hub adapter.
   - Hub adapter verifies both attestations, moves the delivered token into the Hub ledger and credits the same user.

3. **Negative and replay cases**
   - A bridge proof naming the wrong delivery beneficiary is rejected.
   - A second inbound finalization for the same transfer is rejected.
   - A second Spoke mint for an already processed bridge nonce is rejected.
   - Replaying the reverse-direction proof is rejected.

4. **Cancellation and recovery**
   - A pre-dispatch cancellation with a valid source-chain cancellation attestation restores the reserved Gateway balance.
   - A post-dispatch recovery proof alone cannot restore funds.
   - Recovery succeeds only after the exact wQMS amount is returned to adapter custody and then transferred back to the ledger.

5. **Relayer idempotency**
   - A subsequent scan does not deliver either bridge message a second time.

## Attestation and trust boundary

The QMS bridge verifier uses sorted EIP-712 validator signatures over the transfer ID, both chain IDs, both bridge endpoints, both adapters, both token contracts, the adapter custody beneficiary, amount, bridge message ID and deadline. The settlement verifier separately binds the Gateway user, source asset, destination asset, amount and destination ledger; the adapter also requires the source token in the bridge attestation to equal the source asset in the settlement attestation.

This is a validator-attested model, not a trustless cross-chain light client. Validators must independently reconcile the source `Bridged` event and the destination bridge's processed/minted/released state before signing. The harness signs proofs directly with a local validator key only to exercise the verification path; it does not implement a production validator monitoring service or key-management system.

## Recovery limitation

The current Hub/Spoke protocol does not expose a complete on-chain post-dispatch refund protocol for an already consumed bridge message. Accordingly, the harness tests the adapter's critical safety condition by simulating the authenticated return leg as the exact wQMS arriving in adapter custody. It deliberately does not claim that the ordinary relayer can automatically refund an in-flight or delivered transfer. A production recovery flow still needs an explicit bridge-level return/refund state machine and independently verifiable terminal evidence.

## Adapter route configuration

Each adapter's `remoteRoutes[chainId]` entry describes the remote chain's bridge, token, adapter and Gateway ledger. For an inbound proof, the configured remote route is the **source** endpoint; the destination ledger is independently bound by the settlement proof and the local adapter's immutable ledger. The bridge delivery beneficiary is the **destination adapter**, because the relayer delivers tokens to adapter custody before the adapter transfers them into the ledger. The integration harness exercises these distinctions in both directions.
