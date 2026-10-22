import type { KeyEntry } from "./verify.js";

export type FetchFn = typeof fetch;

export interface PredgeConfig {
  api: string;
  key?: string;
  fetch: FetchFn;
}

export function configFromEnv(env = process.env, f: FetchFn = fetch): PredgeConfig {
  return { api: (env.PREDGE_API || "https://api.predge.io").replace(/\/$/, ""), key: env.PREDGE_KEY || undefined, fetch: f };
}

export class PredgeError extends Error {
  constructor(public status: number, public body: unknown, msg: string) { super(msg); }
}

async function call(cfg: PredgeConfig, path: string, init?: RequestInit & { headers?: Record<string, string> }) {
  const res = await cfg.fetch(cfg.api + path, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(25_000) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) throw new PredgeError(res.status, body, `Predge API ${path} answered HTTP ${res.status}`);
  return body as any;
}

export const getSettlementRisk = (cfg: PredgeConfig, market: string) =>
  call(cfg, `/v1/settlement-risk/${encodeURIComponent(market)}`, cfg.key ? { headers: { "x-predge-key": cfg.key } } : undefined);
export const getActive = (cfg: PredgeConfig) => call(cfg, "/v1/settlement-risk/active");
export const getKeys = async (cfg: PredgeConfig): Promise<KeyEntry[]> => (await call(cfg, "/.well-known/predge-keys.json")).keys ?? [];
export const getVerdict = (cfg: PredgeConfig, id: string) => call(cfg, `/v1/verdicts/${encodeURIComponent(id)}`);
export const postVerdict = (cfg: PredgeConfig, body: unknown, large: boolean) =>
  call(cfg, large ? "/v1/verdicts/large" : "/v1/verdicts", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.key ? { "x-predge-key": cfg.key } : {}) },
    body: JSON.stringify(body),
  });
