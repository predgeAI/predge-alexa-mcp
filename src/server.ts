import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, SERVER_INFO } from "./mcp.js";
import { configFromEnv } from "./predge.js";
import { Agent, type Ctx } from "./agent.js";

export function createApp(opts: { env?: NodeJS.ProcessEnv; port?: number; fetch?: typeof fetch } = {}) {
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

  // MCP Streamable HTTP, stateless: a fresh server + transport per request (SDK pattern for horizontally scalable servers).
  app.post("/mcp", guard, async (req, res) => {
    const server = createMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp] error", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const notAllowed: express.RequestHandler = (_req, res) => { res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }); };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  const agent = new Agent(`http://127.0.0.1:${port}/mcp`);
  app.post("/api/chat", async (req, res) => {
    const { utterance, ctx } = (req.body ?? {}) as { utterance?: string; ctx?: Ctx };
    if (!utterance || typeof utterance !== "string" || utterance.length > 500) { res.status(400).json({ error: "utterance required (max 500 chars)" }); return; }
    try { res.json(await agent.ask(utterance, ctx ?? {})); }
    catch (e) { console.error("[chat]", e); res.status(500).json({ error: "agent_failed", message: String((e as Error).message) }); }
  });

  app.get("/healthz", (_req, res) => { res.json({ ok: true, server: SERVER_INFO, protocol: LATEST_PROTOCOL_VERSION, supported: SUPPORTED_PROTOCOL_VERSIONS, pilot_key: Boolean(cfg.key), api: cfg.api }); });
  const here = dirname(fileURLToPath(import.meta.url));
  app.get(["/demo", "/"], (_req, res) => res.sendFile(join(here, "..", "demo", "index.html")));
  return { app, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { app, port } = createApp();
  app.listen(port, () => {
    console.log(`predge-alexa-mcp listening: MCP http://localhost:${port}/mcp  demo http://localhost:${port}/demo`);
    console.log(`protocol ${LATEST_PROTOCOL_VERSION}; pilot key ${process.env.PREDGE_KEY ? "set" : "NOT set (verify_delivery disabled)"}; bedrock model ${process.env.BEDROCK_MODEL_ID || "default"}`);
  });
}
