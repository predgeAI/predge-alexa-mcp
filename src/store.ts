import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

export type PurchaseStatus = "recorded" | "delivered" | "not_delivered" | "inconclusive" | "refund_requested";

export interface StoredVerdict {
  id?: string;
  verdict: "delivered" | "not_delivered" | "inconclusive";
  /** "predge" = signed verdict from the Predge API; "offline_sample" = local unsigned sample check. */
  source: "predge" | "offline_sample";
  missing: string[];
  refund_amount_usd?: number;
  verify_url?: string;
  signed: boolean;
  checked_at: string;
  /** The signed attestation, kept so verify_receipt can check it later without another round trip. */
  attestation?: unknown;
}

export interface Purchase {
  household: string;
  id: string;
  merchant: string;
  item: string;
  amount_usd: number;
  /** Fields the merchant's confirmation must contain (JSON dot paths), e.g. ticket_id, seat, showtime. */
  promised: string[];
  due_by?: string;
  created_at: string;
  status: PurchaseStatus;
  verdict?: StoredVerdict;
  refund?: { drafted_at: string; text: string };
}

export interface PurchaseStore {
  readonly kind: "dynamodb" | "memory";
  put(p: Purchase): Promise<void>;
  list(household: string): Promise<Purchase[]>;
  get(household: string, id: string): Promise<Purchase | undefined>;
  clear(household: string): Promise<void>;
}

export class MemoryStore implements PurchaseStore {
  readonly kind = "memory" as const;
  private rows = new Map<string, Map<string, Purchase>>();
  async put(p: Purchase) {
    if (!this.rows.has(p.household)) this.rows.set(p.household, new Map());
    this.rows.get(p.household)!.set(p.id, structuredClone(p));
  }
  async list(h: string) { return [...(this.rows.get(h)?.values() ?? [])].map((x) => structuredClone(x)).sort((a, b) => a.created_at.localeCompare(b.created_at)); }
  async get(h: string, id: string) { const x = this.rows.get(h)?.get(id); return x ? structuredClone(x) : undefined; }
  async clear(h: string) { this.rows.delete(h); }
}

/** DynamoDB table `kept-purchases`: partition key household (S), sort key id (S). On-demand billing. */
export class DynamoStore implements PurchaseStore {
  readonly kind = "dynamodb" as const;
  private doc: DynamoDBDocumentClient;
  constructor(private table = "kept-purchases", region = "us-east-1", doc?: DynamoDBDocumentClient) {
    this.doc = doc ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async put(p: Purchase) { await this.doc.send(new PutCommand({ TableName: this.table, Item: p })); }
  async list(household: string) {
    const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "household = :h", ExpressionAttributeValues: { ":h": household } }));
    return ((r.Items ?? []) as Purchase[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async get(household: string, id: string) { return (await this.list(household)).find((p) => p.id === id); }
  async clear(household: string) { for (const p of await this.list(household)) await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { household, id: p.id } })); }
}

/**
 * Uses DynamoDB when AWS credentials look configured (AWS_PROFILE or access keys) and KEPT_STORE is not "memory";
 * if DynamoDB errors at runtime, drops to memory and remembers why, so the demo can say which path ran.
 */
export class AutoStore implements PurchaseStore {
  private mem = new MemoryStore();
  private ddb?: DynamoStore;
  fallbackReason?: string;
  constructor(env: NodeJS.ProcessEnv = process.env, ddb?: DynamoStore) {
    const want = (env.KEPT_STORE || "auto").toLowerCase();
    const haveCreds = Boolean(env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_LAMBDA_FUNCTION_NAME);
    if (want === "memory") this.fallbackReason = "KEPT_STORE=memory";
    else if (want === "dynamodb" || haveCreds) this.ddb = ddb ?? new DynamoStore(env.KEPT_TABLE || "kept-purchases", env.AWS_REGION || "us-east-1");
    else this.fallbackReason = "no AWS credentials in the environment";
  }
  get kind(): "dynamodb" | "memory" { return this.ddb ? "dynamodb" : "memory"; }
  private async run<T>(f: (s: PurchaseStore) => Promise<T>): Promise<T> {
    if (this.ddb) {
      try { return await f(this.ddb); }
      catch (e) {
        this.fallbackReason = `DynamoDB failed (${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e).slice(0, 120)})`;
        console.warn(`[store] ${this.fallbackReason}; using memory`);
        this.ddb = undefined;
      }
    }
    return f(this.mem);
  }
  put(p: Purchase) { return this.run((s) => s.put(p)); }
  list(h: string) { return this.run((s) => s.list(h)); }
  get(h: string, id: string) { return this.run((s) => s.get(h, id)); }
  clear(h: string) { return this.run((s) => s.clear(h)); }
}
