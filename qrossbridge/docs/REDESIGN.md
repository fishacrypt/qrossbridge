# QROS Bridge redesign: audit, design and validation

## 1. Audit of the existing project

| Area | Finding |
|---|---|
| Frontend | One 1,030-line static file, `dapp/tetrix-bridge.html`: inline CSS, inline vanilla JS, hand-rolled JSON-RPC and EIP-1193/EIP-6963 wallet code. No framework, no build step. |
| Hosting | Vercel static. `vercel.json` rewrites `/` to `/dapp/tetrix-bridge.html`. Logo is served from `/dapp/bucketbridge-logo.jpg`. |
| Contracts | `QmsBridgeHub` (QMS Testnet, one pool of native QMS) and `QmsBridgeSpoke` + `WrappedQMS` (each remote chain). `processed(id)` is the replay guard and the only on-chain proof of delivery. No bridge fee. Pausable. Per-transfer min/max. |
| Deployed spokes | Base Sepolia, Arbitrum Sepolia, OP Sepolia. Sepolia is in `scripts/chains.js` but has no spoke in `deployments.json`, so the dapp correctly blocks it. |
| Relayer | `relayer/` is a Node process that polls `Bridged` events and calls `mint` or `release`. It has **no HTTP API and no status endpoint**. |
| Routes | QMS <-> spoke uses the bridge contracts. Base/Arbitrum/OP <-> each other uses a quote and execution backend (`CFG.api`). Both were kept exactly as they were. |
| Config | `npm run deploy` / `apply-config` patch the `BRIDGE_CONFIG_START/END` block in the HTML. That block is unchanged and still lives in the HTML so the deploy flow is unchanged. |
| Tests | `test/e2e.js` (19 contract + relayer scenarios) and `test/dapp-e2e.js` (the real page in jsdom with a mock wallet against local chains and a running relayer). |

### Risks found

- `test/dapp-e2e.js` deleted the real `deployments.json` at the end of a run. It now removes only its temp files.
- The old UI showed "~1-2 min" for QMS routes. Nothing in the contracts or relayer supports that number, so it was removed. The page now shows the delivery time measured from your own completed transfers on that route, or says it varies.
- Transfers were only saved after the source receipt and event were parsed, so a refresh in between lost tracking. They are now saved the moment the wallet returns a hash.
- Completion was already based on `processed(id)`; that rule is kept and now also drives a delayed state.

## 2. What changed

Same functionality, new structure. No contract, ABI, address, network id, token, route, relayer, env var or `vercel.json` change.

```
dapp/tetrix-bridge.html   shell + BRIDGE config block (apply-config still patches it)
dapp/css/app.css          design system
dapp/js/core.js           helpers, chains, state, RPC, wallet (moved, not rewritten)
dapp/js/bridge.js         form, quotes, fee breakdown, pickers, route info
dapp/js/exec.js           transaction execution + live progress (calldata unchanged)
dapp/js/track.js          persisted tracking, stage detection, timeline, hash lookup, claim
dapp/js/views.js          Home, Activity, transfer details
dapp/js/pages.js          Networks, Docs
dapp/js/app.js            hash router, header, theme, settings, startup
```

### Pages

- **Home**: headline, start-a-transfer routes, how a transfer works, supported networks, your recent activity (connected wallet only), resources. No TVL, volume or user counts.
- **Bridge**: source/destination network and token, amount, balance, MAX, reverse control, custom recipient, receive amount, fee breakdown (bridge fee, source gas estimate, approval needed, destination gas paid by relayer), route facts read from the contracts (limits, paused state).
- **Activity**: filter by status and network, search by hash, transfer detail with timeline, track by transaction hash. Entries are scoped to the connected wallet.
- **Networks**: per chain: RPC status and block, contract paused state, bridge and token addresses, hub liquidity, relayer gas balance, add-to-wallet, explorer, faucet.
- **Docs**: what the statuses mean, fees and limits (live), troubleshooting, trust model, contract addresses.

### Transfer stages (what is really observable)

1. **Transaction submitted**: wallet returned a hash. Saved immediately.
2. **Confirmed on source**: receipt found, `Bridged` event parsed, block, timestamp, confirmation count.
3. **Funds arrive on destination**: `processed(id)` on the destination contract. Until then the step shows "waiting for the relayer", and after 3 minutes "delayed" with an explanation and a Check again action.

The relayer exposes no status API, so "relayer processing" and "destination execution" are one observable event (`processed(id)` flips in the delivery transaction). They are shown as one step rather than inventing two. A delivered transfer whose recipient could not accept native QMS is detected from the `ClaimableCredited` event and offers a Claim button.

### Error handling added

Unsupported wallet network (header indicator + switcher), insufficient token balance, no gas on the source chain, rejected or failed approval, quote expiry (refresh at 60 s, blocked at 90 s), reverted or dropped transactions, RPC lookup failures, paused contracts, relayer with no gas (Networks page), and duplicate submissions (confirmation if an identical transfer is still in flight).

## 3. Not built, on purpose

- Transaction history discovered from chain for other browsers (needs an indexer or bounded log scans; use track-by-hash instead).
- Relayer status API, retry button for relayer delivery (the relayer retries on its own; a UI cannot trigger it).
- Statistics of any kind. There is no data source for them.
- A fee for bridging. The contracts have none.

## 4. Validation

- `node test/e2e.js`: 19 contract and relayer scenarios pass (unchanged).
- `node test/dapp-e2e.js`: the 6 original page scenarios pass against the new page, plus 5 new ones: router and navigation state with no script errors, source success not shown as complete, entry persisted at submission, delayed state, delivery detected after the relayer resumes, wallet-scoped activity, hash lookup rejects other wallets' transfers and restores your own.
- One test assertion changed: "UI never mentions Relay" matched the word "relayer". It now matches the standalone word "relay", which is what it was protecting.
- Mobile and visual checks: the layout is responsive by CSS (single column under 900 px, compact header under 640 px, nothing wider than the viewport). Check it on a real phone and desktop browser before deploying; the jsdom tests do not render pixels.

## 5. Deploy

Nothing was deployed or pushed. Upload the whole `dapp/` folder (HTML, `css/`, `js/`, logo). `vercel.json` needs no change.
