import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../src/server.js";
import { Agent } from "../src/agent.js";
import { MemoryStore } from "../src/store.js";
import { SAMPLE_CONFIRMATIONS } from "../src/samples.js";
import { json, mockFetch } from "./helpers.js";

const verdict = () => json({ id: "vrd_e2e", verdict: "not_delivered", checks: [{ id: "required_fields", status: "fail", reason_code: "required_field_missing" }], refund_recommended: true, refund_amount_usd: "32.000000", verify_url: "https://api.predge.io/v1/verdicts/vrd_e2e", attestation: { canonical: "{}", signature: "00", public_key: "00" } });
let srv: Server; let base: string; let url: string;
const mk = async (env: Record<string, string>, store = new MemoryStore()) => {
  const { f } = mockFetch({ "POST /v1/verdicts/large": verdict });
  const { app } = createApp({ env: { KEPT_STORE: "memory", ...env } as any, port: 0, fetch: f, store, synth: async (t) => Buffer.from("MP3:" + t) });
  const s: Server = await new Promise((r) => { const x = app.listen(0, () => r(x)); });
  return { s, base: `http://127.0.0.1:${(s.address() as any).port}` };
};
beforeAll(async () => { ({ s: srv, base } = await mk({ PREDGE_KEY: "pdg_test" })); url = base + "/mcp"; });
afterAll(() => { srv.close(); });

const connect = async (u: string, elicit?: "accept" | "decline" | "none") => {
  const c = new Client({ name: "t", version: "1" }, { capabilities: elicit && elicit !== "none" ? { elicitation: {} } : {} });
  if (elicit && elicit !== "none") c.setRequestHandler(ElicitRequestSchema, async () => elicit === "accept" ? { action: "accept" as const, content: { approve: true } } : { action: "decline" as const });
  await c.connect(new StreamableHTTPClientTransport(new URL(u)));
  return c;
};
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as any;
const buy = (c: Client) => call(c, "record_purchase", { merchant: "a ticketing service", item: "two tickets", amount_usd: 32, promised: ["ticket_id", "seat", "showtime"] });

describe("Kept over MCP", () => {
  it("lists exactly the Kept tools by default (market tools are off) and every one links the receipt card", async () => {
    const c = await connect(url);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_purchase", "draft_refund_request", "list_purchases", "record_purchase", "verify_receipt"]);
    for (const t of tools) expect((t._meta as any).ui.resourceUri).toBe("ui://kept/receipt");
    expect(JSON.stringify(tools).toLowerCase()).not.toMatch(/polymarket|prediction|gambl|uma /);
    await c.close();
  });
  it("serves the receipt card as an MCP App resource", async () => {
    const c = await connect(url);
    const res = await c.listResources();
    expect(res.resources.map((r) => r.uri)).toContain("ui://kept/receipt");
    const r: any = await c.readResource({ uri: "ui://kept/receipt" });
    expect(r.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(r.contents[0].text).toContain("ui/notifications/tool-result");
    await c.close();
  });
  it("record -> check -> list over one session, state shared across sessions", async () => {
    const c = await connect(url);
    const rec = await buy(c);
    expect(rec.content[0].text).toContain("Recorded");
    const chk = await call(c, "check_purchase", { confirmation: SAMPLE_CONFIRMATIONS.tickets.broken });
    expect(chk.content[0].text).toContain("sent no seat");
    expect(chk.structuredContent.card.state).toBe("not_delivered");
    await c.close();
    const c2 = await connect(url); // a new session, next day
    const l = await call(c2, "list_purchases", {});
    expect(l.content[0].text).toContain("not delivered");
    await c2.close();
  });
  it("elicits the human before drafting: yes drafts, no does not", async () => {
    const yes = await connect(url, "accept");
    await buy(yes); await call(yes, "check_purchase", { confirmation: SAMPLE_CONFIRMATIONS.tickets.broken });
    const r = await call(yes, "draft_refund_request", {});
    expect(r.structuredContent.drafted).toBe(true);
    expect(r.content[0].text).toContain("no money moved");
    await yes.close();

    const { s, base: b2 } = await mk({ PREDGE_KEY: "pdg_test" });
    const no = await connect(b2 + "/mcp", "decline");
    await buy(no); await call(no, "check_purchase", { confirmation: SAMPLE_CONFIRMATIONS.tickets.broken });
    const r2 = await call(no, "draft_refund_request", {});
    expect(r2.structuredContent).toMatchObject({ drafted: false, human_decision: "declined" });
    await no.close(); s.close();
  });
  it("a client without elicitation gets a confirmation request, not a draft", async () => {
    const { s, base: b2 } = await mk({ PREDGE_KEY: "pdg_test" });
    const c = await connect(b2 + "/mcp", "none");
    await buy(c); await call(c, "check_purchase", { confirmation: SAMPLE_CONFIRMATIONS.tickets.broken });
    const r = await call(c, "draft_refund_request", {});
    expect(r.structuredContent.needs_confirmation).toBe(true);
    await c.close(); s.close();
  });
  it("MCP_STATELESS=1 keeps the fresh-server-per-request mode", async () => {
    const { s, base: b2 } = await mk({ MCP_STATELESS: "1" });
    const c = await connect(b2 + "/mcp");
    expect(c.transport && (c.transport as any).sessionId).toBeUndefined();
    expect((await call(c, "list_purchases", {})).content[0].text).toContain("haven't bought");
    await c.close(); s.close();
  });
  it("ENABLE_MARKET_TOOLS=1 adds the market tools back", async () => {
    const { s, base: b2 } = await mk({ ENABLE_MARKET_TOOLS: "1" });
    const c = await connect(b2 + "/mcp");
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("check_market_settlement"); expect(names).toContain("verify_delivery");
    await c.close(); s.close();
  });
  it("healthz reports storage, flag and mode; demo helpers work; tts returns audio", async () => {
    const h: any = await (await fetch(base + "/healthz")).json();
    expect(h).toMatchObject({ storage: "memory", market_tools: false, pilot_key: true, mode: "sessions" });
    const inbox: any = await (await fetch(base + "/api/demo/inbox?tickets=broken")).json();
    expect(inbox.inbox.tickets.seat).toBeUndefined();
    expect((await (await fetch(base + "/api/demo/inbox")).json() as any).inbox.tickets.seat).toBeDefined();
    const t = await fetch(base + "/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    expect(t.headers.get("content-type")).toContain("audio/mpeg");
    expect(await t.text()).toBe("MP3:hello");
    expect((await fetch(base + "/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    expect(await (await fetch(base + "/ui/receipt")).text()).toContain("Kept");
  });
});

describe("demo agent (router path) with the elicitation relay", () => {
  it("runs buy -> arrive -> refund (human yes via /api/elicit) -> list -> verify", async () => {
    const { s, base: b2 } = await mk({ PREDGE_KEY: "pdg_test" });
    // the server's own agent is on /api/chat; force the router so no Bedrock is needed
    process.env.AGENT_FORCE_FALLBACK = "1";
    try {
      const chat = async (utterance: string, ctx: any) => (await (await fetch(b2 + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance, ctx }) })).json()) as any;
      const inbox = ((await (await fetch(b2 + "/api/demo/inbox?tickets=broken")).json()) as any).inbox;
      let r = await chat("Alexa, buy two tickets for Saturday's 7pm show.", { inbox });
      expect(r.toolCalls[0].name).toBe("record_purchase");
      r = await chat("Alexa, did my tickets arrive?", r.ctx);
      expect(r.toolCalls[0].name).toBe("check_purchase");
      expect(r.answer).toContain("sent no seat");
      const ctx = r.ctx;
      const pend = chat("Alexa, ask them for a refund.", ctx);
      let q: any;
      for (let i = 0; i < 50 && !q; i++) { await new Promise((x) => setTimeout(x, 40)); q = ((await (await fetch(b2 + "/api/pending")).json()) as any).pending[0]; }
      expect(q.message).toContain("Draft a refund request");
      await fetch(b2 + "/api/elicit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: q.id, action: "accept" }) });
      r = await pend;
      expect(r.toolCalls[0].name).toBe("draft_refund_request");
      expect(r.toolCalls[0].data.drafted).toBe(true);
      r = await chat("Alexa, what did you buy for me?", {});
      expect(r.toolCalls[0].name).toBe("list_purchases");
      expect(r.answer).toContain("refund requested");
    } finally { delete process.env.AGENT_FORCE_FALLBACK; s.close(); }
  });
  it("tells the user what it can do when nothing matches, and never calls market tools by default", async () => {
    const { s, base: b2 } = await mk({});
    const a = new Agent(b2 + "/mcp", "m", "us-east-1", { send: async () => { throw new Error("x"); } } as any);
    const r = await a.askRouter("is the peace talks market safe to cash out?", {});
    expect(r.toolCalls).toHaveLength(0);
    expect(r.answer).toContain("check that they arrived");
    s.close();
  });
});
