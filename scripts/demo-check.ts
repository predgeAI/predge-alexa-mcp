// Replays the demo requests end to end through POST /api/chat of a running server (default http://localhost:8787).
const base = process.env.BASE || "http://localhost:8787";
const inbox = ((await (await fetch(`${base}/api/demo/inbox?tickets=broken`)).json()) as any).inbox;
await fetch(`${base}/api/demo/reset`, { method: "POST" });
let ctx: any = { inbox };
const utterances = [
  "Alexa, buy two tickets for Saturday's 7pm show.",
  "Alexa, did my tickets arrive?",
  "Alexa, what did you buy for me?",
];
let failed = 0;
for (const u of utterances) {
  const r = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance: u, ctx }) })).json() as any;
  ctx = { ...ctx, ...r.ctx };
  const tools = (r.toolCalls ?? []).map((t: any) => `${t.name}${t.isError ? "(error)" : ""}`).join(",");
  console.log(`\n> ${u}\n  path=${r.path}${r.model ? " model=" + r.model : ""}${r.reason ? " reason=" + r.reason : ""} tools=${tools}\n  say: ${r.answer}`);
  if (!r.answer || (r.toolCalls ?? []).some((t: any) => t.isError)) failed++;
}
console.log("\n(The refund step needs a Yes click in /demo, so it is not replayed here.)");
process.exit(failed ? 1 : 0);
