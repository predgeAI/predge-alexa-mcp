# Demo script (2:00)

Run: `AWS_PROFILE=predge PREDGE_KEY=... npm run dev`, open `http://localhost:8787/demo` in Chrome. The header badges show what actually ran: MCP version, agent (Amazon Bedrock or deterministic router), storage (DynamoDB or in-memory), verdicts (Predge API signed or offline sample). "Reset demo" wipes the journal; "New session (next day)" clears the conversation but keeps the journal.

| Time | Shot | Say / do |
|---|---|---|
| 0:00-0:12 | Title, then /demo | "Alexa+ can now buy tickets and book services for you. But when an agent pays, who checks you actually got what you paid for?" |
| 0:12-0:30 | "Alexa, buy two tickets for Saturday's 7pm show." | Panel: `record_purchase`. "Kept is a self-hosted MCP server. Every purchase is recorded with what was promised." |
| 0:30-0:55 | "Alexa, did my tickets arrive?" | `check_purchase`; MCP App card: NOT DELIVERED, missing seat, refund $32 |
| 0:55-1:10 | "Alexa, ask them for a refund." | Elicitation: Yes / No. Yes: draft with the verdict link. "Nothing moves without you." |
| 1:10-1:25 | New session: "What did you buy for me?" | `list_purchases`: 2 delivered, 1 refund requested |
| 1:25-1:42 | "Verify that receipt." then "...but tamper with it." | `verify_receipt`: authentic, then fails (needs `PREDGE_KEY`) |
| 1:42-1:52 | Terminal transcript, architecture | Any MCP client; Bedrock, DynamoDB, Polly |
| 1:52-2:00 | Repo + predge-verify | "If Alexa can spend your money, it should be able to prove what you got." |

Automated: `~/Downloads/amazon-hackathon/make-video.sh` drives this page with Playwright and builds the video with Polly narration.
