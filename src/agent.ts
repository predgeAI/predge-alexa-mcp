import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";

export interface LastJob { endpoint: string; amount_usd: number; delivery_status: number; delivery_body: string; delivery_content_type?: string; expected_content_type?: string; required_fields?: string[]; payer?: string; payee?: string; merchant_id?: string; note?: string }
export interface Ctx { lastMarket?: string; lastJob?: LastJob }
export interface ToolCall { name: string; args: unknown; text: string; data: unknown; isError?: boolean }
export interface AgentReply { answer: string; path: "bedrock" | "fallback"; model?: string; reason?: string; toolCalls: ToolCall[]; ctx: Ctx }

const SYSTEM = `You are the voice assistant in a simulated Alexa+ experience. The user speaks; your answer is read aloud.
Rules: answer in one to three short spoken sentences, no markdown, no lists, no URLs, no emoji. Use the tools for every question about Polymarket settlement, disputes, paid deliveries or signed records; never guess. Repeat the tool's key finding in your own words and stay faithful to it. Never give financial advice; if asked whether to cash out, report the settlement status and say what it means for finality.
If the user asks whether work they paid for arrived, call verify_delivery using the "last paid job" below. If they ask to verify or check a record or signature, call verify_record (use the last market discussed if they do not name one).`;

export class Agent {
  private mcp?: Client;
  private bedrock?: BedrockRuntimeClient;
  private bedrockDownUntil = 0;
  constructor(private mcpUrl: string, private modelId = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-5-20250929-v1:0", private region = process.env.AWS_REGION || "us-east-1", bedrock?: Pick<BedrockRuntimeClient, "send">) { this.bedrock = bedrock as BedrockRuntimeClient | undefined; }

  private async client(): Promise<Client> {
    if (this.mcp) return this.mcp;
    const c = new Client({ name: "predge-alexa-demo-agent", version: "0.1.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    this.mcp = c;
    return c;
  }
  async protocolVersion() { const c = await this.client(); return { server: c.getServerVersion(), tools: (await c.listTools()).tools.map((t) => t.name) }; }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const c = await this.client();
    const r: any = await c.callTool({ name, arguments: args });
    const text = (r.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join(" ");
    return { name, args, text, data: r.structuredContent, isError: r.isError };
  }

  async ask(utterance: string, ctx: Ctx = {}): Promise<AgentReply> {
    const u = utterance.replace(/^\s*(hey\s+)?alexa[,.!]?\s*/i, "").trim() || utterance;
    let reason: string;
    if (process.env.AGENT_FORCE_FALLBACK === "1") reason = "AGENT_FORCE_FALLBACK=1";
    else if (Date.now() < this.bedrockDownUntil) reason = "Bedrock unavailable (recent failure), using router";
    else {
      try {
        const r = await this.askBedrock(u, ctx);
        console.log(`[agent] path=bedrock model=${this.modelId} tools=${r.toolCalls.map((t) => t.name).join(",") || "none"}`);
        return r;
      } catch (e) {
        const name = (e as Error)?.name ?? "Error";
        reason = `Bedrock failed (${name}: ${String((e as Error)?.message ?? e).slice(0, 160)})`;
        this.bedrockDownUntil = Date.now() + 60_000;
      }
    }
    console.warn(`[agent] path=fallback reason=${reason}`);
    const r = await this.askRouter(u, ctx);
    return { ...r, reason };
  }

  // --- Amazon Bedrock Converse with MCP tools --------------------------------------------------
  private async askBedrock(u: string, ctx: Ctx): Promise<AgentReply> {
    this.bedrock ??= new BedrockRuntimeClient({ region: this.region });
    const tools = (await (await this.client()).listTools()).tools;
    const toolConfig = { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as any } } })) };
    const system = [{ text: SYSTEM + `\nLast market discussed: ${ctx.lastMarket ?? "none"}.\nLast paid job (JSON): ${JSON.stringify(ctx.lastJob ?? null)}` }];
    const messages: Message[] = [{ role: "user", content: [{ text: u }] }];
    const toolCalls: ToolCall[] = [];
    const next: Ctx = { ...ctx };
    for (let i = 0; i < 5; i++) {
      const res = await this.bedrock.send(new ConverseCommand({ modelId: this.modelId, system, messages, toolConfig, inferenceConfig: { maxTokens: 400, temperature: 0.2 } }));
      const msg = res.output?.message;
      if (!msg) throw new Error("empty Bedrock response");
      messages.push(msg);
      const uses = (msg.content ?? []).filter((b) => b.toolUse);
      if (res.stopReason !== "tool_use" || !uses.length) {
        const answer = (msg.content ?? []).map((b) => b.text ?? "").join(" ").trim();
        return { answer: answer || toolCalls.at(-1)?.text || "Sorry, I didn't get that.", path: "bedrock", model: this.modelId, toolCalls, ctx: next };
      }
      const results = [];
      for (const b of uses) {
        const tu = b.toolUse!;
        const tc = await this.callTool(tu.name!, (tu.input ?? {}) as Record<string, unknown>);
        toolCalls.push(tc);
        const q = (tc.data as any)?.resolved?.market ?? (tc.data as any)?.market_id;
        if (q && (tu.name === "check_market_settlement")) next.lastMarket = String(q);
        results.push({ toolResult: { toolUseId: tu.toolUseId, status: tc.isError ? ("error" as const) : ("success" as const), content: [{ text: tc.text }, { json: JSON.parse(JSON.stringify(tc.data ?? {})) }] } });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("tool loop did not finish");
  }

  // --- Deterministic intent router (no model) --------------------------------------------------
  async askRouter(u: string, ctx: Ctx): Promise<AgentReply> {
    const t = u.toLowerCase();
    const next: Ctx = { ...ctx };
    const toolCalls: ToolCall[] = [];
    const run = async (name: string, args: Record<string, unknown>) => { const tc = await this.callTool(name, args); toolCalls.push(tc); return tc; };

    if (/(verify|check|is).*(record|signature|authentic|genuine|signed)|authentic|tamper/.test(t)) {
      const market = ctx.lastMarket;
      const tc = await run("verify_record", { market: market ?? "russia-ukraine-peace-talks-by-october-31-2026", ...(/tamper|alter|fake|forge/.test(t) ? { demo_tamper: true } : {}) });
      return { answer: tc.text, path: "fallback", toolCalls, ctx: next };
    }
    if (/did.*(work|delivery|deliver|arrive)|paid for|deliver(ed|y)|refund/.test(t) && ctx.lastJob) {
      const { note: _n, ...job } = ctx.lastJob;
      const tc = await run("verify_delivery", job as Record<string, unknown>);
      return { answer: tc.text, path: "fallback", toolCalls, ctx: next };
    }
    if (/what markets|which markets|in dispute|disputed|disputes|any disputes|right now/.test(t) && !/safe|cash/.test(t)) {
      const topic = t.match(/\b(?:about|on|for|related to)\s+([a-z ]{3,30})$/)?.[1];
      const tc = await run("active_disputes", { limit: 3, ...(topic ? { topic } : {}) });
      return { answer: tc.text, path: "fallback", toolCalls, ctx: next };
    }
    const tc = await run("check_market_settlement", { market: u });
    const q = (tc.data as any)?.resolved?.market; if (q) next.lastMarket = String(q);
    return { answer: tc.text, path: "fallback", toolCalls, ctx: next };
  }
}
