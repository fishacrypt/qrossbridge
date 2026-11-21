# QROS Unified Gateway Deployment

This workflow extends the already-deployed Gateway core on QMS Testnet (19480) and Base Sepolia (84532). **Do not rerun `deploy-gateway-core`** unless intentionally deploying a new Gateway from scratch.

## 1. Local setup

Check out the implementation branch and pull the latest commits:

```powershell
git fetch origin
git checkout qros-unified-gateway-architecture
git pull origin qros-unified-gateway-architecture
```

Keep the existing local deployment manifests in the project root:
- `gateway-core-deployments.json`
- `deployments.json`

Copy/update `.env` from `.env.example`. Add the two Gateway owner keys locally:

```dotenv
QMS_OWNER_KEY=0x...
BASE_OWNER_KEY=0x...
```

- `QMS_OWNER_KEY` must match the QMS Gateway owner and the legacy QMS Hub/Spoke bridge owner.
- `BASE_OWNER_KEY` must match the Base Gateway owner.
- Never commit `.env` or paste private keys into chat.

## 2. Compile and prepare QMS/wQMS adapters

```powershell
npm.cmd run compile
npm.cmd run prepare-gateway-adapters
```

Preparation is resumable. It deploys the QMS bridge-attestation verifier and QMS Gateway adapter on QMS and Base, checks contract code and ownership, connects each Gateway ledger to its transfer coordinator, and enables wQMS custody.

It deliberately leaves the wQMS settlement adapter unset and the coordinator adapter unapproved. It does not enable cross-chain transfers.

The resulting local manifest is `gateway-adapter-preparations.json`.

## 3. Configure real validator signers before activating transfers

Copy `gateway-validator.config.example.json` to `gateway-validator.config.json` and enter real, distinct validator addresses:

```json
{
  "threshold": 2,
  "validators": [
    "0xVALIDATOR_ADDRESS_1",
    "0xVALIDATOR_ADDRESS_2",
    "0xVALIDATOR_ADDRESS_3"
  ]
}
```

A 2-of-3 quorum is a reasonable testnet starting point when three independently operated validators are available. If only two validators exist, a 2-of-2 quorum means both must be online for every proof.

The addresses are ECDSA signing addresses, not validator service URLs. The validator operators still need off-chain services that independently verify the source bridge dispatch and the destination bridge processing/mint/release before signing the QROS EIP-712 attestations.

Then activate:

```powershell
npm.cmd run activate-qms-gateway
```

Activation is resumable and checks ownership on both chains before sending transactions. It:
- adds the configured validators to both settlement and QMS bridge verifiers on both chains;
- sets the configured quorum threshold;
- maps the QMS adapter specifically to wQMS on each ledger;
- approves the adapter in each transfer coordinator;
- enables the QMS Hub route to Base and authorizes the Base Spoke adapter;
- configures both directions of the adapter and proof-verifier route matrix.

The output manifest is `gateway-adapter-activations.json`.

**Trust model:** this is a threshold-validator-attested bridge integration, not a trustless cross-chain light client. The validators' source/destination verification and operational independence are security-critical.

## 4. Stablecoin settlement

The Gateway ledger now supports **asset-specific settlement adapters** through `setSettlementAdapterForAsset(asset, adapter)`. This is required because wQMS and stablecoins use different settlement mechanisms.

The existing `QrosAttestedLiquidityAdapter` is the prefunded-liquidity rail for ERC-20 assets. It is not CCTP and is not a trustless bridge. Before activating a stablecoin route:
- the relevant stablecoin contract must exist on both participating chains;
- the asset must be enabled on each ledger;
- the attested-liquidity adapter must be deployed and mapped for that asset on each chain;
- destination adapter liquidity must be funded;
- source outbound routes and destination verifier routes must be configured;
- validators must attest to the actual source escrow and destination release.

This stablecoin adapter deployment/route-funding stage is separate from the QMS/wQMS activation. Do not map the QMS bridge adapter to USDC or USDT.

## 5. Explicit Uniswap V3 execution on Base

The Base core already has an execution router and position registry. To deploy/configure the actual Uniswap adapter, copy `uniswap-execution.config.example.json` to `uniswap-execution.config.json` and supply verified Base Sepolia addresses for:
- Uniswap V3 SwapRouter;
- NonfungiblePositionManager;
- the ordered token pair;
- an existing pool fee tier and (if swapping) swap fee tier;
- a non-zero bytes32 strategy ID.

Then run:

```powershell
npm.cmd run configure-uniswap-execution
```

The script verifies deployed code and the configured pool, deploys the adapter once, connects it to the ledger/router/position registry, enables the token pair, and approves the strategy. It does not move user funds or execute a position. Users still need to sign an explicit EIP-712 execution intent; proceeds are sent to the wallet or Gateway only according to the user's explicit choice.

## Important scope boundary

The current QMS adapter activation enables QMS/wQMS only. Stablecoin settlement and Uniswap execution are separate rails and must not be described as active until their own adapter, token/pool, liquidity, and route configuration has been completed and recorded.
