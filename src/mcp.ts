import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { PredgeConfig } from "./predge.js";
import { activeDisputes, checkMarketSettlement, verifyDelivery, verifyRecord, type ToolResult } from "./tools.js";

export const SERVER_INFO = { name: "predge-alexa-mcp", version: "0.1.0" };

const out = (r: ToolResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  structuredContent: r.data,
  ...(r.isError ? { isError: true } : {}),
});

/** Builds an MCP server exposing the four Predge tools. Handlers are plain functions in tools.ts. */
export function createMcpServer(cfg: PredgeConfig): McpServer {
  const s = new McpServer(SERVER_INFO, {
    instructions: "Predge tools for voice assistants. Answers are short sentences that can be read aloud; structuredContent has the details. Settlement info is not financial advice.",
  });
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  s.registerTool("check_market_settlement", {
    title: "Check market settlement risk",
    description: "Is a Polymarket market's settlement safe? Returns the UMA oracle state (proposal, disputes, whether it went to a UMA token-holder vote) as one speakable sentence. Accepts a market name, Polymarket link, slug, numeric id or condition id. Names are matched against the public dispute list.",
    inputSchema: { market: z.string().min(2).describe("Market name as spoken, Polymarket URL, slug, numeric market id or 0x condition id") },
    annotations: { title: "Check market settlement risk", ...readOnly },
  }, async (a) => out(await checkMarketSettlement(cfg, a)));

  s.registerTool("active_disputes", {
    title: "List disputed markets",
    description: "Lists Polymarket markets that are in an open UMA dispute right now, newest first, with counts. Optional topic filter (for example 'ethereum' or 'ukraine').",
    inputSchema: { limit: z.number().int().min(1).max(15).optional().describe("How many to read out, default 5"), topic: z.string().optional().describe("Only markets whose title contains these words") },
    annotations: { title: "List disputed markets", ...readOnly },
  }, async (a) => out(await activeDisputes(cfg, a)));

  s.registerTool("verify_delivery", {
    title: "Verify a paid delivery",
    description: "Did the service I paid for actually deliver? Sends the job spec and the delivered output to Predge and returns a signed verdict (delivered, not_delivered or inconclusive) with a refund recommendation. Deterministic checks, no LLM. Needs a Predge pilot key on the server.",
    inputSchema: {
      endpoint: z.string().describe("The service endpoint that was paid for"),
      amount_usd: z.number().min(0).describe("What was paid, in US dollars"),
      delivery_status: z.number().int().describe("HTTP status of the delivered response"),
      delivery_body: z.string().describe("The delivered response body as text (may be empty)"),
      delivery_content_type: z.string().optional(), expected_content_type: z.string().optional().describe("e.g. application/json"),
      required_fields: z.array(z.string()).optional().describe("JSON dot paths that must be present"), non_empty_fields: z.array(z.string()).optional(),
      max_latency_ms: z.number().optional(), latency_ms: z.number().optional(), expected_sha256: z.string().optional(),
      payer: z.string().optional(), payee: z.string().optional(), buyer_id: z.string().optional(), merchant_id: z.string().optional(),
    },
    annotations: { title: "Verify a paid delivery", readOnlyHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => out(await verifyDelivery(cfg, a)));

  s.registerTool("verify_record", {
    title: "Verify a signed Predge record",
    description: "Checks a Predge signed record (settlement record or delivery verdict) locally with ed25519 against Predge's published key list, so authenticity does not depend on trusting the server. Reports authentic, revoked key, invalid signature or unknown key. Give a market, a verdict id, or the record itself.",
    inputSchema: {
      market: z.string().optional().describe("Fetch and verify this market's settlement record"),
      verdict_id: z.string().optional().describe("Verdict id starting with vrd_"),
      record: z.record(z.string(), z.unknown()).optional().describe("A record or attestation object with canonical, signature, public_key"),
      demo_tamper: z.boolean().optional().describe("Demo only: change one character before verifying, to show tampering is caught"),
    },
    annotations: { title: "Verify a signed Predge record", ...readOnly },
  }, async (a) => out(await verifyRecord(cfg, a)));

  return s;
}
