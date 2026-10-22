import { createPublicKey, verify as edVerify } from "node:crypto";

/** Canonical JSON as used by predge-attest-v1: keys sorted at every level, no whitespace. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
}

// DER prefix of an ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function ed25519Verify(canonical: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.from(canonical, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export interface KeyEntry { kid: string; public_key: string; status?: string; active?: boolean; revoked_at?: string; reason?: string; role?: string }
export interface Attestation { canonical: string; signature: string; public_key: string; kid?: string; kind?: string; payload?: unknown }

export type RecordVerdict = "authentic" | "key_revoked" | "invalid_signature" | "unknown_key" | "malformed";

export interface VerifyResult {
  verdict: RecordVerdict;
  signature_valid: boolean;
  payload_matches_canonical: boolean | null;
  kid: string | null;
  key_status: string | null;
  kind: string | null;
  detail: string;
}

/** Offline check: the only network input is the published key list the caller passes in. */
export function verifyAttestation(att: Partial<Attestation>, keys: KeyEntry[]): VerifyResult {
  if (!att || typeof att.canonical !== "string" || typeof att.signature !== "string" || typeof att.public_key !== "string") {
    return { verdict: "malformed", signature_valid: false, payload_matches_canonical: null, kid: null, key_status: null, kind: null,
      detail: "The record has no canonical, signature and public_key fields." };
  }
  const signature_valid = ed25519Verify(att.canonical, att.signature, att.public_key);
  let payload_matches_canonical: boolean | null = null;
  if (att.payload !== undefined) payload_matches_canonical = canonicalize(att.payload) === att.canonical;
  const entry = keys.find((k) => k.public_key.toLowerCase() === att.public_key!.toLowerCase());
  const base = { signature_valid, payload_matches_canonical, kid: entry?.kid ?? att.kid ?? null, key_status: entry?.status ?? null, kind: att.kind ?? null };
  if (!signature_valid) return { ...base, verdict: "invalid_signature", detail: "The signature does not match the record. It was altered or it was not signed by this key." };
  if (payload_matches_canonical === false) return { ...base, verdict: "invalid_signature", detail: "The signature is valid for the canonical text, but the readable payload differs from it. Do not trust the payload." };
  if (!entry) return { ...base, verdict: "unknown_key", detail: "The signature is valid, but the signing key is not in Predge's published key list." };
  if (entry.status === "revoked" || (entry.active === false && entry.status !== "retired"))
    return { ...base, verdict: "key_revoked", detail: `The signing key was revoked${entry.revoked_at ? " on " + entry.revoked_at.slice(0, 10) : ""}${entry.reason ? " (" + entry.reason + ")" : ""}. Do not trust this record.` };
  return { ...base, verdict: "authentic", detail: `Signature valid under Predge key ${entry.kid} (${entry.status ?? "active"}).` };
}
