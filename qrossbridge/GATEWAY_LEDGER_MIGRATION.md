# QROS Gateway Ledger Migration

## Purpose

This workflow deploys a replacement multi-asset Gateway architecture alongside the existing QMS and Base Sepolia deployments. It does not replace, pause, drain, or modify the existing Gateway contracts.

## Why a replacement is required

The currently deployed QMS ledger exposes the legacy single `settlementAdapter()` interface, while the intended source includes per-asset `settlementAdapters(address)` and `setSettlementAdapterForAsset(address,address)`. The replacement uses the current multi-asset source so each supported asset can have its own settlement rail.

## Deployment

From `qrossbridge/`:

1. Pull branch `qros-gateway-ledger-migration`.
2. Keep the existing local `.env`; the script uses `QMS_OWNER_KEY`, `BASE_OWNER_KEY`, `RPC_19480`, and `RPC_84532`.
3. Run `npm.cmd run compile`.
4. Run `npm.cmd run deploy-gateway-migration`.

The deployment script is resumable. Each successful deployment is written immediately to `gateway-migration-deployments.json`. Re-running it reuses recorded addresses after checking that code exists.

## Contracts deployed per chain

- QMS Testnet (19480): Gateway ledger, transfer coordinator, settlement verifier, QMS bridge verifier, QMS bridge adapter.
- Base Sepolia (84532): the same contracts, plus execution router and position registry.

All immutable dependencies are bound to the replacement ledger. The QMS bridge adapters reference the existing legacy Hub/Spoke bridge endpoints and wQMS tokens.

## Safe baseline applied to replacement ledgers

After deployment, the script:
- Connects each replacement ledger to its replacement transfer coordinator.
- Enables that chain's wQMS asset.
- Assigns the QMS bridge adapter as the wQMS-specific settlement adapter.
- Approves that adapter in the replacement coordinator.
- Connects the Base replacement ledger to its replacement execution router.

These settings apply only to the new contracts. The bridge proof verifiers have no configured signers, and no cross-chain proof routes or remote adapter routes are enabled. Cross-chain settlement therefore remains unavailable until the separate activation workflow is completed. The Base execution adapter and strategy are also not configured or approved.

## Activation and Uniswap

After the replacement deployment script completes, `activate-qms-gateway.js` automatically uses `gateway-migration-deployments.json` and `gateway-migration-adapter-preparations.json` when both exist. It writes its result to `gateway-migration-activations.json`. Real validator addresses and threshold must be supplied in `gateway-validator.config.json` first.

`configure-uniswap-execution.js` uses the migration deployment manifest when present. It still requires valid Base Sepolia Uniswap router, position manager, token, pool, and strategy configuration. Strategy approval remains explicit.

## What this workflow does not do

- Does not modify `gateway-core-deployments.json` or `deployments.json`.
- Does not move or migrate user balances.
- Does not enable validator signers or proof routes during deployment.
- Does not execute a DeFi strategy or move user funds into a position.

## Balance and cutover safety

Existing user balances remain recorded in the old ledgers. They cannot be copied by changing a deployment manifest: the ledger stores per-user accounting internally and has no owner-operated balance migration function. Do not direct users to the replacement ledgers or retire the old ledgers after deployment.

A separate, reviewed user migration flow is required. It should let each user withdraw from the old ledger and deposit into the replacement ledger, or use a dedicated audited migration mechanism with explicit user authorization and reconciled token liabilities. Keep the old frontend/ledger available until that process is complete.
