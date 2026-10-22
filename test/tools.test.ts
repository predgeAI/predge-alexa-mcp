import { describe, expect, it } from "vitest";
import { activeDisputes, buildVerdictRequest, checkMarketSettlement, resolveMarket, speakSettlement, verifyDelivery, verifyRecord } from "../src/tools.js";
import { ACTIVE, DISPUTED_RECORD, cfgOf, json, mockFetch, signedRecord } from "./helpers.js";

const NOW = Date.parse("2026-10-22T22:00:00Z");

describe("resolveMarket", () => {
  const { f, calls } = mockFetch({ "GET /v1/settlement-risk/active": () => json(ACTIVE) });
  const cfg = cfgOf(f);
  it("passes ids, condition ids and slugs through without a network call", async () => {
    expect((await resolveMarket(cfg, "4118937"))?.via).toBe("id");
    expect((await resolveMarket(cfg, "0x" + "ab".repeat(32)))?.via).toBe("id");
    expect((await resolveMarket(cfg, "russia-ukraine-peace-talks-by-october-31-2026"))?.via).toBe("slug");
    expect(calls.length).toBe(0);
  });
  it("extracts the slug from a Polymarket URL", async () => {
    const r = await resolveMarket(cfg, "https://polymarket.com/event/some-event/some-market-slug");
    expect(r).toMatchObject({ market: "some-market-slug", via: "url" });
  });
  it("matches a spoken name against the dispute list, ignoring filler words", async () => {
    const r = await resolveMarket(cfg, "Alexa, is the Russia-Ukraine peace talks market safe to cash out?");
    expect(r).toMatchObject({ market: "1", via: "title_search" });
  });
  it("returns null when nothing matches", async () => {
    expect(await resolveMarket(cfg, "will the moon be made of cheese")).toBeNull();
  });
});

describe("speakSettlement", () => {
  it("says the market is disputed and went to a UMA vote", () => {
    const s = speakSettlement(DISPUTED_RECORD, NOW);
    expect(s).toContain("disputed and went to a UMA vote; don't treat it as settled yet");
    expect(s).toContain("twice");
  });
  it("reports on-chain resolution", () => {
    expect(speakSettlement({ ...DISPUTED_RECORD, resolved_on_chain: true, open_dispute: false, onchain_resolution: { outcome: "No" } }, NOW)).toContain("settled on chain with the outcome No");
  });
  it("reports a proposal in its challenge window", () => {
    expect(speakSettlement({ ...DISPUTED_RECORD, open_dispute: false, sent_to_uma_vote: false, dispute_count: 0, disputes: [], current_proposal: { x: 1 } }, NOW)).toContain("challenge window");
  });
  it("reports a clean market without promising finality", () => {
    const s = speakSettlement({ market: {}, dispute_count: 0, disputes: [] }, NOW);
    expect(s).toContain("no dispute on record");
    expect(s).toContain("not final until it settles");
  });
});

describe("check_market_settlement", () => {
  it("resolves a name, calls the free record route and returns speakable text plus data", async () => {
    const { f, calls } = mockFetch({
      "GET /v1/settlement-risk/active": () => json(ACTIVE),
      "GET /v1/settlement-risk/1": () => json(DISPUTED_RECORD),
    });
    const r = await checkMarketSettlement(cfgOf(f), { market: "Russia Ukraine peace talks" }, NOW);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("UMA vote");
    expect(r.data).toMatchObject({ market_id: "1", risk_level: "caution", sent_to_uma_vote: true, signed: true });
    expect(calls.map((c) => c.url)).toEqual(["https://api.predge.io/v1/settlement-risk/active", "https://api.predge.io/v1/settlement-risk/1"]);
  });
  it("turns an API 422 into a spoken error", async () => {
    const { f } = mockFetch({ "GET /v1/settlement-risk/": () => json({ error: "unsupported_protocol_v2" }, 422) });
    const r = await checkMarketSettlement(cfgOf(f), { market: "123456" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("unsupported_protocol_v2");
  });
  it("asks for a link when the name is unknown", async () => {
    const { f } = mockFetch({ "GET /v1/settlement-risk/active": () => json(ACTIVE) });
    const r = await checkMarketSettlement(cfgOf(f), { market: "purple monkey dishwasher" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("link");
  });
});

describe("active_disputes", () => {
  const { f } = mockFetch({ "GET /v1/settlement-risk/active": () => json(ACTIVE) });
  it("lists only open disputes, newest first", async () => {
    const r = await activeDisputes(cfgOf(f), { limit: 5 });
    const ids = (r.data.markets as any[]).map((m) => m.market_id);
    expect(ids).toEqual(["2", "1"]);
    expect(r.text).toContain("2 Polymarket markets have an open dispute");
  });
  it("filters by topic", async () => {
    const r = await activeDisputes(cfgOf(f), { topic: "ethereum" });
    expect((r.data.markets as any[]).length).toBe(1);
    expect(r.text).toContain("match");
  });
});

describe("verify_delivery", () => {
  const args = { endpoint: "https://api.example.com/v1/report", amount_usd: 0.25, delivery_status: 502, delivery_body: "", expected_content_type: "application/json", required_fields: ["rows"] };
  it("builds the documented request body", () => {
    expect(buildVerdictRequest(args)).toEqual({
      job: { endpoint: args.endpoint, method: "GET", expected_content_type: "application/json", required_fields: ["rows"] },
      delivery: { status: 502, body: "" }, payment: { amount_usd: 0.25 },
    });
  });
  it("refuses politely without a pilot key and makes no request", async () => {
    const { f, calls } = mockFetch({});
    const r = await verifyDelivery(cfgOf(f), args);
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe("no_pilot_key");
    expect(calls.length).toBe(0);
  });
  it("posts with x-predge-key to the standard tier and explains a not_delivered verdict", async () => {
    const { f, calls } = mockFetch({
      "POST /v1/verdicts": () => json({ id: "vrd_x", verdict: "not_delivered", reason_codes: ["status_not_2xx"], checks: [{ id: "status_2xx", status: "fail", reason_code: "status_not_2xx" }], refund_recommended: true, refund_amount_usd: "0.250000", verify_url: "https://api.predge.io/v1/verdicts/vrd_x", attestation: {} }),
    });
    const r = await verifyDelivery(cfgOf(f, "pdg_pilot_test"), args);
    expect(calls[0].url).toBe("https://api.predge.io/v1/verdicts");
    expect((calls[0].init!.headers as any)["x-predge-key"]).toBe("pdg_pilot_test");
    expect(r.text).toContain("not delivered");
    expect(r.text).toContain("did not answer with a success status");
    expect(r.text).toContain("0.25 dollars");
    expect(r.text).toContain("recommendation");
    expect(r.data).toMatchObject({ verdict: "not_delivered", verify_url: "https://api.predge.io/v1/verdicts/vrd_x" });
  });
  it("uses the large tier at $1 or more and reports delivered", async () => {
    const { f, calls } = mockFetch({ "POST /v1/verdicts/large": () => json({ id: "vrd_y", verdict: "delivered", checks: [], verify_url: "u" }) });
    const r = await verifyDelivery(cfgOf(f, "k"), { ...args, amount_usd: 2, delivery_status: 200, delivery_body: "{}" });
    expect(calls[0].url).toContain("/v1/verdicts/large");
    expect(r.text).toContain("Verdict: delivered");
  });
  it("explains a 402", async () => {
    const { f } = mockFetch({ "POST /v1/verdicts": () => json({ x402Version: 1 }, 402) });
    const r = await verifyDelivery(cfgOf(f, "k"), args);
    expect(r.isError).toBe(true);
    expect(r.data.status).toBe(402);
  });
});

describe("verify_record", () => {
  const { public_key, att } = signedRecord();
  const keys = { keys: [{ kid: "testkid", public_key, status: "active", active: true }, { kid: "old", public_key: "11".repeat(32), status: "revoked", active: false }] };
  it("verifies a market's record offline against the key list", async () => {
    const { f } = mockFetch({
      "GET /v1/settlement-risk/active": () => json(ACTIVE),
      "GET /v1/settlement-risk/1": () => json({ attestation: att }),
      "GET /.well-known/predge-keys.json": () => json(keys),
    });
    const r = await verifyRecord(cfgOf(f), { market: "1" });
    expect(r.data.verdict).toBe("authentic");
    expect(r.text).toContain("authentic");
  });
  it("catches tampering in demo mode", async () => {
    const { f } = mockFetch({ "GET /v1/verdicts/vrd_a": () => json({ attestation: att }), "GET /.well-known/predge-keys.json": () => json(keys) });
    const r = await verifyRecord(cfgOf(f), { verdict_id: "vrd_a", demo_tamper: true });
    expect(r.data.verdict).toBe("invalid_signature");
    expect(r.text).toContain("failed verification");
  });
  it("accepts the record inline and reports a revoked key", async () => {
    const rev = { keys: [{ kid: "testkid", public_key, status: "revoked", active: false, revoked_at: "2026-10-21T00:00:00.000Z", reason: "breach" }] };
    const { f } = mockFetch({ "GET /.well-known/predge-keys.json": () => json(rev) });
    const r = await verifyRecord(cfgOf(f), { record: { attestation: att } });
    expect(r.data.verdict).toBe("key_revoked");
    expect(r.text).toContain("Do not trust");
  });
  it("needs an input", async () => {
    const r = await verifyRecord(cfgOf(mockFetch({}).f), {});
    expect(r.isError).toBe(true);
  });
});
