// Live smoke test: starts the server, talks to it over MCP Streamable HTTP, and hits the real free Predge routes.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.js";

const { app } = createApp({ port: 0 });
const srv = app.listen(0);
const port = (srv.address() as any).port;
const c = new Client({ name: "smoke", version: "1" });
await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
const call = async (name: string, args: Record<string, unknown>) => { const r: any = await c.callTool({ name, arguments: args }); return r; };
try {
  const act = await call("active_disputes", { limit: 3 });
  assert.ok(!act.isError, act.content?.[0]?.text);
  assert.ok(act.structuredContent.markets.length > 0, "dispute list should not be empty");
  console.log("active_disputes :", act.content[0].text);

  const first = act.structuredContent.markets[0];
  const chk = await call("check_market_settlement", { market: String(first.market_id) });
  assert.ok(!chk.isError, chk.content?.[0]?.text);
  assert.ok(chk.structuredContent.signed, "free record should carry an attestation");
  console.log("check_market_settlement :", chk.content[0].text);

  const ver = await call("verify_record", { market: String(first.market_id) });
  assert.equal(ver.structuredContent.verdict, "authentic", JSON.stringify(ver.structuredContent));
  console.log("verify_record :", ver.content[0].text);

  const bad = await call("verify_record", { market: String(first.market_id), demo_tamper: true });
  assert.equal(bad.structuredContent.verdict, "invalid_signature");
  console.log("verify_record (tampered) :", bad.content[0].text);
  console.log("SMOKE OK");
} finally { await c.close(); srv.close(); }
