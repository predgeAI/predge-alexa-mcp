import { describe, expect, it } from "vitest";
import { checkPurchase, draftRefundRequest, listPurchases, missingFields, recordPurchase, verifyReceipt, type KeptDeps } from "../src/kept.js";
import { MemoryStore } from "../src/store.js";
import { cfgOf, json, mockFetch, signedRecord } from "./helpers.js";

const TICKETS = { merchant: "a ticketing service", item: "two tickets, Saturday 7pm", amount_usd: 32, promised: ["ticket_id", "seat", "showtime"] };
const NO_SEAT = { status: "confirmed", ticket_id: "SAMPLE-1", showtime: "Sat 19:00" };
const FULL = { status: "confirmed", ticket_id: "SAMPLE-1", seat: "F7", showtime: "Sat 19:00" };
const deps = (f: typeof fetch, key?: string): KeptDeps => ({ cfg: cfgOf(f, key), store: new MemoryStore(), household: "h1" });
const noNet = () => mockFetch({}).f;
const verdictRoute = (verdict: string, extra: Record<string, unknown> = {}) => ({
  "POST /v1/verdicts": () => json({ id: "vrd_k1", verdict, reason_codes: [], checks: [], refund_recommended: verdict === "not_delivered", refund_amount_usd: "32.000000", verify_url: "https://api.predge.io/v1/verdicts/vrd_k1", issued_at: "2026-10-23T10:00:00Z", attestation: { canonical: "{}", signature: "00", public_key: "00" }, ...extra }),
  "POST /v1/verdicts/large": () => json({ id: "vrd_k1", verdict, reason_codes: [], checks: [], refund_recommended: verdict === "not_delivered", refund_amount_usd: "32.000000", verify_url: "https://api.predge.io/v1/verdicts/vrd_k1", issued_at: "2026-10-23T10:00:00Z", attestation: { canonical: "{}", signature: "00", public_key: "00" }, ...extra }),
});

describe("record_purchase", () => {
  it("stores the purchase under the household and says what it will check", async () => {
    const d = deps(noNet());
    const r = await recordPurchase(d, TICKETS);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("ticket id, seat and showtime");
    expect((r.data as any).storage).toBe("memory");
    const rows = await d.store.list("h1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ household: "h1", status: "recorded", amount_usd: 32 });
    expect(rows[0].id).toMatch(/^pur_/);
    expect((r.data as any).card.state).toBe("recorded");
  });
  it("refuses a purchase with nothing to check", async () => {
    const r = await recordPurchase(deps(noNet()), { ...TICKETS, promised: [" "] });
    expect(r.isError).toBe(true);
  });
  it("keeps households apart", async () => {
    const d = deps(noNet());
    await recordPurchase(d, TICKETS);
    await recordPurchase(d, { ...TICKETS, household: "other" });
    expect(await d.store.list("h1")).toHaveLength(1);
    expect(await d.store.list("other")).toHaveLength(1);
  });
});

describe("missingFields", () => {
  it("handles dot paths, empties and non-JSON text", () => {
    expect(missingFields(["a.b", "c", "d"], { a: { b: 1 }, c: "  " })).toEqual(["c", "d"]);
    expect(missingFields(["seat"], "confirmed, enjoy the show")).toEqual(["seat"]);
    expect(missingFields(["seat"], JSON.stringify({ seat: "F7" }))).toEqual([]);
  });
});

describe("check_purchase", () => {
  it("with a key: builds the job spec from promised, posts to the verdict API, and speaks a human sentence", async () => {
    const { f, calls } = mockFetch(verdictRoute("not_delivered"));
    const d = deps(f, "pdg_test");
    await recordPurchase(d, TICKETS);
    const r = await checkPurchase(d, { confirmation: NO_SEAT });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.predge.io/v1/verdicts/large");
    expect((calls[0].init!.headers as any)["x-predge-key"]).toBe("pdg_test");
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.job.required_fields).toEqual(["ticket_id", "seat", "showtime"]);
    expect(body.job.expected_content_type).toBe("application/json");
    expect(JSON.parse(body.delivery.body)).toEqual(NO_SEAT);
    expect(body.payment.amount_usd).toBe(32);
    expect(r.text).toBe("A ticketing service confirmed the order but sent no seat. Not delivered; I'd ask for a refund of $32. Signed by Predge; anyone can verify the receipt.");
    expect(r.data).toMatchObject({ verdict: "not_delivered", source: "predge", signed: true, verdict_id: "vrd_k1", missing_fields: ["seat"], refund_amount_usd: 32 });
    expect((await d.store.list("h1"))[0]).toMatchObject({ status: "not_delivered" });
    expect((r.data as any).card).toMatchObject({ state: "not_delivered", headline: "NOT DELIVERED", missing: ["seat"] });
  });
  it("uses the standard tier under $1 and reports delivered", async () => {
    const { f, calls } = mockFetch(verdictRoute("delivered"));
    const d = deps(f, "k");
    await recordPurchase(d, { ...TICKETS, amount_usd: 0.5 });
    const r = await checkPurchase(d, { confirmation: JSON.stringify(FULL) });
    expect(calls[0].url).toBe("https://api.predge.io/v1/verdicts");
    expect(r.text).toContain("Delivered.");
    expect((await d.store.list("h1"))[0].status).toBe("delivered");
  });
  it("without PREDGE_KEY: clearly labelled offline sample path, no network, unsigned", async () => {
    const { f, calls } = mockFetch({});
    const d = deps(f);
    await recordPurchase(d, TICKETS);
    const r = await checkPurchase(d, { confirmation: NO_SEAT });
    expect(calls).toHaveLength(0);
    expect(r.text).toMatch(/^Offline sample check, not a signed Predge verdict/);
    expect(r.text).toContain("sent no seat");
    expect(r.data).toMatchObject({ source: "offline_sample", signed: false, verdict: "not_delivered" });
    expect((r.data as any).card.sample_label).toContain("Not a signed Predge verdict");
  });
  it("falls back to the labelled sample path when the API is down", async () => {
    const { f } = mockFetch({ "POST /v1/verdicts/large": () => json({ error: "boom" }, 500) });
    const d = deps(f, "k");
    await recordPurchase(d, TICKETS);
    const r = await checkPurchase(d, { confirmation: NO_SEAT });
    expect(r.text).toContain("Offline sample check");
    expect(r.text).toContain("HTTP 500");
  });
  it("explains a 402 and leaves the purchase unchanged", async () => {
    const { f } = mockFetch({ "POST /v1/verdicts/large": () => json({ x402Version: 1 }, 402) });
    const d = deps(f, "k");
    await recordPurchase(d, TICKETS);
    const r = await checkPurchase(d, { confirmation: NO_SEAT });
    expect(r.isError).toBe(true);
    expect((await d.store.list("h1"))[0].status).toBe("recorded");
  });
  it("defaults to the latest unchecked purchase and needs a confirmation", async () => {
    const d = deps(noNet());
    expect((await checkPurchase(d, { confirmation: FULL })).isError).toBe(true);
    await recordPurchase(d, TICKETS);
    await recordPurchase(d, { merchant: "a home-cleaning service", item: "cleaning", amount_usd: 85, promised: ["booking_id"] });
    expect((await checkPurchase(d, { confirmation: "" })).data).toMatchObject({ error: "missing_confirmation" });
    const r = await checkPurchase(d, { confirmation: { booking_id: "B1" } });
    expect(r.text).toContain("A home-cleaning service");
    expect(r.text).toContain("Delivered");
  });
  it("treats a non-JSON confirmation as not delivered", async () => {
    const d = deps(noNet());
    await recordPurchase(d, TICKETS);
    const r = await checkPurchase(d, { confirmation: "thanks for your order!" });
    expect(r.data).toMatchObject({ verdict: "not_delivered" });
    expect(r.text).toContain("couldn't read");
  });
});

describe("list_purchases", () => {
  it("summarises statuses across sessions", async () => {
    const d = deps(noNet());
    expect((await listPurchases(d, {})).text).toContain("haven't bought anything");
    await recordPurchase(d, TICKETS);
    await recordPurchase(d, { merchant: "a home-cleaning service", item: "cleaning", amount_usd: 85, promised: ["booking_id"] });
    await checkPurchase(d, { purchase_id: (await d.store.list("h1"))[1].id, confirmation: { booking_id: "B" } });
    const r = await listPurchases(d, {});
    expect(r.text).toContain("1 delivered, 1 waiting for confirmation");
    expect(r.data).toMatchObject({ count: 2, open: 1 });
    const open = await listPurchases(d, { only_open: true });
    expect((open.data as any).purchases).toHaveLength(1);
  });
  it("honours the days window", async () => {
    const d = deps(noNet());
    await recordPurchase({ ...d, now: () => Date.parse("2026-10-01T00:00:00Z") }, TICKETS);
    const r = await listPurchases({ ...d, now: () => Date.parse("2026-10-23T00:00:00Z") }, { days: 7 });
    expect((r.data as any).count).toBe(0);
  });
});

describe("draft_refund_request", () => {
  async function failed() {
    const d = deps(mockFetch(verdictRoute("not_delivered")).f, "k");
    await recordPurchase(d, TICKETS);
    await checkPurchase(d, { confirmation: NO_SEAT });
    return d;
  }
  it("drafts after the human accepts, links the verdict, and says nothing was sent", async () => {
    const d = await failed();
    let asked = "";
    const r = await draftRefundRequest(d, {}, async (m) => { asked = m; return "accept"; });
    expect(asked).toContain("no money moves");
    expect((r.data as any).drafted).toBe(true);
    expect(r.text).toContain("no money moved");
    expect((r.data as any).refund_text).toContain("https://api.predge.io/v1/verdicts/vrd_k1");
    expect((r.data as any).refund_text).toContain("seat");
    expect((await d.store.list("h1"))[0].status).toBe("refund_requested");
  });
  it("drafts nothing when the human says no", async () => {
    const d = await failed();
    const r = await draftRefundRequest(d, {}, async () => "decline");
    expect((r.data as any).drafted).toBe(false);
    expect((await d.store.list("h1"))[0].status).toBe("not_delivered");
  });
  it("without elicitation support it asks and drafts only on confirmed=true", async () => {
    const d = await failed();
    const ask = await draftRefundRequest(d, {}, async () => "unsupported");
    expect((ask.data as any).needs_confirmation).toBe(true);
    expect((await d.store.list("h1"))[0].status).toBe("not_delivered");
    const go = await draftRefundRequest(d, { confirmed: true }, async () => "unsupported");
    expect((go.data as any).drafted).toBe(true);
  });
  it("refuses delivered or unchecked purchases", async () => {
    const d = deps(noNet());
    await recordPurchase(d, TICKETS);
    expect((await draftRefundRequest(d, {}, async () => "accept")).isError).toBe(true);
    await checkPurchase(d, { confirmation: FULL });
    const r = await draftRefundRequest(d, { purchase_id: (await d.store.list("h1"))[0].id }, async () => "accept");
    expect(r.text).toContain("delivered");
  });
  it("is idempotent once drafted", async () => {
    const d = await failed();
    await draftRefundRequest(d, {}, async () => "accept");
    const again = await draftRefundRequest(d, { purchase_id: (await d.store.list("h1"))[0].id }, async () => { throw new Error("must not ask twice"); });
    expect((again.data as any).already_drafted).toBe(true);
  });
  it("labels a draft built from an offline sample", async () => {
    const d = deps(noNet());
    await recordPurchase(d, TICKETS);
    await checkPurchase(d, { confirmation: NO_SEAT });
    const r = await draftRefundRequest(d, {}, async () => "accept");
    expect((r.data as any).refund_text).toContain("offline sample");
  });
});

describe("verify_receipt", () => {
  const { public_key, att } = signedRecord({ verdict: "not_delivered", amount_usd: 32 });
  const keys = { keys: [{ kid: "testkid", public_key, status: "active", active: true }] };
  it("verifies the latest signed receipt from the journal offline, and catches a tampered one", async () => {
    const { f } = mockFetch({ ...verdictRoute("not_delivered", { attestation: att }), "GET /.well-known/predge-keys.json": () => json(keys) });
    const d = deps(f, "k");
    await recordPurchase(d, TICKETS);
    await checkPurchase(d, { confirmation: NO_SEAT });
    const ok = await verifyReceipt(d, {});
    expect(ok.data).toMatchObject({ verdict: "authentic" });
    expect((ok.data as any).card.headline).toBe("RECEIPT AUTHENTIC");
    const bad = await verifyReceipt(d, { demo_tamper: true });
    expect(bad.data).toMatchObject({ verdict: "invalid_signature" });
    expect((bad.data as any).card.headline).toBe("RECEIPT NOT VALID");
  });
  it("says there is nothing to verify after an offline sample check", async () => {
    const d = deps(noNet());
    await recordPurchase(d, TICKETS);
    await checkPurchase(d, { confirmation: NO_SEAT });
    const r = await verifyReceipt(d, {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("offline sample");
  });
  it("verifies a receipt passed inline", async () => {
    const { f } = mockFetch({ "GET /.well-known/predge-keys.json": () => json(keys) });
    expect((await verifyReceipt(deps(f), { receipt: { attestation: att } })).data).toMatchObject({ verdict: "authentic" });
  });
});
