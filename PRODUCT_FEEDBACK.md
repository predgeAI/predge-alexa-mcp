# Product feedback

Feedback for the teams behind the technologies used, from building a voice-first MCP server in a day.

## MCP / Streamable HTTP

- **Good:** one POST endpoint, JSON replies and `structuredContent` make a small server easy; the SDK's client and server work together in-process, which made integration tests straightforward.
- **Wish:** first-class guidance for voice clients: a way to flag a content item as "speakable" and another as "show on screen", and a recommended maximum length.
- **Wish:** a conformance checker one can run against an endpoint (`npx` tool that prints negotiated version, tools, and common mistakes such as a missing `Accept` header).
- **Wish:** stateless mode documented as a first-class deployment option, with the per-request server pattern in the quickstart.

## Alexa+ (as seen from the hackathon brief)

- **Wish:** a local simulator or test harness that sends an utterance to a self-hosted MCP server and returns the spoken reply, so developers without a device can iterate. We built a small one (`/demo`) for lack of it.
- **Wish:** guidance on how tool descriptions are surfaced to the assistant's planner and how long a tool may take before the experience degrades.

## Amazon Bedrock

- **Good:** Converse gives one tool-use shape across models, which let the agent be about 60 lines.
- **Friction:** inference profile ids versus model ids, and per-account model access, are easy to get wrong; a clearer `AccessDeniedException` message that names the exact switch would save time.
- **Friction:** `aws login` sessions expire and cannot be refreshed non-interactively; an SDK warning when a session is close to expiry would help long-running local demos.

## MCP Apps and elicitation

- **Good:** `ui://` resources plus `_meta.ui.resourceUri` are the right shape for a receipt card; the same server works with and without a host that renders them.
- **Wish:** a reference host page and a compatibility table (see FRICTION_LOG 5). Elicitation docs should say it needs sessions (FRICTION_LOG 4).

## Amazon DynamoDB and Polly

- **Good:** an on-demand table keyed by household was one CLI command and free-tier scale; Polly neural voices make the demo narration usable without extra tooling.
- **Wish:** Polly voices flagged for conversational/assistant use, with SSML defaults for short confirmations.

## Predge API (our own feedback to ourselves)

- A "speakable" summary field on a verdict would let clients avoid re-deriving the sentence from checks and reason codes.
- The verdict job spec could accept a plain list of required fields without an endpoint, for purchases that have no URL.
