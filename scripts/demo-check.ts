// Runs the demo utterances end to end through POST /api/chat of a running server (default http://localhost:8787).
const base = process.env.BASE || "http://localhost:8787";
const JOB = { endpoint: "https://api.example-forecasts.com/v1/forecast", amount_usd: 0.25, delivery_status: 502, delivery_body: "", delivery_content_type: "text/html", expected_content_type: "application/json", required_fields: ["rows"], payer: "0xBuyerAgent", payee: "0xMerchant", merchant_id: "example-forecasts" };
let ctx: any = { lastJob: JOB };
const utterances = [
  "Alexa, is the Russia-Ukraine peace talks market safe to cash out?",
  "verify that record",
  "Alexa, what markets are in dispute right now?",
  "Alexa, did the work I paid for actually arrive?",
  "verify that record but tamper with it",
];
let failed = 0;
for (const u of utterances) {
  const r = await (await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance: u, ctx }) })).json() as any;
  ctx = { ...r.ctx, lastJob: JOB };
  const tools = (r.toolCalls ?? []).map((t: any) => `${t.name}${t.isError ? "(error)" : ""}`).join(",");
  console.log(`\n> ${u}\n  path=${r.path}${r.model ? " model=" + r.model : ""}${r.reason ? " reason=" + r.reason : ""} tools=${tools}\n  say: ${r.answer}`);
  if (!r.answer || (r.toolCalls ?? []).some((t: any) => t.isError && t.name !== "verify_delivery")) failed++;
}
process.exit(failed ? 1 : 0);
