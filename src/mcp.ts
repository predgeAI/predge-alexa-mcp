import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { PredgeConfig } from "./predge.js";
import { activeDisputes, checkMarketSettlement, verifyDelivery, verifyRecord, type ToolResult } from "./tools.js";
import { checkPurchase, draftRefundRequest, HOUSEHOLD_DEFAULT, listPurchases, recordPurchase, verifyReceipt, type Confirm, type KeptDeps } from "./kept.js";
import { MemoryStore, type PurchaseStore } from "./store.js";
import { MCP_APP_MIME, RECEIPT_HTML, RECEIPT_URI } from "./card.js";

export const SERVER_INFO = { name: "kept", version: "0.2.0" };
const CARD_META = { ui: { resourceUri: RECEIPT_URI }, "ui/resourceUri": RECEIPT_URI };

export interface McpDeps { store?: PurchaseStore; household?: string; marketTools?: boolean }

const out = (r: ToolResult) => ({
  content: [{ type: "text" as const, text: r.text }],
  structuredContent: r.data,
  ...(r.isError ? { isError: true } : {}),
});

/** Builds the Kept MCP server. Handlers are plain functions in kept.ts / tools.ts. */
export function createMcpServer(cfg: PredgeConfig, deps: McpDeps = {}): McpServer {
  const store = deps.store ?? new MemoryStore();
  const d: KeptDeps = { cfg, store, household: deps.household || HOUSEHOLD_DEFAULT };
  const s = new McpServer(SERVER_INFO, {
    instructions: "Kept remembers every purchase the assistant makes for the household, checks the merchant's confirmation against what was promised, and returns a signed verdict that verifies offline. Answers are short sentences that can be read aloud; structuredContent has the details. Kept never moves money: a refund request is only a draft and only after the human says yes.",
  });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const confirm: Confirm = async (message) => {
    if (!s.server.getClientCapabilities()?.elicitation) return "unsupported";
    try {
      const r = await s.server.elicitInput({ message, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Draft the refund request", description: "Nothing is sent and no money moves." } }, required: ["approve"] } });
      return r.action === "accept" && r.content?.approve === true ? "accept" : "decline";
    } catch { return "unsupported"; }
  };

  s.registerResource("kept-receipt-card", RECEIPT_URI, { title: "Kept receipt card", description: "MCP App: purchase receipt with verdict, missing details and a refund button.", mimeType: MCP_APP_MIME },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: RECEIPT_HTML, _meta: { ui: { prefersBorder: false } } }] }));

  s.registerTool("record_purchase", {
    title: "Record a purchase",
    description: "Record a purchase the assistant just made for the household: merchant, item, amount, and the details the merchant promised to confirm (for example ticket_id, seat, showtime). Kept stores it so the confirmation can be checked later. Does not buy anything and never moves money.",
    inputSchema: {
      merchant: z.string().min(2).describe("Who was paid, in plain words, e.g. 'a ticketing service'"),
      item: z.string().min(2).describe("What was bought, e.g. 'two tickets, Saturday 7pm'"),
      amount_usd: z.number().min(0).describe("Amount paid in US dollars"),
      promised: z.array(z.string().min(1)).min(1).describe("Fields the merchant's confirmation must contain, as JSON dot paths: ticket_id, seat, showtime"),
      due_by: z.string().optional().describe("When the confirmation is due (ISO date or plain words)"),
      household: z.string().optional().describe("Household id; defaults to the server's household"),
    },
    annotations: { title: "Record a purchase", readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    _meta: CARD_META,
  }, async (a) => out(await recordPurchase(d, a)));

  s.registerTool("check_purchase", {
    title: "Check what arrived",
    description: "Did the purchase arrive as promised? Takes the merchant's confirmation (JSON or text) and checks it against what was promised when the purchase was recorded, using Predge's deterministic verdict API (no LLM). Returns one sentence plus a signed verdict and a refund recommendation. Without a PREDGE_KEY on the server it runs a clearly labelled offline sample check instead. Defaults to the latest unchecked purchase.",
    inputSchema: {
      purchase_id: z.string().optional().describe("Purchase id from record_purchase; default is the latest unchecked one"),
      confirmation: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The merchant's confirmation: a JSON object or its text"),
      household: z.string().optional(),
    },
    annotations: { title: "Check what arrived", readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    _meta: CARD_META,
  }, async (a) => out(await checkPurchase(d, a)));

  s.registerTool("list_purchases", {
    title: "List purchases",
    description: "What did the assistant buy for the household, and is anything unconfirmed or undelivered? Reads the saved purchase journal across sessions.",
    inputSchema: { days: z.number().int().min(1).max(365).optional().describe("Only the last N days"), only_open: z.boolean().optional().describe("Only purchases that are unconfirmed, not delivered or inconclusive"), household: z.string().optional() },
    annotations: { title: "List purchases", ...readOnly },
    _meta: CARD_META,
  }, async (a) => out(await listPurchases(d, a)));

  s.registerTool("draft_refund_request", {
    title: "Draft a refund request",
    description: "Draft a refund request for a purchase that was checked and found not delivered. Asks the human first (MCP elicitation) and only drafts after a yes. The draft carries the verdict link as evidence. It is never sent and no money moves.",
    inputSchema: { purchase_id: z.string().optional().describe("Default: the latest not-delivered purchase"), confirmed: z.boolean().optional().describe("Only for clients that cannot ask the user: set true after the human said yes out loud"), household: z.string().optional() },
    annotations: { title: "Draft a refund request", readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    _meta: CARD_META,
  }, async (a) => out(await draftRefundRequest(d, a, confirm)));

  s.registerTool("verify_receipt", {
    title: "Verify a signed receipt",
    description: "Checks a Kept/Predge signed verdict locally with ed25519 against Predge's published key list, so authenticity does not depend on trusting the server. Reports authentic, revoked key, invalid signature or unknown key. Defaults to the latest signed receipt in the journal.",
    inputSchema: {
      purchase_id: z.string().optional(), verdict_id: z.string().optional().describe("Verdict id starting with vrd_"),
      receipt: z.record(z.string(), z.unknown()).optional().describe("A verdict or attestation object with canonical, signature, public_key"),
      demo_tamper: z.boolean().optional().describe("Demo only: change one character before verifying, to show tampering is caught"), household: z.string().optional(),
    },
    annotations: { title: "Verify a signed receipt", ...readOnly },
    _meta: CARD_META,
  }, async (a) => out(await verifyReceipt(d, a)));

  if (deps.marketTools) {
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

  }

  return s;
}
