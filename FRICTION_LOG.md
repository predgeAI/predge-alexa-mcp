# Friction log

Real problems hit while building Kept (22-23 Oct 2026), one entry per problem, in the hackathon's template: task, steps, expected vs actual, severity, workaround, suggestion. Newest first.

## 1. Bedrock: Anthropic models refuse with "use case details not submitted"

- **Task:** run the demo agent on Claude through Amazon Bedrock Converse with tool use.
- **Steps:** `AWS_PROFILE=predge aws bedrock-runtime converse --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 ...` (same with the Sonnet profile) in us-east-1.
- **Expected:** a reply, since the account can call Bedrock.
- **Actual:** `ResourceNotFoundException: Model use case details have not been submitted for this account. Fill out the Anthropic use case details form before using the model.` The form is a console-only step that needs a human to submit it (and the error type, `ResourceNotFound`, sounds like a wrong model id).
- **Severity:** High. It blocks the headline "Claude on Bedrock" path on a fresh account.
- **Workaround:** the demo agent catches the failure, uses a deterministic intent router that calls the same MCP tools, and the UI badge says which path ran ("Amazon Bedrock" or "deterministic router (Bedrock not used)"). `BEDROCK_MODEL_ID` is configurable, so the Bedrock path turns on the moment access exists; its tool loop is covered by a test with a faked client.
- **Suggestion:** return `AccessDeniedException` with the console link to the form, and show "use case form pending" in the model access page of the account where the API is called.

## 2. Bedrock: Amazon Nova throttled with "Too many tokens per day"

- **Task:** use Amazon's own models as the Bedrock fallback while Anthropic access is pending.
- **Steps:** `aws bedrock-runtime converse --model-id us.amazon.nova-lite-v1:0` and `us.amazon.nova-micro-v1:0`, a one-word prompt.
- **Expected:** a reply; the first request of the day on a new account.
- **Actual:** `ThrottlingException: Too many tokens per day` on the first call, i.e. a daily quota of 0 for these models on this account.
- **Severity:** High on a one-day build, because it removes the second route to a live model.
- **Workaround:** same deterministic fallback as entry 1, labelled in the UI and in `/healthz`.
- **Suggestion:** surface the account's quota in the Bedrock console next to each model before the first call, and say "quota is 0" rather than a rate-limit message. Quota-increase requests are not instant, which does not fit a hackathon window.

## 3. No access to the Alexa+ AI Action SDK / device, so Alexa+ is simulated

- **Task:** exercise Kept from a real Alexa+ conversation.
- **Steps:** looked for a way to register a self-hosted MCP server with Alexa+ and test it from a developer account or the Developer Console simulator.
- **Expected:** a documented registration path and a simulator.
- **Actual:** no toolkit access for this account, no public simulator that sends an utterance to a self-hosted MCP server, and no documentation on whether Alexa+ renders `ui://` MCP App resources or supports elicitation.
- **Severity:** High for the track: the integration cannot be verified end to end.
- **Workaround:** `/demo` is a simulated Alexa+ experience (browser speech in, Bedrock/router agent, Polly out) that talks to the real server over the real MCP protocol, hosts the MCP App card itself, and relays elicitation to a Yes/No prompt. It is labelled "not tested on a physical Alexa+ device" everywhere.
- **Suggestion:** a local harness (`npx alexa-plus-sim --mcp http://localhost:8787/mcp`) that speaks utterances to a server and prints what the planner would see, plus a capability table (tools, resources, elicitation, MCP Apps) per surface (Echo Show, Echo Dot, app).

## 4. MCP elicitation needs a stateful session, which conflicts with the "stateless" Streamable HTTP pattern

- **Task:** ask the human "send this refund request, yes or no?" from inside a tool, using MCP elicitation.
- **Steps:** my server created a fresh `McpServer` and transport per `POST /mcp` (the stateless pattern). Called `server.elicitInput(...)` inside the tool.
- **Expected:** the client answers and the tool continues.
- **Actual:** the elicitation request has to travel on the response stream, and the client's answer arrives as a separate POST that a new per-request server instance cannot match to the waiting tool call. With `enableJsonResponse: true` there is no stream at all.
- **Severity:** Medium; I lost about an hour to it.
- **Workaround:** sessions by default (`Mcp-Session-Id`, SSE response for the initialize/session path), the old per-request mode behind `MCP_STATELESS=1`, and for clients without the `elicitation` capability the tool returns "needs confirmation" and drafts only when called again with `confirmed: true` after a spoken yes.
- **Suggestion:** document that elicitation and sampling need sessions or a shared pending-request store, in the same place as the stateless quickstart.

## 5. MCP Apps (`ui://` resources) documentation gaps

- **Task:** return a receipt card that an Echo Show-like host can render.
- **Steps:** registered `ui://kept/receipt` with mime type `text/html;profile=mcp-app` and `_meta.ui.resourceUri` on the tools; wrote a small host in `/demo`.
- **Expected:** one place that lists the host-to-view messages and sandbox rules.
- **Actual:** I assembled the handshake (`ui/initialize`, `ui/notifications/initialized`, `ui/notifications/tool-result`, `ui/message`, size notifications) from the extension draft and examples; unclear which spec revision a given host implements, and whether the legacy flat `ui/resourceUri` key is still read. I set both keys.
- **Severity:** Medium.
- **Workaround:** the card also accepts a plain `{card}` message and renders from `structuredContent.card`, so a host that only passes tool results still works.
- **Suggestion:** a versioned compatibility table for hosts, and a test page that a server author can open to see their resource rendered by a reference host.

## 6. Bedrock credentials: `aws login` sessions expire and cannot be refreshed unattended

- **Task:** keep a local demo running across a day.
- **Steps:** use the `predge` profile (an `aws login` console session) with the JS SDK.
- **Expected:** a refresh.
- **Actual:** after expiry the SDK throws `CredentialsProviderError: Your session has expired`; refreshing needs an interactive browser login.
- **Severity:** Medium. **Workaround:** re-login before recording; the store falls back to memory with a reason, and Polly failures fall back to the browser voice. **Suggestion:** warn in the SDK when a login session is close to expiry.

## 7. MCP SDK (1.32.1): small things that cost minutes

- **Spec version.** Not in the README; I read `dist/esm/types.js` (`LATEST_PROTOCOL_VERSION = '2025-11-25'`). Severity low. Suggestion: a documented helper.
- **zod flavour.** `registerTool` takes a raw shape, not `z.object`, and imports `zod/v4`; older examples use `server.tool()`. Severity low.
- **`Accept` header.** A bare `curl` is rejected unless it sends `Accept: application/json, text/event-stream`. Workaround: `enableJsonResponse` for the stateless mode. Severity low.
- **Tool descriptions are the prompt.** The model chose tools correctly only after descriptions said what a person would ask ("Did my purchase arrive as promised?"), not what the API does. Severity low.
- **`structuredContent` without `outputSchema`.** Allowed; the `text` item is what a voice client reads. Suggestion: let a tool mark one content item as speakable.

## 8. Tooling

- `npm i -D typescript tsx vitest ...` in a single command failed once with `Cannot read properties of null (reading 'edgesOut')` (npm arborist). Installing packages one at a time worked. Severity low.
- The Predge pilot key is not stored in this repo. Without `PREDGE_KEY` the server runs `check_purchase` on a clearly labelled offline sample path (unsigned); with it, the same tool calls the live verdict API. Severity: medium for demos, by design.
