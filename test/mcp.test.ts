import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/server.js";
import { ACTIVE, DISPUTED_RECORD, json, mockFetch } from "./helpers.js";

let srv: Server; let url: string;
beforeAll(async () => {
  const { f } = mockFetch({ "GET /v1/settlement-risk/active": () => json(ACTIVE), "GET /v1/settlement-risk/1": () => json(DISPUTED_RECORD) });
  const { app } = createApp({ env: { PORT: "0", ENABLE_MARKET_TOOLS: "1", KEPT_STORE: "memory" } as any, port: 0, fetch: f });
  await new Promise<void>((r) => { srv = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(srv.address() as any).port}/mcp`;
});
afterAll(() => { srv.close(); });

describe("MCP over Streamable HTTP", () => {
  it("negotiates spec 2025-11-25 and lists the Kept tools plus the flagged market tools", async () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    expect(c.getServerVersion()?.name).toBe("kept");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["active_disputes", "check_market_settlement", "check_purchase", "draft_refund_request", "list_purchases", "record_purchase", "verify_delivery", "verify_receipt", "verify_record"]);
    await c.close();
  });
  it("tools/call returns speakable text and structuredContent", async () => {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    const r: any = await c.callTool({ name: "check_market_settlement", arguments: { market: "Russia-Ukraine peace talks" } });
    expect(r.content[0].text).toContain("UMA vote");
    expect(r.structuredContent.risk_level).toBe("caution");
    await c.close();
  });
  it("answers GET /mcp with 405 (stateless server)", async () => {
    expect((await fetch(url)).status).toBe(405);
  });
});
