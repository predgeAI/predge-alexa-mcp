import { describe, expect, it } from "vitest";
import { AutoStore, DynamoStore, MemoryStore, type Purchase } from "../src/store.js";

const P = (id: string, household = "h", created = "2026-10-23T10:00:00Z"): Purchase => ({ household, id, merchant: "m", item: "i", amount_usd: 1, promised: ["a"], created_at: created, status: "recorded" });

/** Minimal fake of DynamoDBDocumentClient: understands Put, Query by household, Delete. */
function fakeDoc() {
  const table = new Map<string, any>();
  const sent: any[] = [];
  return {
    sent,
    doc: {
      send: async (cmd: any) => {
        sent.push(cmd.constructor.name);
        const i = cmd.input;
        if (cmd.constructor.name === "PutCommand") { table.set(`${i.Item.household}#${i.Item.id}`, i.Item); return {}; }
        if (cmd.constructor.name === "QueryCommand") return { Items: [...table.values()].filter((x) => x.household === i.ExpressionAttributeValues[":h"]) };
        if (cmd.constructor.name === "DeleteCommand") { table.delete(`${i.Key.household}#${i.Key.id}`); return {}; }
        throw new Error("unexpected " + cmd.constructor.name);
      },
    } as any,
  };
}

describe("stores", () => {
  it("MemoryStore round-trips and sorts by creation time", async () => {
    const s = new MemoryStore();
    await s.put(P("b", "h", "2026-10-23T11:00:00Z")); await s.put(P("a"));
    expect((await s.list("h")).map((p) => p.id)).toEqual(["a", "b"]);
    expect((await s.get("h", "a"))?.id).toBe("a");
    await s.clear("h");
    expect(await s.list("h")).toEqual([]);
  });
  it("DynamoStore writes with household as partition key and queries by it", async () => {
    const { doc, sent } = fakeDoc();
    const s = new DynamoStore("kept-purchases", "us-east-1", doc);
    await s.put(P("a")); await s.put(P("z", "other"));
    expect((await s.list("h")).map((p) => p.id)).toEqual(["a"]);
    await s.clear("h");
    expect(await s.list("h")).toEqual([]);
    expect(sent).toContain("DeleteCommand");
  });
  it("AutoStore picks memory without AWS credentials and says why", async () => {
    const s = new AutoStore({} as any);
    expect(s.kind).toBe("memory");
    expect(s.fallbackReason).toContain("no AWS credentials");
  });
  it("AutoStore honours KEPT_STORE=memory even with credentials", () => {
    expect(new AutoStore({ AWS_PROFILE: "predge", KEPT_STORE: "memory" } as any).kind).toBe("memory");
  });
  it("AutoStore uses DynamoDB when credentials exist, and drops to memory with a reason if it fails", async () => {
    const bad = new DynamoStore("kept-purchases", "us-east-1", { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } } as any);
    const s = new AutoStore({ AWS_PROFILE: "predge" } as any, bad);
    expect(s.kind).toBe("dynamodb");
    await s.put(P("a"));
    expect(s.kind).toBe("memory");
    expect(s.fallbackReason).toContain("AccessDeniedException");
    expect((await s.list("h")).map((p) => p.id)).toEqual(["a"]);
  });
});
