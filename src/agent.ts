import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SAMPLE_CONFIRMATIONS, SAMPLE_PURCHASES, kindOf, type Kind } from "./samples.js";

export interface LastJob { endpoint: string; amount_usd: number; delivery_status: number; delivery_body: string; delivery_content_type?: string; expected_content_type?: string; required_fields?: string[]; payer?: string; payee?: string; merchant_id?: string; note?: string }
/** inbox: sample merchant confirmations the simulated mailbox holds, by purchase kind. purchases: ids recorded in this session. */
export interface Ctx { lastMarket?: string; lastJob?: LastJob; inbox?: Partial<Record<Kind, Record<string, unknown>>>; purchases?: Partial<Record<Kind, string>>; lastKind?: Kind }
export interface ToolCall { name: string; args: unknown; text: string; data: unknown; isError?: boolean }
export interface AgentReply { answer: string; path: "bedrock" | "fallback"; model?: string; reason?: string; toolCalls: ToolCall[]; ctx: Ctx }
export type ElicitAnswer = "accept" | "decline";

const catalog = () => (Object.entries(SAMPLE_PURCHASES) as [Kind, (typeof SAMPLE_PURCHASES)[Kind]][]).map(([k, p]) => `- ${k}: merchant "${p.merchant}", item "${p.item}", amount_usd ${p.amount_usd}, promised ${JSON.stringify(p.promised)}, due_by "${p.due_by}"`).join("\n");

const SYSTEM = `You are the voice assistant in a simulated Alexa+ experience. The user speaks; your answer is read aloud. You use the Kept tools, which remember what you bought for the household and check that it arrived.
Rules: answer in one to three short spoken sentences, no markdown, no lists, no URLs, no emoji. Use the tools; never guess.
- When the user asks you to buy something that matches the sample catalog below, pretend the purchase went through, then call record_purchase with the catalog values for that item.
- When the user asks whether something arrived, call check_purchase with the matching merchant confirmation from the inbox below (pass it as the confirmation argument, and the purchase_id if you know it).
- When the user asks for a refund, call draft_refund_request. It asks the human for a yes itself; never claim a refund was sent or money moved. Kept only drafts.
- For "what did you buy for me" or "is anything open", call list_purchases. To verify a receipt or signature, call verify_receipt (add demo_tamper only if the user asks to tamper with or alter it).
- Repeat the tool's key finding in your own words and stay faithful to it. If a result says it is an offline sample check, say so.
Sample catalog:
`;

export interface AgentOpts { marketTools?: boolean; onElicit?: (message: string) => Promise<ElicitAnswer> }

export class Agent {
  private mcp?: Client;
  private bedrock?: BedrockRuntimeClient;
  private bedrockDownUntil = 0;
  private marketTools: boolean;
  /** Called when a tool asks the human a question (MCP elicitation). The server wires this to the demo UI. */
  onElicit: (message: string) => Promise<ElicitAnswer>;
  constructor(private mcpUrl: string, private modelId = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-sonnet-4-5-20250929-v1:0", private region = process.env.AWS_REGION || "us-east-1", bedrock?: Pick<BedrockRuntimeClient, "send">, opts: AgentOpts = {}) {
    this.bedrock = bedrock as BedrockRuntimeClient | undefined;
    this.marketTools = opts.marketTools ?? process.env.ENABLE_MARKET_TOOLS === "1";
    this.onElicit = opts.onElicit ?? (async () => "decline");
  }

  private async client(): Promise<Client> {
    if (this.mcp) return this.mcp;
    const c = new Client({ name: "kept-demo-agent", version: "0.2.0" }, { capabilities: { elicitation: {} } });
    c.setRequestHandler(ElicitRequestSchema, async (req) => {
      const ans = await this.onElicit(String((req.params as any).message ?? ""));
      return ans === "accept" ? { action: "accept" as const, content: { approve: true } } : { action: "decline" as const };
    });
    await c.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    this.mcp = c;
    return c;
  }
  async protocolVersion() { const c = await this.client(); return { server: c.getServerVersion(), tools: (await c.listTools()).tools.map((t) => t.name) }; }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const run = async () => {
      const c = await this.client();
      // Long timeout: an elicitation waits for a human.
      return (await c.callTool({ name, arguments: args }, undefined, { timeout: 330_000 })) as any;
    };
    let r: any;
    try { r = await run(); } catch (e) { this.mcp = undefined; if (/session|404|fetch failed|closed/i.test(String((e as Error)?.message))) r = await run(); else throw e; }
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

  /** Tracks which purchase ids this session knows, from tool results. */
  private learn(next: Ctx, tc: ToolCall) {
    const d: any = tc.data;
    const id = d?.purchase?.id;
    if (id && tc.name === "record_purchase") {
      const k = kindOf(`${d.purchase.merchant} ${d.purchase.item}`);
      if (k) { next.purchases = { ...next.purchases, [k]: id }; next.lastKind = k; }
    }
    const q = d?.resolved?.market ?? d?.market_id;
    if (q && tc.name === "check_market_settlement") next.lastMarket = String(q);
  }

  // --- Amazon Bedrock Converse with MCP tools --------------------------------------------------
  private async askBedrock(u: string, ctx: Ctx): Promise<AgentReply> {
    this.bedrock ??= new BedrockRuntimeClient({ region: this.region });
    const tools = (await (await this.client()).listTools()).tools;
    const toolConfig = { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as any } } })) };
    const inbox = Object.entries(ctx.inbox ?? {}).map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join("\n") || "(empty)";
    const system = [{ text: SYSTEM + catalog() + `\nInbox (SAMPLE merchant confirmations, by kind):\n${inbox}\nPurchase ids recorded this session: ${JSON.stringify(ctx.purchases ?? {})}` + (this.marketTools ? `\nLast market discussed: ${ctx.lastMarket ?? "none"}.\nLast paid job (JSON): ${JSON.stringify(ctx.lastJob ?? null)}` : "") }];
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
        this.learn(next, tc);
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
    const run = async (name: string, args: Record<string, unknown>) => { const tc = await this.callTool(name, args); toolCalls.push(tc); this.learn(next, tc); return tc; };
    const done = (answer: string): AgentReply => ({ answer, path: "fallback", toolCalls, ctx: next });
    const kind = kindOf(t) ?? ctx.lastKind;

    if (/\b(buy|book|order|get|purchase)\b/.test(t) && kindOf(t) && !/\b(did|was|were|has|have)\b/.test(t)) {
      const p = SAMPLE_PURCHASES[kindOf(t)!];
      return done((await run("record_purchase", { merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, promised: p.promised, due_by: p.due_by })).text);
    }
    if (/refund/.test(t)) {
      const named = kindOf(t);
      const id = named && ctx.purchases?.[named];
      return done((await run("draft_refund_request", id ? { purchase_id: id } : {})).text);
    }
    if (/verify|signature|authentic|tamper|genuine/.test(t) && !(this.marketTools && /record/.test(t) && ctx.lastMarket)) {
      return done((await run("verify_receipt", /tamper|alter|fake|forge|change/.test(t) ? { demo_tamper: true } : {})).text);
    }
    if (/what.*(buy|bought|purchas)|everything|anything.*(open|unconfirmed|missing)|\bopen\b|unconfirmed|this week/.test(t)) {
      return done((await run("list_purchases", /open|unconfirmed|missing/.test(t) ? { only_open: true } : {})).text);
    }
    if (/arrive|deliver|came|come through|go through|went through|check|confirm|get what|show up|receive/.test(t) && kind && ctx.inbox?.[kind]) {
      const id = ctx.purchases?.[kind];
      return done((await run("check_purchase", { ...(id ? { purchase_id: id } : {}), confirmation: ctx.inbox[kind]! })).text);
    }
    if (this.marketTools) {
      if (/did.*(work|delivery|deliver|arrive)|paid for|deliver(ed|y)|refund/.test(t) && ctx.lastJob) {
        const { note: _n, ...job } = ctx.lastJob;
        return done((await run("verify_delivery", job as Record<string, unknown>)).text);
      }
      if (/(verify|check|is).*(record|signature|authentic|genuine|signed)|authentic|tamper/.test(t)) {
        return done((await run("verify_record", { market: ctx.lastMarket ?? "russia-ukraine-peace-talks-by-october-31-2026", ...(/tamper|alter|fake|forge/.test(t) ? { demo_tamper: true } : {}) })).text);
      }
      if (/what markets|which markets|in dispute|disputed|disputes|any disputes|right now/.test(t) && !/safe|cash/.test(t)) {
        const topic = t.match(/\b(?:about|on|for|related to)\s+([a-z ]{3,30})$/)?.[1];
        return done((await run("active_disputes", { limit: 3, ...(topic ? { topic } : {}) })).text);
      }
      return done((await run("check_market_settlement", { market: u })).text);
    }
    return done("I can buy things for you and then check that they arrived. Try: buy two tickets for Saturday, did my tickets arrive, or what did you buy for me.");
  }
}
