import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalize } from "../src/verify.js";
import type { PredgeConfig } from "../src/predge.js";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route table -> fetch mock. Keys are "METHOD path-prefix". */
export function mockFetch(routes: Record<string, (req: { url: string; init?: RequestInit }) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); calls.push({ url: u, init });
    const path = u.replace("https://api.predge.io", "");
    const key = Object.keys(routes).find((k) => { const [m, p] = k.split(" "); return (init?.method ?? "GET") === m && path.startsWith(p); });
    if (!key) return json({ error: "no_mock", path }, 599);
    return routes[key]({ url: u, init });
  }) as typeof fetch;
  return { f, calls };
}
export const cfgOf = (f: typeof fetch, key?: string): PredgeConfig => ({ api: "https://api.predge.io", key, fetch: f });

/** A real ed25519 key pair and a record signed with it, shaped like a Predge attestation. */
export function signedRecord(payload: Record<string, unknown> = { market: "m1", risk_level: "caution" }) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const canonical = canonicalize(payload);
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("hex");
  return { public_key: raw, att: { canonical, signature, public_key: raw, kid: "testkid", kind: "settlement-risk", payload } };
}

export const ACTIVE = {
  generated_at: "2026-10-22T21:00:00Z", open_disputes_now: 2, in_uma_vote_now: 2,
  counts: { last_7d: { disputed_markets: 10 } },
  markets: [
    { market_id: "1", title: "Russia-Ukraine peace talks by October 31, 2026?", status: "uma_vote", open_dispute: true, dispute_count: 2, last_disputed_at: "2026-10-21T23:36:53Z", record_path: "/v1/settlement-risk/1" },
    { market_id: "2", title: "Will the price of Ethereum be above $2,400 on October 22?", status: "uma_vote", open_dispute: true, dispute_count: 2, last_disputed_at: "2026-10-22T16:02:08Z", record_path: "/v1/settlement-risk/2" },
    { market_id: "3", title: "Will Madura United win on 2026-10-22?", status: "resolved", open_dispute: false, dispute_count: 1, last_disputed_at: "2026-10-22T10:00:00Z", record_path: "/v1/settlement-risk/3" },
  ],
};
export const DISPUTED_RECORD = {
  market: { market_id: "1", question: "Russia-Ukraine peace talks by October 31, 2026?", slug: "russia-ukraine-peace-talks-by-october-31-2026" },
  risk_level: "caution", uma_state: "disputed", open_dispute: true, sent_to_uma_vote: true, dispute_count: 2, resolved_on_chain: false,
  current_proposal: null, onchain_resolution: null, checked_at: "2026-10-22T22:00:00Z", recommendation: "caution: disputed twice",
  disputes: [{ disputed_at: "2026-10-21T23:33:15Z" }, { disputed_at: "2026-10-21T23:36:53Z" }], attestation: { canonical: "{}", signature: "00", public_key: "00" },
};
