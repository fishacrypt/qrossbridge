# QROS Stablecoin Gateway Settlement

This adds a dedicated stablecoin settlement rail to the replacement multi-asset Gateway ledgers on QMS Testnet (19480) and Base Sepolia (84532). It does not alter the existing QMS/wQMS adapter, legacy bridge contracts, legacy Gateway ledgers, or user balances.

## Settlement model

- Each chain has its own stablecoin contract and its own `QrosAttestedLiquidityAdapter`.
- Source transfers are held by the source adapter after the Gateway ledger finalizes the user's outbound transfer.
- The destination adapter releases the destination-chain stablecoin from its prefunded inventory only after a valid threshold-signed delivery attestation.
- Source escrow is released to the configured settlement treasury only after a separate threshold-signed outbound-settlement attestation.
- The destination adapter must be funded with local stablecoin inventory before transfers can be completed.
- This is a prefunded-liquidity, trusted-validator design. It is not a trustless light-client bridge, CCTP, or issuer-native burn/mint settlement.

## Configure

Keep the real values in the local `.env`; never commit them.

```dotenv
STABLECOIN_SYMBOL=USDT
STABLECOIN_QMS_ADDRESS=0x...
STABLECOIN_BASE_ADDRESS=0x...
STABLECOIN_QMS_TREASURY=0x...
STABLECOIN_BASE_TREASURY=0x...
```

Both token contracts must represent the same denomination and have matching decimals. The activation script checks contract code, token symbol, decimals, replacement-ledger ownership, coordinator bindings, and the existing validator quorum on both chains.

## Deploy and activate

From `qrossbridge/`:

```powershell
npm.cmd run compile
npm.cmd run activate-stablecoin-gateway
```

The script deploys or reuses one stablecoin adapter per chain, enables the stablecoin asset on the replacement ledgers, assigns the asset-specific settlement adapter, approves it in the coordinator, sets the configured treasury, and enables the two directional proof routes. It is resumable and writes `gateway-stablecoin-deployments.json` after deployment/configuration.

## Liquidity funding

Activation deliberately does not transfer or approve funds from an operator wallet. After the script completes, fund each adapter with its own chain's stablecoin inventory using the token's normal `approve(adapter, amount)` and `fundLiquidity(asset, amount)` calls. Start with a small test amount and maintain enough destination inventory for the intended transfer sizes.

Do not enable the asset in the production frontend or direct users to the replacement ledger until both adapter inventories, route configuration, validator operations, recovery procedures, and end-to-end test transfers have been reviewed.

## Attestation operations

The existing `scripts/settlement-attestation.js` provides EIP-712 helpers for:
- `deliveryProof`: destination-chain proof that releases destination liquidity and credits the recipient's Gateway ledger.
- `outboundSettlementProof`: source-chain proof that releases the source escrow to the configured settlement treasury.
- `cancellationProof` and `recoveryProof`: terminal cancellation/recovery evidence.

Validator keys must remain in a trusted validator/operations environment, never in the browser. Validators must independently reconcile the source escrow and destination delivery before signing. The currently configured 2-of-3 testnet signer set is a centralized bootstrap if the signers are controlled by one operator; it must not be represented as independent decentralized validation.

## Cutover boundary

The workflow targets only `gateway-migration-deployments.json` replacement contracts. It does not migrate balances, change the live QROS app's production ledger configuration, merge PR #7, or authorize production cutover. User balances remain on their existing ledgers until a separate user-authorized migration is designed and completed.
