import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Agent } from "../src/agent.js";
import { createApp } from "../src/server.js";
import { ACTIVE, DISPUTED_RECORD, json, mockFetch } from "./helpers.js";

let srv: Server; let url: string;
beforeAll(async () => {
  const { f } = mockFetch({ "GET /v1/settlement-risk/active": () => json(ACTIVE), "GET /v1/settlement-risk/1": () => json(DISPUTED_RECORD) });
  const { app } = createApp({ env: { ENABLE_MARKET_TOOLS: "1", KEPT_STORE: "memory" } as any, port: 0, fetch: f });
  await new Promise<void>((r) => { srv = app.listen(0, () => r()); });
  url = `http://127.0.0.1:${(srv.address() as any).port}/mcp`;
});
afterAll(() => { srv.close(); });

describe("Agent", () => {
  it("runs the Bedrock Converse tool loop against the MCP server (client faked)", async () => {
    const sent: any[] = [];
    const fake = {
      send: async (cmd: any) => {
        sent.push(cmd.input);
        if (sent.length === 1) return { stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "check_market_settlement", input: { market: "Russia Ukraine peace talks" } } }] } } };
        return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "That market is disputed and heading to a UMA vote, so it is not settled yet." }] } } };
      },
    };
    const agent = new Agent(url, "test-model", "us-east-1", fake as any, { marketTools: true });
    const r = await agent.ask("Alexa, is the Russia-Ukraine peace talks market safe to cash out?");
    expect(r.path).toBe("bedrock");
    expect(r.toolCalls[0].name).toBe("check_market_settlement");
    expect(r.answer).toContain("not settled yet");
    expect(r.ctx.lastMarket).toBe("1");
    expect(sent[0].toolConfig.tools.map((t: any) => t.toolSpec.name)).toContain("verify_receipt");
    expect(sent[0].messages[0].content[0].text).not.toMatch(/^alexa/i);
    const toolResultMsg = sent[1].messages[2];
    expect(toolResultMsg.content[0].toolResult.status).toBe("success");
  });

  it("falls back to the router and says why when Bedrock fails", async () => {
    const boom = { send: async () => { throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }); } };
    const agent = new Agent(url, "m", "us-east-1", boom as any, { marketTools: true });
    const r = await agent.ask("what markets are in dispute right now?");
    expect(r.path).toBe("fallback");
    expect(r.reason).toContain("AccessDeniedException");
    expect(r.toolCalls[0].name).toBe("active_disputes");
    // second call skips Bedrock for a minute
    expect((await agent.ask("what markets are in dispute right now?")).reason).toContain("recent failure");
  });

  it("router handles the three demo utterances", async () => {
    const agent = new Agent(url, "m", "us-east-1", { send: async () => { throw new Error("x"); } } as any, { marketTools: true });
    expect((await agent.askRouter("is the Russia-Ukraine peace talks market safe to cash out?", {})).toolCalls[0].name).toBe("check_market_settlement");
    expect((await agent.askRouter("what markets are in dispute right now?", {})).toolCalls[0].name).toBe("active_disputes");
    const job = { endpoint: "https://x", amount_usd: 0.25, delivery_status: 502, delivery_body: "" };
    const r = await agent.askRouter("did the work I paid for actually arrive?", { lastJob: job });
    expect(r.toolCalls[0].name).toBe("verify_delivery");
  });
});
