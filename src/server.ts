import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { createMcpServer, SERVER_INFO } from "./mcp.js";
import { configFromEnv } from "./predge.js";
import { Agent, type Ctx, type ElicitAnswer } from "./agent.js";
import { AutoStore, type PurchaseStore } from "./store.js";
import { HOUSEHOLD_DEFAULT } from "./kept.js";
import { RECEIPT_HTML } from "./card.js";
import { SAMPLE_CONFIRMATIONS, type Kind } from "./samples.js";

type Synth = (text: string) => Promise<Buffer>;

export function createApp(opts: { env?: NodeJS.ProcessEnv; port?: number; fetch?: typeof fetch; store?: PurchaseStore; synth?: Synth } = {}) {
  const env = opts.env ?? process.env;
  const cfg = configFromEnv(env, opts.fetch ?? fetch);
  const port = opts.port ?? Number(env.PORT || 8787);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Optional shared secret for a public deployment: set MCP_AUTH_TOKEN and send "Authorization: Bearer <token>".
  const guard: express.RequestHandler = (req, res, next) => {
    const t = env.MCP_AUTH_TOKEN;
    if (t && req.headers.authorization !== `Bearer ${t}`) { res.status(401).json({ error: "unauthorized" }); return; }
    next();
  };

  const marketTools = env.ENABLE_MARKET_TOOLS === "1";
  const household = env.KEPT_HOUSEHOLD || HOUSEHOLD_DEFAULT;
  const store = opts.store ?? new AutoStore(env);
  const deps = { store, household, marketTools };

  // MCP Streamable HTTP. Default: sessions (needed so a tool can ask the human a question with elicitation and get the
  // answer back on the same server instance). MCP_STATELESS=1 gives the fresh-server-per-request mode (no elicitation; fits Lambda).
  const stateless = env.MCP_STATELESS === "1";
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; seen: number }>();
  const sweep = setInterval(() => { const cut = Date.now() - 30 * 60_000; for (const [id, s] of sessions) if (s.seen < cut) { void s.transport.close(); sessions.delete(id); } }, 5 * 60_000);
  sweep.unref();
  const rpcError = (res: express.Response, status: number, code: number, message: string) => res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });

  app.post("/mcp", guard, async (req, res) => {
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      if (!stateless && sid) {
        const s = sessions.get(sid);
        if (!s) { rpcError(res, 404, -32001, "Session not found"); return; }
        s.seen = Date.now();
        await s.transport.handleRequest(req, res, req.body);
        return;
      }
      const server = createMcpServer(cfg, deps);
      if (!stateless && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(), enableJsonResponse: false,
          onsessioninitialized: (id) => { sessions.set(id, { transport, seen: Date.now() }); },
        });
        transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp] error", e);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });
  const sessionOnly: express.RequestHandler = async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const s = sid ? sessions.get(sid) : undefined;
    if (s && !stateless) { s.seen = Date.now(); await s.transport.handleRequest(req, res); return; }
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed without a session (POST only)" }, id: null });
  };
  app.get("/mcp", guard, sessionOnly);
  app.delete("/mcp", guard, sessionOnly);

  let agentInstance: Agent | undefined;
  // Created on first use so the MCP URL uses the port the server really listens on (also when started with port 0).
  const getAgent = (localPort?: number) => (agentInstance ??= new Agent(`http://127.0.0.1:${localPort || port}/mcp`, undefined, undefined, undefined, { marketTools, onElicit }));
  // Elicitation relay: the agent's MCP client receives the tool's question; the demo page polls /api/pending and answers via /api/elicit.
  const pending = new Map<string, { message: string; resolve: (a: ElicitAnswer) => void }>();
  const onElicit = (message: string) => new Promise<ElicitAnswer>((resolve) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); resolve("decline"); }, 300_000);
    timer.unref();
    pending.set(id, { message, resolve: (a) => { clearTimeout(timer); pending.delete(id); resolve(a); } });
  });
  app.get("/api/pending", (_req, res) => { res.json({ pending: [...pending].map(([id, p]) => ({ id, message: p.message })) }); });
  app.post("/api/elicit", (req, res) => {
    const { id, action } = (req.body ?? {}) as { id?: string; action?: string };
    const p = id ? pending.get(id) : undefined;
    if (!p) { res.status(404).json({ error: "no such pending question" }); return; }
    p.resolve(action === "accept" ? "accept" : "decline");
    res.json({ ok: true });
  });

  // Demo helpers. Sample merchant confirmations are fixtures, labelled as samples in the UI.
  app.get("/api/demo/inbox", (req, res) => {
    const inbox: Record<string, unknown> = {};
    for (const k of Object.keys(SAMPLE_CONFIRMATIONS) as Kind[]) inbox[k] = SAMPLE_CONFIRMATIONS[k][req.query[k] === "broken" ? "broken" : "ok"];
    res.json({ inbox, sample: true });
  });
  app.post("/api/demo/reset", async (_req, res) => { await store.clear(household); res.json({ ok: true, household }); });
  app.get("/ui/receipt", (_req, res) => { res.type("text/html").send(RECEIPT_HTML); });

  // Amazon Polly narration for the demo (neural voice). 503 when AWS is not configured; the page then falls back to the browser voice.
  let polly: PollyClient | undefined;
  const synth: Synth = opts.synth ?? (async (text) => {
    polly ??= new PollyClient({ region: env.AWS_REGION || "us-east-1" });
    const r = await polly.send(new SynthesizeSpeechCommand({ Text: text, OutputFormat: "mp3", VoiceId: (env.POLLY_VOICE || "Joanna") as any, Engine: "neural" }));
    return Buffer.from(await r.AudioStream!.transformToByteArray());
  });
  app.post("/api/tts", async (req, res) => {
    const text = (req.body ?? {}).text;
    if (typeof text !== "string" || !text.trim() || text.length > 600) { res.status(400).json({ error: "text required (max 600 chars)" }); return; }
    try { res.type("audio/mpeg").send(await synth(text)); }
    catch (e) { res.status(503).json({ error: "tts_unavailable", message: String((e as Error)?.message ?? e).slice(0, 160) }); }
  });

  app.post("/api/chat", async (req, res) => {
    const { utterance, ctx } = (req.body ?? {}) as { utterance?: string; ctx?: Ctx };
    if (!utterance || typeof utterance !== "string" || utterance.length > 500) { res.status(400).json({ error: "utterance required (max 500 chars)" }); return; }
    try { res.json(await getAgent(req.socket.localPort).ask(utterance, ctx ?? {})); }
    catch (e) { console.error("[chat]", e); res.status(500).json({ error: "agent_failed", message: String((e as Error).message) }); }
  });

  app.get("/healthz", (_req, res) => { res.json({ ok: true, server: SERVER_INFO, protocol: LATEST_PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL_VERSIONS, pilot_key: Boolean(cfg.key), api: cfg.api, storage: store.kind, storage_note: (store as any).fallbackReason ?? null, market_tools: marketTools, mode: stateless ? "stateless" : "sessions", bedrock_model: env.BEDROCK_MODEL_ID || "default", household }); });
  const here = dirname(fileURLToPath(import.meta.url));
  app.get(["/demo", "/"], (_req, res) => res.sendFile(join(here, "..", "demo", "index.html")));
  return { app, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { app, port } = createApp();
  app.listen(port, () => {
    console.log(`Kept (predge-alexa-mcp) listening: MCP http://localhost:${port}/mcp  demo http://localhost:${port}/demo`);
    console.log(`protocol ${LATEST_PROTOCOL_VERSION}; pilot key ${process.env.PREDGE_KEY ? "set" : "NOT set (check_purchase uses the labelled offline sample path)"}; bedrock model ${process.env.BEDROCK_MODEL_ID || "default"}`);
  });
}
