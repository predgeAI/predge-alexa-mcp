# Demo script (2 min 30 s)

Run: `AWS_PROFILE=predge PREDGE_KEY=... npm run dev`, open `http://localhost:8787/demo` in Chrome. Screen-record the page (and optionally a split terminal with the server log showing `[agent] path=...`). Under 3 minutes.

Markets used (live Predge API, checked 22 Oct 2026 about 21:15 UTC; the dispute list changes, so re-check with `curl -s https://api.predge.io/v1/settlement-risk/active` right before recording):

| Query | Market | Why |
|---|---|---|
| 1 | **Russia-Ukraine peace talks by October 31, 2026?** (id `4118937`, slug `russia-ukraine-peace-talks-by-october-31-2026`) | open dispute, disputed twice, sent to UMA vote, risk level caution |
| 2 | Current open disputes; at check time the newest were the three **Ethereum price on October 22** markets (ids 5739669, 5739662, 5739564) | live list |
| 3 | Sample paid job in the page's dropdown (fictional endpoint `api.example-forecasts.com`, $0.25, HTTP 502 empty body) | needs `PREDGE_KEY`; verdict `not_delivered`, refund recommended |
| 4 | Record of market 4118937 | verify with ed25519, then tamper |

## Shot list

| Time | Shot | Say / do |
|---|---|---|
| 0:00 - 0:15 | Title card, then the /demo page | "Prediction-market payouts and AI-agent payments both depend on facts a voice assistant can't check by itself. Predge's MCP server gives Alexa+ those answers, with signatures." |
| 0:15 - 0:20 | Point at the header badges | "MCP spec 2025-11-25, Streamable HTTP. The agent is Claude on Amazon Bedrock; the badge turns to fallback router if Bedrock isn't reachable." |
| 0:20 - 1:00 | Mic: **"Alexa, is the Russia-Ukraine peace talks market safe to cash out?"** | Show the right panel: `tools/call check_market_settlement`. Reply: disputed, went to a UMA vote, don't treat as settled. "Information from the oracle state, not advice." |
| 1:00 - 1:25 | Mic: **"Alexa, what markets are in dispute right now?"** | Panel: `active_disputes`, counts and titles. "Live from the free Predge tracker." |
| 1:25 - 1:55 | Mic: **"Alexa, did the work I paid for actually arrive?"** | Panel: `verify_delivery`; the assistant remembers a $0.25 call that returned a 502. Verdict not delivered, refund recommended, "a recommendation, no money moved". Optionally flip the dropdown to the good job and ask again: delivered. |
| 1:55 - 2:20 | Type or say **"Alexa, verify that record"**, then **"verify that record but tamper with it"** | `verify_record`: authentic, checked locally against the published keys; then one character changed: fails. "Signed with ed25519. If Predge ever revokes a key, the same tool says so." |
| 2:20 - 2:30 | Terminal: `curl .../healthz`, or the repo page | "Open source, MIT. predgeAI/predge-alexa-mcp. Tools run on any MCP client; Alexa+ is one." |

## Verified locally (23 Oct 2026, 00:30 MSK)

`npm run demo-check` against a running server, all five utterances answered with the right tool (output of the fallback router; the Bedrock path additionally needs a live AWS session, see README):

1. Safe to cash out? -> `check_market_settlement` -> "...is disputed and went to a UMA vote; don't treat it as settled yet. It was disputed twice, most recently 22 hours ago."
2. Verify record -> `verify_record` -> authentic.
3. What is in dispute -> `active_disputes` -> 7 open disputes, 9 in a UMA vote, newest listed.
4. Did the work arrive -> `verify_delivery` -> needs `PREDGE_KEY`; without it the assistant says a key is not configured (so set it before recording).
5. Tamper -> `verify_record` with one changed character -> fails verification.
