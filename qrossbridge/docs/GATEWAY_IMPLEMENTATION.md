# QROS Gateway implementation notes

This document describes the implementation modules on `qros-unified-gateway-architecture`. The code is an implementation in progress and has not yet passed a consolidated compile, test, security or deployment review.

## Contracts added

- `QrosGatewayLedger.sol`: user/asset accounting buckets, custody liabilities, deposits, withdrawals, transfer lifecycle, adapter-gated inbound credit, execution reservations and atomic adapter execution.
- `QrosTransferCoordinator.sol`: creates user-scoped outbound transfer intents, reserves the user's ledger balance and invokes an approved settlement adapter.
- `QrosExecutionRouter.sol`: EIP-712 signed execution intents. The signature binds user, asset, amount, strategy ID, adapter-data hash, nonce and deadline. Execution is atomic through the ledger.
- `QrosPositionRegistry.sol`: records external position metadata and lifecycle status.
- `adapters/UniswapV3LiquidityAdapter.sol`: single-input-token flow that can swap part of the input through Uniswap V3 SwapRouter, mint a V3 position through NonfungiblePositionManager, register it and transfer the NFT to the user's address.
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

- The Uniswap adapter implements position opening, not full position close, fee collection, partial withdrawal or returned-asset accounting. These are required before the lifecycle can be considered complete.
- The position registry records NFT metadata; it is not a valuation oracle and does not calculate current USD value, fees earned or impermanent loss.
- The ledger's `deployed` bucket is an informational principal record, not a spendable token balance or redeemable claim.
- The current execution adapter is configured by the ledger owner. Production needs a multisig/timelock, narrowly scoped roles, emergency controls and independent security review.
- The transfer coordinator is an orchestration boundary, not a bridge proof verifier. A real settlement adapter must independently verify finality, source message authenticity, destination mint/receipt, replay protection and recovery before finalizing a transfer.
- QMS Testnet is not currently established as a Circle CCTP-supported source. Do not configure or describe QMS-to-Base as native CCTP without explicit Circle confirmation for QMS and the exact token contract.
- Do not deploy or enable these modules for real-value use until the consolidated compile, unit/fuzz/invariant/integration tests, official protocol-address verification and independent audit are complete.

## Validation status

No compile or test result is claimed for these additions yet. Per the agreed workflow, implementation is being completed before the next consolidated environment-validation pass.
