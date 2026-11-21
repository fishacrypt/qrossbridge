# QMS / wQMS Gateway deployment and configuration orchestrator

The multi-chain orchestrator is `scripts/orchestrate-qms-gateway.js`. It deploys the chain-local QMS bridge attestation verifier and Gateway adapter where no addresses are recorded, reuses previously recorded deployments, then configures the full directed route matrix for the selected QMS Hub and Spokes.

## Prerequisites

- Compile the contracts first so `build/*.json` contains the current artifacts.
- Deploy the existing QMS bridge Hub and the Spokes using the existing deployment workflow. The Hub and Spoke contracts must be owned by the configured `OWNER_ADDRESS`.
- Deploy a `QrosGatewayLedger`, `QrosTransferCoordinator` and `QrosQuorumAttestationVerifier` on every chain to be included.
- The same owner key must control the Hub/Spoke bridge, Gateway ledger, transfer coordinator, settlement verifier, and newly deployed QMS adapter/verifier contracts.
- The deployer must have native gas on every configured chain.
- Use validator addresses controlled by the independent validator service. Never place validator private keys in this configuration or in the dApp.

## Configure

1. Copy `qms-gateway.config.example.json` to `qms-gateway.config.json`.
2. Replace the sample validator addresses with the actual validator addresses.
3. Set the threshold to the intended quorum. It must be at least one and no greater than the number of unique validators.
4. For each chain, enter the deployed Gateway ledger, transfer coordinator and settlement verifier addresses.
5. Ensure `deployments.json` contains the QMS Hub and every selected Spoke, including their bridge addresses and wQMS token addresses.
6. Add RPC overrides to `.env` if needed. The default endpoints are defined in `scripts/chains.js`.

Example chain entry:

```json
{
  "chainId": 84532,
  "ledger": "0x...",
  "coordinator": "0x...",
  "settlementVerifier": "0x..."
}
```

The example file intentionally contains placeholder values. It is not a ready-to-run deployment configuration.

## Run

From the `qrossbridge` package directory:

```sh
npm run compile
npm run orchestrate-qms-gateway
```

The script uses `DEPLOYER_KEY` from `.env` and requires it to match `OWNER_ADDRESS`. It reads:

- `QMS_GATEWAY_CONFIG` (default `qms-gateway.config.json`)
- `DEPLOYMENTS_FILE` (default `deployments.json`)
- `QMS_GATEWAY_DEPLOYMENTS_FILE` (default `qms-gateway-deployments.json`)

It writes the resulting chain-local verifier/adapter addresses and route matrix to the QMS Gateway manifest. Existing recorded adapter/verifier addresses are reused only after bytecode and ownership checks. The script does not silently replace an existing non-zero Gateway settlement adapter or coordinator configuration if it points somewhere else.

## What it configures

For every selected chain:

- Deploys or reuses `QrosQmsBridgeAttestationVerifier` and `QrosQmsBridgeAdapter`.
- Verifies chain ID, bridge ownership, Gateway ledger ownership, coordinator ownership and settlement verifier ownership.
- Verifies the Hub's wQMS identity or each Spoke's Hub chain ID and wrapped-token identity.
- Enables the local wQMS asset in the Gateway ledger.
- Sets the QMS adapter as the ledger's settlement adapter.
- Sets the existing transfer coordinator on the ledger and approves the adapter in that coordinator.
- Enables the adapter in the local Spoke's `gatewayAdapters` allowlist.
- Adds validator signers and applies the configured threshold to both verifier layers.

For every directed source/destination pair:

- Configures the source adapter's remote bridge, token, adapter and Gateway ledger.
- Enables the source-to-destination route in the destination settlement verifier.
- Enables the exact source-to-destination bridge endpoint/token/adapter route in the destination QMS bridge verifier.

It also enables Hub chain support for each configured Spoke. Configuration operations are idempotent when the on-chain values already match.

## Scope and safety

- The orchestrator deploys only the QMS bridge attestation verifier and QMS Gateway adapter. It does not deploy or replace the existing Hub, Spokes, wQMS, Gateway ledgers, coordinators or settlement verifiers.
- The script sends on-chain transactions. Review the config and manifest inputs before running it on a public testnet.
- A single owner key is assumed for this first orchestrator. If deployments use separate owners, transfer ownership or use a future multi-owner execution workflow rather than weakening owner checks.
- Validator allowlists and quorum thresholds are configured on-chain; this does not deploy validator monitoring, finality tracking, signing, key custody, slashing or incident response.
- Validator signatures remain an explicit trust assumption, not a trustless cross-chain proof.
- Post-dispatch refunds still require a real bridge-level return/refund state machine and terminal evidence. The orchestrator does not invent that capability.
- The orchestrator does not move user funds, create DeFi positions, or automatically execute a strategy.

## Output

`qms-gateway-deployments.json` records the owner, Hub ID, validator set, threshold, chain-local bridge/token/ledger/coordinator/verifier/adapter addresses and each enabled directed route. Treat this file as deployment state: back it up and keep it with the matching `deployments.json` and configuration file.
