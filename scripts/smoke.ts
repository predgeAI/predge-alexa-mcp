// Live smoke test: starts the server in-process and drives the five Kept tools over MCP Streamable HTTP.
// With PREDGE_KEY set it hits the real verdict API and verifies the signed receipt; without it, check_purchase uses the labelled offline sample path.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.js";

const { app } = createApp({ port: 0, env: { ...process.env, KEPT_STORE: process.env.KEPT_STORE || "memory", KEPT_HOUSEHOLD: "smoke-" + Date.now() } });
const srv = app.listen(0);
const port = (srv.address() as any).port;
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as any;
try {
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["check_purchase", "draft_refund_request", "list_purchases", "record_purchase", "verify_receipt"]);
  const rec = await call("record_purchase", { merchant: "a ticketing service", item: "two tickets, Saturday 7pm", amount_usd: 32, promised: ["ticket_id", "seat", "showtime"] });
  assert.ok(!rec.isError, rec.content?.[0]?.text);
  console.log("record_purchase :", rec.content[0].text);
  const chk = await call("check_purchase", { confirmation: { status: "confirmed", ticket_id: "SAMPLE-1", showtime: "Sat 19:00" } });
  assert.ok(!chk.isError, chk.content?.[0]?.text);
  assert.equal(chk.structuredContent.verdict, "not_delivered");
  console.log(`check_purchase (${chk.structuredContent.source}) :`, chk.content[0].text);
  console.log("list_purchases :", (await call("list_purchases", {})).content[0].text);
  const dr = await call("draft_refund_request", { confirmed: true });
  assert.ok(dr.structuredContent.needs_confirmation || dr.structuredContent.drafted);
  console.log("draft_refund_request (client without elicitation) :", dr.content[0].text);
  if (chk.structuredContent.signed) {
    const ver = await call("verify_receipt", {});
    assert.equal(ver.structuredContent.verdict, "authentic", JSON.stringify(ver.structuredContent));
    console.log("verify_receipt :", ver.content[0].text);
    const bad = await call("verify_receipt", { demo_tamper: true });
    assert.equal(bad.structuredContent.verdict, "invalid_signature");
    console.log("verify_receipt (tampered) :", bad.content[0].text);
  } else console.log("verify_receipt : skipped (no PREDGE_KEY, so no signed receipt)");
  console.log("SMOKE OK");
} finally { await c.close(); srv.close(); }
