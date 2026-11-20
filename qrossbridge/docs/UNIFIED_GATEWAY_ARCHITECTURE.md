# QROS Unified Gateway Architecture

Status: proposed implementation architecture  
Target environment: QMS Testnet (19480) and Base Sepolia (84532)  
Initial asset: QMS USDC -> Base USDC  
Initial strategy: Uniswap V3 ETH/USDC liquidity position

## Product rule

The Gateway is a persistent, user-owned balance layer. A deposit creates an available balance claim for the user. It does not automatically deploy funds into a protocol. DeFi execution happens only after the user selects a strategy, reviews its parameters and authorizes that exact execution.

A Gateway balance is an accounting claim, not a promise that the same physical token units remain on every chain. The system must always distinguish available, in-transit, reserved and deployed value.

## Current implementation boundary

The current QROS execution MVP is not this architecture yet:

- `QrosIntentGateway` accepts a request and transfers source tokens to a configured LP address.
- `QrosLiquidityVault` reserves prefunded destination stablecoins and represents them as withdrawable test positions.
- `execution-runner.js` coordinates those two contracts.
- The existing destination vault does not call Uniswap, swap USDC for ETH, mint an LP NFT or maintain a persistent cross-chain Gateway balance.
- The existing execution route uses a configured destination liquidity pool and is not a native Circle CCTP implementation.

Do not describe the current MVP as CCTP-powered Uniswap execution until those integrations are actually deployed and verified.

## Target architecture

### 1. Gateway accounting

Introduce a Gateway accounting contract with per-user, per-asset, per-chain ledger buckets:

- `available`: deposited and settled funds the user can allocate.
- `inTransit`: funds committed to a cross-chain transfer but not yet confirmed at destination.
- `reserved`: funds earmarked for an approved execution, not yet consumed.
- `deployed`: value allocated to an active strategy position. Track the position separately; do not count it as available USDC.
- `withdrawable`: optional derived view of settled available funds, less outstanding authorizations.

Required invariants:

1. A unit of value can exist in only one accounting bucket at a time.
2. A transfer moves value from available to inTransit once, using a unique transfer ID.
3. A verified destination settlement moves the corresponding value from inTransit to available on the destination ledger.
4. An execution authorization moves value from available to reserved.
5. Successful execution consumes reserved value and records the resulting position under the user's ownership.
6. A failed or expired execution releases reserved value only after the adapter confirms that no irreversible external action occurred.
7. Refunds and replay protection are keyed by globally unique IDs and are idempotent.
8. Token decimals, actual received amounts, fees and slippage must be accounted for explicitly.

The ledger should use token amounts per chain and asset. Do not aggregate unlike assets into a single numeric balance. A portfolio valuation in USD may be shown as an estimate, separately from token-denominated balances.

### 2. Cross-chain settlement adapter

Create a settlement interface so the Gateway is not coupled to one bridge:

- `initiateTransfer(transferId, user, sourceToken, amount, destinationChain, destinationToken, recipient)`
- `proveAndFinalize(transferId, proof)`
- `refundOrRecover(transferId)` where supported by the underlying bridge and only after a provable terminal failure.

CCTP adapter requirements:

- Verify that QMS is a Circle-supported CCTP domain and that the QMS USDC contract is the genuine Circle-issued token with the required TokenMessenger / MessageTransmitter integration.
- Verify Base Sepolia's CCTP domain, USDC contract and current testnet deployment addresses from Circle's official deployment information before configuration.
- If QMS is not supported by native CCTP, do not label the route CCTP. Use an explicitly named, separately audited bridge adapter or keep the route disabled.
- On a native CCTP route, burn on the source domain, obtain the Circle attestation, and mint on the destination domain. Verify message integrity, destination domain, recipient, amount and replay protection.
- A relayer may transport messages and submit transactions, but must not be able to invent settlement or credit balances without valid proof.
- Do not assume that an existing QMS USDC token is CCTP-compatible merely because it is called USDC.

### 3. Execution authorization

Each strategy request must contain a typed, reviewable intent:

- owner/user
- source and destination chain IDs
- input token and maximum input amount
- strategy adapter and strategy identifier
- protocol and pool identifier
- token pair, fee tier and tick range (for Uniswap V3)
- minimum output / minimum liquidity constraints
- maximum slippage and deadline
- recipient of the position NFT
- nonce and expiry

The user signs the exact intent. The Gateway verifies the signature, nonce, expiry, supported strategy and available balance before reserving funds. A generic unlimited approval is not acceptable. Prefer exact approvals or Permit2 with bounded amount and expiry where supported.

### 4. Uniswap V3 adapter (Base Sepolia)

The first strategy adapter should:

1. Receive only the amount reserved for the signed user intent.
2. Obtain a quote and execute a USDC -> WETH swap subject to minimum output, deadline and slippage limits. If the position can be funded with a single-sided deposit, the adapter may use a protocol-supported flow, but must disclose resulting exposure.
3. Approve only the exact WETH and USDC amounts required by the Position Manager.
4. Call the official Uniswap V3 NonfungiblePositionManager for the verified Base Sepolia deployment.
5. Set the NFT recipient to the user's wallet, unless the user explicitly opts into a clearly disclosed custody model.
6. Verify the minted token ID, pool, token pair, fee tier, liquidity and owner from the resulting on-chain position.
7. Record the NFT token ID and position metadata against the user's Gateway account.
8. Return unused dust to the user's available Gateway balance or wallet according to the signed intent.

Do not hardcode deployment addresses from memory. Confirm the official Uniswap deployment addresses and that the selected pool exists on Base Sepolia before enabling the adapter.

The LP NFT represents a concentrated-liquidity position, not a fungible receipt for a fixed USDC amount. Its value changes with pool price, fees, impermanent loss and out-of-range exposure. Explain that to the user before authorization.

### 5. Position and balance lifecycle

Suggested state machines:

Transfer:
`None -> Initiated -> SourceConfirmed -> Attested -> DestinationFinalized -> Credited`
Terminal recovery states must be explicit and bridge-specific.

Execution:
`None -> Authorized -> Reserved -> Executing -> Completed`
Failure path:
`Authorized/Reserved -> Failed -> Released`
Do not permit a relayer to mark an external execution complete without verifying the destination transaction and resulting position.

Position:
`None -> Active -> DecreaseLiquidity/CollectFees -> Closed`
The position record must preserve NFT contract, token ID, chain ID, pool, token pair, fee tier, liquidity, owner and status.

### 6. Dapp integration model

A Gateway-compatible dApp should be able to:

- read the user's available balances and active positions;
- request a scoped execution authorization for a specific strategy;
- receive a request ID and observe lifecycle events;
- never move funds without the user's signature and Gateway policy checks.

Expose read-only balance and position views. For writes, use typed intents and adapter allowlists. A connected dApp is not automatically trusted or authorized.

## Contract/module breakdown

1. `QrosGatewayLedger`: user balance buckets, deposits, reservations, credits, releases and accounting events.
2. `QrosTransferCoordinator`: transfer IDs, source/destination state and replay protection.
3. `ICrossChainSettlementAdapter`: bridge abstraction; implement a CCTP adapter only after support is verified.
4. `QrosExecutionRouter`: signed intents, nonces, deadlines, strategy allowlist and bounded token approvals.
5. `IExecutionAdapter`: common interface for protocol-specific execution.
6. `UniswapV3LiquidityAdapter`: swap + position mint + NFT ownership verification.
7. `QrosPositionRegistry`: mapping of user positions to external protocol NFTs, with events and lifecycle tracking.

Keep admin powers narrow. Use separate roles for pausing, route configuration and relaying. Production deployment should use a multisig, timelocked configuration changes, monitoring and independent audits. A relayer must never have arbitrary custody or withdrawal authority.

## UI requirements

Gateway page:
- balances grouped by chain and token;
- available, in-transit, reserved and deployed breakdown;
- pending transfer state and explorer links;
- active strategy positions and NFT links.

Execution page:
- choose network, protocol, pool and strategy;
- enter amount and position parameters;
- show swap estimate, fees, slippage, price range and risks;
- show the exact transaction/intent being authorized;
- display execution stages and recovery status.

Never display deployed liquidity as spendable USDC. Never display an aggregate USD estimate as a guaranteed redeemable balance.

## Implementation sequence

### Phase 0 — compatibility and deployment verification
- Verify QMS USDC issuer, contract, decimals and CCTP support with Circle.
- Verify Base Sepolia USDC and Circle CCTP deployment details.
- Verify Uniswap V3 Base Sepolia factory, router/swap routing and NonfungiblePositionManager addresses from official sources.
- Confirm the QMS and Base RPCs, chain IDs, token code and decimals.
- Keep all routes disabled until this evidence is recorded.

### Phase 1 — Gateway ledger
- Implement the four accounting buckets and invariants.
- Add idempotent deposit, transfer state, credit, reserve, consume and release functions.
- Add unit and invariant tests for double-credit, replay, fee-on-transfer tokens, decimals, partial failures and reentrancy.
- Do not alter or replace the existing deployed contracts in place.

### Phase 2 — settlement adapter
- Implement CCTP only if QMS passes Phase 0.
- Otherwise define and separately evaluate a supported alternative; do not simulate CCTP.
- Test source burn, attestation wait, destination mint, replay and recovery on testnet.

### Phase 3 — execution authorization and Uniswap
- Implement typed user intents and strategy allowlisting.
- Implement the Base Sepolia Uniswap adapter.
- Test swaps, minimum outputs, price ranges, NFT recipient, dust return, fee collection and close/withdraw flows.

### Phase 4 — UI and dApp integration
- Replace the current demo vault position view with real Gateway balances and real NFT position data.
- Add a Gateway read/authorization SDK for integrated dApps.
- Add clear state and error handling for pending settlement and partial execution.

### Phase 5 — test, security and release
- Run unit, fuzz, invariant and end-to-end tests.
- Test relayer downtime, duplicate messages, reorgs, failed swaps, expired intents and insufficient liquidity.
- Obtain independent contract/security review before any real-value deployment.
- Deploy new contracts to testnet, verify source code and addresses, then update the frontend and worker.

## Explicit non-goals for the first release

- No claim that every dApp automatically sees Gateway balances; integrations must adopt the Gateway interface.
- No automatic deployment into yield or liquidity strategies.
- No promise of fixed returns or guaranteed liquidity.
- No mainnet or real-value use before compatibility verification, audits and operational controls.
- No use of the current prefunded demo vault as proof of CCTP or Uniswap integration.
