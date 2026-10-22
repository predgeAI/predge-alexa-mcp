# Friction log

Real notes from building this in one night (22-23 Oct 2026). Newest problems last.

## MCP SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **Finding the supported spec version.** Not in the README; I read `dist/esm/types.js` (`LATEST_PROTOCOL_VERSION = '2025-11-25'`, plus four older versions). A `getSupportedProtocolVersions()` helper or a line in the docs would help.
- **zod flavour.** The SDK imports `zod/v4` internally; `registerTool` takes a raw shape (`{ market: z.string() }`) rather than a `z.object`. Using zod 4 worked first time, but the docs examples I remembered were for the older `server.tool()` API.
- **Stateless Streamable HTTP needs a per-request server.** With `sessionIdGenerator: undefined` I create a new `McpServer` and transport for every `POST /mcp` and close both on `res.on("close")`. Reusing one transport across requests throws. It is the right pattern for App Runner-style scaling, but you have to know it.
- **`Accept` header.** A bare `curl` is rejected unless it sends `Accept: application/json, text/event-stream`. The error is clear, but it is the first thing that bites when you test by hand. `enableJsonResponse: true` makes replies plain JSON, which is easier for simple clients.
- **`structuredContent` without `outputSchema`.** Allowed, and clients return it, so I did not declare output schemas; for a voice client the `text` content is what matters. It would be nicer if tools could mark one content item as "speakable".
- **Tool descriptions are the prompt.** The model chose tools correctly only after the descriptions said what a person would ask ("Is a Polymarket market's settlement safe?"), not what the API does.

## Amazon Bedrock

- **Credentials.** The only local profile (`predge`) is an `aws login` console session (`login_session` in `~/.aws/config`), not access keys. It had expired, and the JS SDK reported `CredentialsProviderError: Your session has expired`. The message is clear, but a refresh needs an interactive browser login, which blocks unattended runs. At the time of writing the live Bedrock call has therefore **not** been exercised from this build; the Converse tool loop is covered by a test with a faked client (`test/agent.test.ts`), and the fallback path is exercised live.
- **Model ids.** Current Claude models in Bedrock need a regional inference profile id (`us.anthropic...`) rather than the bare model id, and model access is a separate switch per account. The default in `.env.example` is my best guess of a valid id and should be checked against the Bedrock console.
- **Converse tool format.** `toolSpec.inputSchema` wants `{ json: <schema> }`, and `toolResult.content` JSON blocks must be plain objects (I round-trip through `JSON.parse(JSON.stringify())` to drop `undefined`).
- **Latency for voice.** Tool call + second model turn is two model round trips; for a voice assistant the answer is short, so I set `maxTokens: 400`. A deterministic path for the most common intents is a real latency option.

## Tooling

- `npm i -D typescript tsx vitest ...` in one command failed with `Cannot read properties of null (reading 'edgesOut')` (npm arborist). Installing packages one at a time worked; `vitest@3` installed cleanly where the latest did not.
- Polymarket's gamma API did not answer from this network, so spoken market names are resolved against Predge's own public dispute list instead. That limits name lookup to markets disputed in the last 30 days; slugs, ids and URLs work for any market.
- The Predge pilot key is not in this repo; `verify_delivery` was verified against the documented request shape and mocked responses, and not yet against the live route in this build.
