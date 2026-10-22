import * as predge from "./predge.js";
import { PredgeError, type PredgeConfig } from "./predge.js";
import { verifyAttestation, type Attestation } from "./verify.js";

/** What every tool returns: a sentence that can be read aloud, plus structured data. */
export interface ToolResult {
  text: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

const STOP = new Set(["the","a","an","is","are","was","will","be","by","on","in","of","to","and","or","for","it","this","that","market","markets","safe","cash","out","cashing","settle","settled","settlement","risk","check","about","alexa","what","whats","does","do","any","there","polymarket","bet","question","dispute","disputed"]);
const tokens = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9$%.\s-]/g, " ").replace(/[-_]/g, " ").split(/\s+/).map((t) => t.replace(/^[.$]+|[.]+$/g, "")).filter((t) => t && !STOP.has(t));

const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/;
const NUMERIC_ID = /^\d{1,12}$/;
const SLUG = /^[a-z0-9][a-z0-9]*(-[a-z0-9]+)+$/;

export interface Resolved { market: string; via: "id" | "slug" | "url" | "title_search"; title?: string; alternatives?: { market_id: string; title: string }[] }

/** Turns what a person says into something the API accepts. Names are matched against the public dispute list. */
export async function resolveMarket(cfg: PredgeConfig, input: string): Promise<Resolved | null> {
  const q = input.trim();
  const urlMatch = q.match(/polymarket\.com\/(?:event\/[^/\s]+\/)?(?:market\/)?([a-z0-9-]+)\/?(?:\?.*)?$/i);
  if (urlMatch) return { market: urlMatch[1].toLowerCase(), via: "url" };
  if (CONDITION_ID.test(q) || NUMERIC_ID.test(q)) return { market: q, via: "id" };
  if (SLUG.test(q)) return { market: q, via: "slug" };
  const qt = [...new Set(tokens(q))];
  if (!qt.length) return null;
  const active = await predge.getActive(cfg);
  const scored = (active.markets as any[])
    .map((m) => {
      const tt = new Set(tokens(m.title));
      const hit = qt.filter((t) => tt.has(t)).length;
      return { m, cover: hit / qt.length, titleCover: hit / Math.max(tt.size, 1), open: m.open_dispute ? 1 : 0 };
    })
    .filter((x) => x.cover >= 0.6)
    .sort((a, b) => b.cover - a.cover || b.open - a.open || b.titleCover - a.titleCover);
  if (!scored.length) return null;
  const best = scored[0];
  return {
    market: String(best.m.market_id), via: "title_search", title: best.m.title,
    alternatives: scored.slice(1, 4).map((x) => ({ market_id: String(x.m.market_id), title: x.m.title })),
  };
}

function ago(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const h = (now - Date.parse(iso)) / 3_600_000;
  if (!isFinite(h) || h < 0) return "";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** The one-or-two sentence answer, decided from the signed record's own fields. */
export function speakSettlement(rec: any, now = Date.now()): string {
  const title = rec.market?.question ? `“${rec.market.question}” ` : "This market ";
  const last = rec.disputes?.length ? rec.disputes[rec.disputes.length - 1].disputed_at : undefined;
  const d = Number(rec.dispute_count ?? 0);
  if (rec.resolved_on_chain) {
    const out = rec.onchain_resolution?.outcome;
    return `${title}has been settled on chain${out ? ` with the outcome ${out}` : ""}${d ? `, after being disputed ${times(d)}` : ""}. Nothing is left to settle.`;
  }
  if (rec.open_dispute && rec.sent_to_uma_vote) {
    return `${title}is disputed and went to a UMA vote; don't treat it as settled yet. It was disputed ${times(d)}${last ? `, most recently ${ago(last, now)}` : ""}.`;
  }
  if (rec.open_dispute) return `${title}has an open dispute, so the result is not final yet${last ? `; the latest dispute was ${ago(last, now)}` : ""}.`;
  if (rec.current_proposal) return `${title}has a proposed result that is still in its challenge window, so it can still be disputed. ${d ? `It has been disputed ${times(d)} before.` : "It has not been disputed so far."}`;
  if (d) return `${title}was disputed ${times(d)} but is not in an open dispute right now; a new result still has to be proposed and settle.`;
  return `${title}has no dispute on record and nothing is flagged right now. The result is not final until it settles on chain.`;
}

export async function checkMarketSettlement(cfg: PredgeConfig, args: { market: string }, now = Date.now()): Promise<ToolResult> {
  const r = await resolveMarket(cfg, args.market);
  if (!r) return { isError: true, text: "I couldn't match that to a market. I can find markets by name when they are in the dispute list; otherwise give me the Polymarket link, slug or market id.", data: { query: args.market, found: false } };
  try {
    const rec = await predge.getSettlementRisk(cfg, r.market);
    const text = speakSettlement(rec, now);
    return {
      text,
      data: {
        resolved: r,
        question: rec.market?.question ?? null, slug: rec.market?.slug ?? null, market_id: rec.market?.market_id ?? r.market,
        risk_level: rec.risk_level, uma_state: rec.uma_state, open_dispute: rec.open_dispute, sent_to_uma_vote: rec.sent_to_uma_vote,
        dispute_count: rec.dispute_count, resolved_on_chain: rec.resolved_on_chain, onchain_resolution: rec.onchain_resolution,
        current_proposal: rec.current_proposal, recommendation: rec.recommendation, checked_at: rec.checked_at,
        record_url: `${cfg.api}/v1/settlement-risk/${r.market}`, signed: Boolean(rec.attestation),
        note: "Information from the UMA oracle state, not financial advice.",
      },
    };
  } catch (e) {
    return apiError(e, "settlement record");
  }
}

export async function activeDisputes(cfg: PredgeConfig, args: { limit?: number; topic?: string }): Promise<ToolResult> {
  try {
    const a = await predge.getActive(cfg);
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 15);
    const topic = args.topic ? tokens(args.topic) : [];
    let list = (a.markets as any[]).filter((m) => m.open_dispute);
    if (topic.length) list = list.filter((m) => { const tt = new Set(tokens(m.title)); return topic.every((t) => tt.has(t)); });
    list.sort((x, y) => String(y.last_disputed_at).localeCompare(String(x.last_disputed_at)));
    const top = list.slice(0, limit).map((m) => ({ market_id: String(m.market_id), title: m.title, status: m.status, dispute_count: m.dispute_count, last_disputed_at: m.last_disputed_at, record_path: m.record_path }));
    const head = topic.length
      ? `${list.length} open dispute${list.length === 1 ? "" : "s"} match “${args.topic}”.`
      : `Right now ${a.open_disputes_now} Polymarket markets have an open dispute, and ${a.in_uma_vote_now} are in a UMA vote.`;
    const body = top.length ? " Latest: " + top.map((m, i) => `${i + 1}, ${m.title.replace(/\?$/, "")}`).join("; ") + "." : "";
    return { text: head + body, data: { open_disputes_now: a.open_disputes_now, in_uma_vote_now: a.in_uma_vote_now, disputed_markets_7d: a.counts?.last_7d?.disputed_markets, generated_at: a.generated_at, matches: list.length, markets: top } };
  } catch (e) {
    return apiError(e, "dispute list");
  }
}

export interface VerifyDeliveryArgs {
  endpoint: string; amount_usd: number; delivery_status: number; delivery_body: string;
  delivery_content_type?: string; expected_content_type?: string; required_fields?: string[]; non_empty_fields?: string[];
  max_latency_ms?: number; latency_ms?: number; expected_sha256?: string; payer?: string; payee?: string; buyer_id?: string; merchant_id?: string;
}

const REASONS: Record<string, string> = {
  status_not_2xx: "the service did not answer with a success status", content_type_mismatch: "the content type was not what was promised",
  empty_body: "the response was empty", invalid_json: "the response was not valid JSON", schema_violation: "the response did not match the promised schema",
  required_field_missing: "a promised field was missing", field_empty: "a promised field was empty", sha256_mismatch: "the content did not match the promised hash",
  latency_exceeded: "it arrived later than promised", evidence_hash_mismatch: "the evidence was inconsistent",
};

export function buildVerdictRequest(a: VerifyDeliveryArgs) {
  const job: Record<string, unknown> = { endpoint: a.endpoint, method: "GET" };
  if (a.expected_content_type) job.expected_content_type = a.expected_content_type;
  if (a.required_fields?.length) job.required_fields = a.required_fields;
  if (a.non_empty_fields?.length) job.non_empty_fields = a.non_empty_fields;
  if (a.max_latency_ms) job.max_latency_ms = a.max_latency_ms;
  if (a.expected_sha256) job.expected_sha256 = a.expected_sha256;
  const delivery: Record<string, unknown> = { status: a.delivery_status, body: a.delivery_body };
  if (a.delivery_content_type) delivery.headers = { "content-type": a.delivery_content_type };
  if (a.latency_ms !== undefined) delivery.latency_ms = a.latency_ms;
  const payment: Record<string, unknown> = { amount_usd: a.amount_usd };
  if (a.payer) payment.payer = a.payer;
  if (a.payee) payment.payee = a.payee;
  const body: Record<string, unknown> = { job, delivery, payment };
  if (a.buyer_id) body.buyer_id = a.buyer_id;
  if (a.merchant_id) body.merchant_id = a.merchant_id;
  return body;
}

export async function verifyDelivery(cfg: PredgeConfig, args: VerifyDeliveryArgs): Promise<ToolResult> {
  if (!cfg.key) return { isError: true, text: "I need a Predge pilot key to request a delivery verdict, and none is configured on this server.", data: { error: "no_pilot_key", hint: "Set PREDGE_KEY." } };
  try {
    const v = await predge.postVerdict(cfg, buildVerdictRequest(args), args.amount_usd >= 1);
    const failed = (v.checks as any[] | undefined)?.filter((c) => c.status === "fail") ?? [];
    let text: string;
    if (v.verdict === "delivered") text = "Verdict: delivered. Every check passed, so the work arrived as promised.";
    else if (v.verdict === "not_delivered") {
      const why = failed.map((c) => REASONS[c.reason_code] ?? c.reason_code).join(", and ");
      text = `Verdict: not delivered${why ? ` because ${why}` : ""}. Predge recommends the seller refund ${Number(v.refund_amount_usd).toFixed(2)} dollars; that is a recommendation, no money moved.`;
    } else text = "Verdict: inconclusive. There wasn't enough evidence to decide.";
    text += " The signed verdict is saved and anyone can verify it.";
    return { text, data: { id: v.id, verdict: v.verdict, reason_codes: v.reason_codes, checks: v.checks, refund_recommended: v.refund_recommended, refund_amount_usd: v.refund_amount_usd, verify_url: v.verify_url, issued_at: v.issued_at, signed: Boolean(v.attestation), note: "Verdict is only as true as the evidence supplied; Predge did not observe the delivery." } };
  } catch (e) {
    if (e instanceof PredgeError && e.status === 402) return { isError: true, text: "Predge asked for payment: the pilot key is outside its free window or not valid for verdicts.", data: { error: "payment_required", status: 402 } };
    return apiError(e, "verdict");
  }
}

export interface VerifyRecordArgs { market?: string; verdict_id?: string; record?: unknown; demo_tamper?: boolean }

export async function verifyRecord(cfg: PredgeConfig, args: VerifyRecordArgs): Promise<ToolResult> {
  try {
    let att: Partial<Attestation> | undefined;
    let source = "supplied record";
    const rec = args.record as any;
    if (rec) att = rec.attestation ?? rec;
    else if (args.verdict_id) { att = (await predge.getVerdict(cfg, args.verdict_id)).attestation; source = `verdict ${args.verdict_id}`; }
    else if (args.market) {
      const r = await resolveMarket(cfg, args.market);
      if (!r) return { isError: true, text: "I couldn't match that to a market to fetch its record.", data: { found: false } };
      att = (await predge.getSettlementRisk(cfg, r.market)).attestation; source = `settlement record for market ${r.market}`;
    } else return { isError: true, text: "Tell me which record to verify: a market, a verdict id, or the record itself.", data: { error: "missing_input" } };
    if (!att) return { isError: true, text: "That response carried no signature to verify.", data: { error: "no_attestation" } };
    if (args.demo_tamper && typeof att.canonical === "string") att = { ...att, canonical: att.canonical.replace(/\d/, (d) => String((Number(d) + 1) % 10)) };
    const keys = await predge.getKeys(cfg);
    const r = verifyAttestation(att, keys);
    const text = {
      authentic: `This record is authentic. The signature checks out against Predge's published key, verified here without trusting the server.`,
      key_revoked: `Warning: ${r.detail}`,
      invalid_signature: `This record failed verification: ${r.detail}`,
      unknown_key: `Careful: ${r.detail}`,
      malformed: r.detail,
    }[r.verdict];
    return { text: args.demo_tamper ? "Demo with one character changed. " + text : text, data: { source, tampered_for_demo: Boolean(args.demo_tamper), ...r, keys_checked: keys.length, key_list: `${cfg.api}/.well-known/predge-keys.json` } };
  } catch (e) {
    return apiError(e, "record");
  }
}

function apiError(e: unknown, what: string): ToolResult {
  if (e instanceof PredgeError) {
    const detail = typeof e.body === "object" && e.body ? (e.body as any).error ?? (e.body as any).message : undefined;
    const text = e.status === 404 || e.status === 422 ? `Predge has no ${what} for that: ${detail ?? "not found"}.`
      : e.status === 429 ? `Predge is rate limiting me. Try again in a minute.` : `Predge couldn't answer the ${what} request (HTTP ${e.status}).`;
    return { isError: true, text, data: { error: detail ?? "api_error", status: e.status, body: e.body } };
  }
  return { isError: true, text: `I couldn't reach Predge for the ${what}.`, data: { error: "network", message: String((e as Error)?.message ?? e) } };
}
