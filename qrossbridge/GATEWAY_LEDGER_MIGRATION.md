# QROS Gateway Ledger Migration

## Purpose

This workflow deploys a replacement multi-asset Gateway architecture alongside the existing QMS and Base Sepolia deployments. It does not replace, pause, drain, or modify the existing Gateway contracts.

## Why a replacement is required

The currently deployed QMS ledger exposes the legacy single `settlementAdapter()` interface but the intended source adds the per-asset `settlementAdapters(address)` mapping and `setSettlementAdapterForAsset(address,address)`. The migration deploys the current repository implementation so each supported asset can use its own settlement rail.

## Deployment

From `qrossbridge/`:

1. Pull branch `qros-gateway-ledger-migration`.
2. Keep the existing local `.env`; the script uses `QMS_OWNER_KEY`, `BASE_OWNER_KEY`, `RPC_19480`, and `RPC_84532`.
3. Run `npm.cmd run compile`.
4. Run `npm.cmd run deploy-gateway-migration`.

The deployment script is resumable. Each successful contract deployment is written immediately to `gateway-migration-deployments.json`. Re-running it reuses recorded addresses after checking that code exists.

## Contracts deployed per chain

- QMS Testnet (19480): Gateway ledger, transfer coordinator, settlement verifier, QMS bridge verifier, QMS bridge adapter.
- Base Sepolia (84532): the same contracts, plus execution router and position registry.

All immutable dependencies are bound to the replacement ledger. The QMS bridge adapters reference the existing legacy Hub/Spoke bridge endpoints and wQMS tokens.

## What this stage deliberately does not do

- Does not modify `gateway-core-deployments.json` or `deployments.json`.
- Does not set supported assets or ledger adapter permissions.
- Does not approve coordinator adapters or enable bridge routes.
- Does not add validators or enable a proof route.
- Does not configure Uniswap or execute any DeFi strategy.
- Does not move or migrate any user's balance.

## Balance and cutover safety

Existing user balances remain recorded in the old ledgers. They cannot be copied by changing a deployment manifest: the ledger stores per-user accounting internally and has no owner-operated balance migration function. Do not direct users to the replacement ledgers or retire the old ledgers after deployment.

A separate, reviewed user migration flow is required. It should let each user withdraw from the old ledger and deposit into the replacement ledger, or use a dedicated audited migration mechanism with explicit user authorization and reconciled token liabilities. Keep the old frontend/ledger available until that process is complete.

## Next stages

1. Deploy and verify replacement contracts with this script.
2. Configure the new ledgers' transfer-coordinator pointers and supported wQMS assets.
3. Configure per-asset QMS settlement adapters, coordinator approvals, validators, and exact proof routes.
4. Configure Base execution separately; strategy approvals remain explicit and user-authorized.
5. Implement and review the user balance migration and frontend cutover before treating the replacement Gateway as production-ready.
