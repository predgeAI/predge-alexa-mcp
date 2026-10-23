import { randomBytes } from "node:crypto";
import * as predge from "./predge.js";
import { PredgeError, type PredgeConfig } from "./predge.js";
import type { Purchase, PurchaseStore, StoredVerdict } from "./store.js";
import { buildVerdictRequest, verifyRecord, type ToolResult } from "./tools.js";

/** Everything the Kept tools need besides their own arguments. */
export interface KeptDeps { cfg: PredgeConfig; store: PurchaseStore; household: string; now?: () => number }

export const HOUSEHOLD_DEFAULT = "household-demo";
const hh = (d: KeptDeps, h?: string) => (h && h.trim()) || d.household || HOUSEHOLD_DEFAULT;
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const human = (f: string) => f.replace(/[_.]+/g, " ");
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs.at(-1));
const the = (merchant: string) => { const m = merchant.trim(); return /^(a|an|the)\s/i.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) : m; };

/** Card payload rendered by the ui://kept/receipt MCP App. Keep it flat and serialisable. */
export interface ReceiptCard {
  state: "recorded" | "delivered" | "not_delivered" | "inconclusive" | "refund_requested" | "list";
  headline: string; detail?: string;
  merchant?: string; item?: string; amount_usd?: number; purchase_id?: string;
  missing?: string[]; refund_amount_usd?: number; signed?: boolean; source?: "predge" | "offline_sample";
  verify_url?: string; verdict_id?: string; sample_label?: string;
  purchases?: { id: string; merchant: string; item: string; amount_usd: number; status: string }[];
  refund_text?: string;
}

const getPath = (o: unknown, path: string): unknown => path.split(".").reduce<any>((a, k) => (a == null ? undefined : a[k]), o);
const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "") && !(Array.isArray(v) && !v.length);

function parseConfirmation(c: unknown): { json?: Record<string, unknown>; text: string } {
  if (c && typeof c === "object") return { json: c as Record<string, unknown>, text: JSON.stringify(c) };
  const text = String(c ?? "");
  try { const j = JSON.parse(text); if (j && typeof j === "object") return { json: j, text }; } catch { /* plain text */ }
  return { text };
}
export const missingFields = (promised: string[], confirmation: unknown): string[] => {
  const { json } = parseConfirmation(confirmation);
  return promised.filter((f) => !json || !present(getPath(json, f)));
};

const view = (p: Purchase) => ({ id: p.id, merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, status: p.status, promised: p.promised, due_by: p.due_by, created_at: p.created_at });

// --- record_purchase --------------------------------------------------------------------------
export interface RecordArgs { merchant: string; item: string; amount_usd: number; promised: string[]; due_by?: string; household?: string }
export async function recordPurchase(d: KeptDeps, a: RecordArgs): Promise<ToolResult> {
  const promised = [...new Set((a.promised ?? []).map((s) => s.trim()).filter(Boolean))];
  if (!promised.length) return { isError: true, text: "I need at least one thing the merchant promised, like a ticket id or a seat, so I can check it later.", data: { error: "no_promised_fields" } };
  const p: Purchase = {
    household: hh(d, a.household), id: "pur_" + randomBytes(5).toString("hex"), merchant: a.merchant, item: a.item, amount_usd: a.amount_usd,
    promised, ...(a.due_by ? { due_by: a.due_by } : {}), created_at: new Date((d.now ?? Date.now)()).toISOString(), status: "recorded",
  };
  await d.store.put(p);
  const card: ReceiptCard = { state: "recorded", headline: "Purchase recorded", detail: `Waiting for ${the(a.merchant)} to confirm ${list(promised.map(human))}.`, merchant: a.merchant, item: a.item, amount_usd: a.amount_usd, purchase_id: p.id };
  return {
    text: `Recorded: ${a.item} from ${a.merchant} for ${money(a.amount_usd)}. I'll check the confirmation for ${list(promised.map(human))}${a.due_by ? ` by ${a.due_by}` : ""}.`,
    data: { purchase: view(p), storage: d.store.kind, card, note: "Kept records the purchase; it never moves money." },
  };
}

// --- check_purchase ---------------------------------------------------------------------------
export interface CheckArgs { purchase_id?: string; confirmation: unknown; household?: string }

function localVerdict(p: Purchase, missing: string[], parsed: boolean): StoredVerdict {
  return { verdict: parsed || missing.length ? (missing.length ? "not_delivered" : "delivered") : "inconclusive", source: "offline_sample", missing, signed: false, checked_at: new Date().toISOString(), ...(missing.length ? { refund_amount_usd: p.amount_usd } : {}) };
}

async function pickPurchase(d: KeptDeps, household: string, id?: string): Promise<Purchase | undefined> {
  if (id) return d.store.get(household, id);
  const all = await d.store.list(household);
  return [...all].reverse().find((p) => p.status === "recorded") ?? all.at(-1);
}

export async function checkPurchase(d: KeptDeps, a: CheckArgs): Promise<ToolResult> {
  const household = hh(d, a.household);
  const p = await pickPurchase(d, household, a.purchase_id);
  if (!p) return { isError: true, text: a.purchase_id ? "I don't have a purchase with that id." : "I haven't recorded any purchases yet.", data: { error: "not_found" } };
  if (a.confirmation === undefined || a.confirmation === null || a.confirmation === "") return { isError: true, text: `I need the confirmation ${the(p.merchant)} sent to check it.`, data: { error: "missing_confirmation", purchase: view(p) } };
  const parsed = parseConfirmation(a.confirmation);
  const missing = missingFields(p.promised, a.confirmation);
  let v: StoredVerdict;
  let apiNote: string | undefined;

  if (d.cfg.key) {
    try {
      const req = buildVerdictRequest({
        endpoint: `https://orders.kept.invalid/${p.id}`, amount_usd: p.amount_usd, delivery_status: 200, delivery_body: parsed.text,
        delivery_content_type: "application/json", expected_content_type: "application/json", required_fields: p.promised, non_empty_fields: p.promised,
        merchant_id: p.merchant.slice(0, 60), buyer_id: p.household.slice(0, 60),
      });
      const r = await predge.postVerdict(d.cfg, req, p.amount_usd >= 1);
      v = {
        id: r.id, verdict: r.verdict, source: "predge", missing, signed: Boolean(r.attestation), checked_at: r.issued_at ?? new Date().toISOString(),
        verify_url: r.verify_url, attestation: r.attestation,
        ...(r.verdict === "not_delivered" ? { refund_amount_usd: Number(r.refund_amount_usd ?? p.amount_usd) || p.amount_usd } : {}),
      };
    } catch (e) {
      if (e instanceof PredgeError && e.status === 402) return { isError: true, text: "Predge asked for payment: the pilot key is outside its free window or not valid for verdicts.", data: { error: "payment_required", status: 402 } };
      apiNote = e instanceof PredgeError ? `Predge answered HTTP ${e.status}` : "Predge could not be reached";
      v = localVerdict(p, missing, Boolean(parsed.json));
    }
  } else {
    apiNote = "no PREDGE_KEY on this server";
    v = localVerdict(p, missing, Boolean(parsed.json));
  }

  const next: Purchase = { ...p, verdict: v, status: v.verdict };
  await d.store.put(next);

  const who = the(p.merchant);
  let sentence: string;
  if (v.verdict === "delivered") sentence = `${who} confirmed your order and every promised detail is there: ${list(p.promised.map(human))}. Delivered.`;
  else if (v.verdict === "not_delivered") {
    const gap = !parsed.json ? "sent a confirmation I couldn't read as an order" : missing.length ? `sent no ${list(missing.map(human))}` : "did not deliver what was promised";
    sentence = `${who} confirmed the order but ${gap}. Not delivered; I'd ask for a refund of ${money(v.refund_amount_usd ?? p.amount_usd)}.`;
  } else sentence = `There isn't enough in ${who}'s confirmation to decide. Inconclusive.`;
  const live = v.source === "predge";
  const text = live ? `${sentence} Signed by Predge; anyone can verify the receipt.` : `Offline sample check, not a signed Predge verdict (${apiNote}). ${sentence}`;
  const card: ReceiptCard = {
    state: v.verdict, headline: v.verdict === "delivered" ? "DELIVERED" : v.verdict === "not_delivered" ? "NOT DELIVERED" : "INCONCLUSIVE", detail: sentence,
    merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, purchase_id: p.id, missing, signed: v.signed, source: v.source,
    ...(v.refund_amount_usd !== undefined ? { refund_amount_usd: v.refund_amount_usd } : {}), ...(v.verify_url ? { verify_url: v.verify_url } : {}), ...(v.id ? { verdict_id: v.id } : {}),
    ...(live ? {} : { sample_label: "Offline sample check. Not a signed Predge verdict." }),
  };
  return {
    text,
    data: {
      purchase: view(next), verdict: v.verdict, source: v.source, signed: v.signed, verdict_id: v.id ?? null, verify_url: v.verify_url ?? null,
      missing_fields: missing, refund_recommended: v.verdict === "not_delivered", refund_amount_usd: v.refund_amount_usd ?? null, storage: d.store.kind, card,
      note: live ? "Verdict is only as true as the confirmation supplied; Predge did not observe the delivery. No money moved." : `Offline sample path: ${apiNote}. Set PREDGE_KEY for a signed verdict. No money moved.`,
    },
  };
}

// --- list_purchases ---------------------------------------------------------------------------
export async function listPurchases(d: KeptDeps, a: { household?: string; days?: number; only_open?: boolean }): Promise<ToolResult> {
  const household = hh(d, a.household);
  const now = (d.now ?? Date.now)();
  let all = await d.store.list(household);
  if (a.days) all = all.filter((p) => now - Date.parse(p.created_at) <= a.days! * 86_400_000);
  const open = (p: Purchase) => p.status === "recorded" || p.status === "not_delivered" || p.status === "inconclusive";
  const shown = a.only_open ? all.filter(open) : all;
  const label: Record<string, string> = { recorded: "waiting for confirmation", delivered: "delivered", not_delivered: "not delivered", inconclusive: "inconclusive", refund_requested: "refund requested" };
  const counts = (s: string) => all.filter((p) => p.status === s).length;
  const parts = ["delivered", "not_delivered", "refund_requested", "recorded", "inconclusive"].filter(counts).map((s) => `${counts(s)} ${label[s]}`);
  const text = !shown.length ? (a.only_open ? "Nothing is open. Everything I bought for you is settled." : "I haven't bought anything for you yet.")
    : `I recorded ${all.length} purchase${all.length === 1 ? "" : "s"}${a.days ? ` in the last ${a.days} days` : ""}: ${parts.join(", ")}. ` + shown.map((p) => `${p.item} from ${p.merchant}, ${money(p.amount_usd)}, ${label[p.status]}`).join("; ") + ".";
  const card: ReceiptCard = { state: "list", headline: "What I bought for you", detail: parts.join(" · ") || "Nothing yet", purchases: shown.map((p) => ({ id: p.id, merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, status: p.status })) };
  return { text, data: { household, count: all.length, open: all.filter(open).length, purchases: shown.map(view), storage: d.store.kind, card } };
}

// --- draft_refund_request ---------------------------------------------------------------------
export function refundDraft(p: Purchase): string {
  const v = p.verdict!;
  const amt = money(v.refund_amount_usd ?? p.amount_usd);
  const gap = v.missing.length ? `The confirmation did not include: ${list(v.missing.map(human))}.` : "The confirmation did not match what was promised.";
  const evidence = v.source === "predge" && v.verify_url ? `An independent delivery check (signed, verifiable offline) found the order was not delivered: ${v.verify_url}` : "An automated check of your confirmation against the order found it incomplete. (Draft built from an offline sample check, not a signed verdict.)";
  return [
    `Subject: Refund request, order ${p.id}`, "",
    `Hello,`, "",
    `On ${p.created_at.slice(0, 10)} an assistant ordered "${p.item}" from you on my behalf for ${money(p.amount_usd)}. ${gap}`, "",
    evidence, "",
    `Please refund ${amt}, or send the missing details if the order can still be fulfilled.`, "",
    `Thank you.`,
  ].join("\n");
}

export type Confirm = (message: string) => Promise<"accept" | "decline" | "unsupported">;

export async function draftRefundRequest(d: KeptDeps, a: { purchase_id?: string; household?: string; confirmed?: boolean }, confirm: Confirm): Promise<ToolResult> {
  const household = hh(d, a.household);
  const all = await d.store.list(household);
  const p = a.purchase_id ? all.find((x) => x.id === a.purchase_id) : [...all].reverse().find((x) => x.status === "not_delivered");
  if (!p) return { isError: true, text: a.purchase_id ? "I don't have a purchase with that id." : "No purchase is marked not delivered, so there is nothing to ask a refund for.", data: { error: "not_found" } };
  if (p.status === "refund_requested" && p.refund) return { text: "A refund request for this purchase is already drafted.", data: { purchase: view(p), refund_text: p.refund.text, already_drafted: true, card: { state: "refund_requested", headline: "REFUND DRAFTED", merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, purchase_id: p.id, refund_text: p.refund.text } satisfies ReceiptCard } };
  if (p.status !== "not_delivered" || !p.verdict) return { isError: true, text: p.status === "delivered" ? "That purchase was delivered, so there is nothing to refund." : "Check that purchase first; I only draft a refund after a not-delivered verdict.", data: { error: "not_refundable", status: p.status } };

  const amt = money(p.verdict.refund_amount_usd ?? p.amount_usd);
  const q = `Draft a refund request to ${p.merchant} for ${amt}, with the verdict attached? Nothing is sent and no money moves.`;
  const ans = await confirm(q);
  if (ans === "decline") return { text: "Okay, I won't draft anything. The purchase stays marked not delivered.", data: { drafted: false, human_decision: "declined", purchase: view(p) } };
  if (ans === "unsupported" && a.confirmed !== true) {
    return { text: `${q} Say yes and I'll draft it.`, data: { drafted: false, needs_confirmation: true, question: q, purchase: view(p), note: "This client cannot ask the user directly. Ask the human, then call again with confirmed=true only after a spoken yes." } };
  }
  const text = refundDraft(p);
  const next: Purchase = { ...p, status: "refund_requested", refund: { drafted_at: new Date((d.now ?? Date.now)()).toISOString(), text } };
  await d.store.put(next);
  const card: ReceiptCard = { state: "refund_requested", headline: "REFUND REQUEST DRAFTED", detail: "Draft only. Nothing was sent and no money moved.", merchant: p.merchant, item: p.item, amount_usd: p.amount_usd, purchase_id: p.id, refund_amount_usd: p.verdict.refund_amount_usd ?? p.amount_usd, signed: p.verdict.signed, source: p.verdict.source, ...(p.verdict.verify_url ? { verify_url: p.verdict.verify_url } : {}), refund_text: text };
  return { text: `Done. I drafted the refund request for ${amt} with the verdict attached. It is only a draft: nothing was sent and no money moved.`, data: { drafted: true, human_decision: ans === "accept" ? "accepted" : "confirmed_by_flag", refund_text: text, purchase: view(next), card, storage: d.store.kind } };
}

// --- verify_receipt ---------------------------------------------------------------------------
export interface VerifyReceiptArgs { purchase_id?: string; verdict_id?: string; receipt?: unknown; household?: string; demo_tamper?: boolean }
export async function verifyReceipt(d: KeptDeps, a: VerifyReceiptArgs): Promise<ToolResult> {
  let args: { verdict_id?: string; record?: unknown; demo_tamper?: boolean } = { demo_tamper: a.demo_tamper };
  if (a.receipt) args.record = a.receipt;
  else if (a.verdict_id) args.verdict_id = a.verdict_id;
  else {
    const household = hh(d, a.household);
    const all = await d.store.list(household);
    const p = a.purchase_id ? all.find((x) => x.id === a.purchase_id) : [...all].reverse().find((x) => x.verdict?.signed) ?? [...all].reverse().find((x) => x.verdict);
    if (!p?.verdict) return { isError: true, text: "I have no checked purchase to verify a receipt for. Check a purchase first.", data: { error: "no_receipt" } };
    if (!p.verdict.signed || p.verdict.source !== "predge") return { isError: true, text: "That check was an offline sample, so there is no signed receipt to verify.", data: { error: "unsigned_sample", purchase: view(p) } };
    if (p.verdict.attestation) args.record = p.verdict.attestation; else args.verdict_id = p.verdict.id;
  }
  const r = await verifyRecord(d.cfg, args);
  const authentic = (r.data as any).verdict === "authentic";
  const card: ReceiptCard = { state: authentic ? "delivered" : "not_delivered", headline: authentic ? "RECEIPT AUTHENTIC" : "RECEIPT NOT VALID", detail: r.text, signed: authentic };
  return { ...r, data: { ...r.data, card } };
}
