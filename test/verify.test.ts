import { describe, expect, it } from "vitest";
import { canonicalize, verifyAttestation } from "../src/verify.js";
import { signedRecord } from "./helpers.js";

describe("canonicalize", () => {
  it("sorts keys at every level without whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("verifyAttestation", () => {
  const { public_key, att } = signedRecord();
  const active = [{ kid: "testkid", public_key, status: "active", active: true }];

  it("accepts a genuine record under an active key", () => {
    const r = verifyAttestation(att, active);
    expect(r.verdict).toBe("authentic");
    expect(r.payload_matches_canonical).toBe(true);
  });
  it("accepts a record under a retired key", () => {
    expect(verifyAttestation(att, [{ kid: "testkid", public_key, status: "retired", active: false }]).verdict).toBe("authentic");
  });
  it("rejects a record with one changed character", () => {
    const bad = { ...att, canonical: att.canonical.replace("caution", "cautiom") };
    expect(verifyAttestation(bad, active).verdict).toBe("invalid_signature");
  });
  it("rejects when the readable payload was edited but the canonical text was not", () => {
    const bad = { ...att, payload: { market: "m1", risk_level: "ok" } };
    const r = verifyAttestation(bad, active);
    expect(r.verdict).toBe("invalid_signature");
    expect(r.signature_valid).toBe(true);
    expect(r.payload_matches_canonical).toBe(false);
  });
  it("flags a revoked key even though the signature is valid", () => {
    const r = verifyAttestation(att, [{ kid: "testkid", public_key, status: "revoked", active: false, revoked_at: "2026-10-21T00:00:00.000Z", reason: "leak" }]);
    expect(r.verdict).toBe("key_revoked");
    expect(r.signature_valid).toBe(true);
    expect(r.detail).toContain("2026-10-21");
  });
  it("flags a valid signature from a key that is not published", () => {
    expect(verifyAttestation(att, []).verdict).toBe("unknown_key");
  });
  it("handles malformed input", () => {
    expect(verifyAttestation({ canonical: "x" }, active).verdict).toBe("malformed");
    expect(verifyAttestation({ canonical: "x", signature: "zz", public_key: "yy" }, active).verdict).toBe("invalid_signature");
  });
});
