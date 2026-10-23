/** MCP Apps receipt card (resource ui://kept/receipt). Self-contained HTML; talks to its host over postMessage JSON-RPC (ui/initialize, ui/notifications/tool-result). */
export const RECEIPT_URI = "ui://kept/receipt";
export const MCP_APP_MIME = "text/html;profile=mcp-app";

export const RECEIPT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark">
<title>Kept receipt</title>
<style>
  :root{color-scheme:dark;--bg:#0f1115;--ink:#f4f6fb;--dim:#9aa4b8;--line:#262b36;--ok:#2fd18b;--bad:#ff5468;--warn:#ffb020;--blue:#4da3ff}
  *{box-sizing:border-box} body{margin:0;background:transparent;color:var(--ink);font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{background:var(--bg);border:1px solid var(--line);border-left:8px solid var(--dim);border-radius:16px;padding:16px 18px}
  .card.delivered{border-left-color:var(--ok)} .card.not_delivered{border-left-color:var(--bad)} .card.inconclusive,.card.recorded{border-left-color:var(--warn)} .card.refund_requested{border-left-color:var(--blue)}
  .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
  .head{font-size:26px;font-weight:800;letter-spacing:.4px} .delivered .head{color:var(--ok)} .not_delivered .head{color:var(--bad)} .inconclusive .head,.recorded .head{color:var(--warn)} .refund_requested .head{color:var(--blue)}
  .amt{font-size:20px;font-weight:700}
  .what{color:var(--dim);margin:2px 0 8px} .detail{margin:8px 0}
  .miss{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0} .miss span{background:#3a1218;color:#ff8a98;border:1px solid #5a1d27;border-radius:999px;padding:3px 10px;font-size:13px}
  .refund{margin:8px 0;font-weight:700;color:var(--ink)} .sample{margin:8px 0;padding:6px 10px;border-radius:8px;background:#3a2c08;color:#ffcf66;font-size:13px}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
  .tag{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--dim)} .tag.signed{color:var(--ok);border-color:#1d5a40}
  button{background:var(--bad);color:#fff;border:0;border-radius:10px;padding:9px 14px;font-weight:700;font-size:14px;cursor:pointer}
  a{color:var(--blue);font-size:13px;word-break:break-all}
  pre{white-space:pre-wrap;background:#0a0c10;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;color:#c8d1e4;margin:8px 0 0}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:14px} td{padding:6px 4px;border-top:1px solid var(--line)} td.s{text-align:right;font-weight:700}
  .s-delivered{color:var(--ok)} .s-not_delivered{color:var(--bad)} .s-refund_requested{color:var(--blue)} .s-recorded,.s-inconclusive{color:var(--warn)}
</style></head><body>
<div class="card" id="card"><div class="head">Kept</div><div class="what">Waiting for a purchase to show...</div></div>
<script>
const $ = (id) => document.getElementById(id);
const money = (n) => "$" + (Number.isInteger(n) ? n : Number(n).toFixed(2));
const LABEL = { delivered:"Delivered", not_delivered:"Not delivered", refund_requested:"Refund requested", recorded:"Waiting", inconclusive:"Inconclusive" };
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function render(c) {
  if (!c) return;
  const root = $("card"); root.className = "card " + c.state; root.replaceChildren();
  const top = el("div", "top"); top.append(el("div", "head", c.headline || "Kept")); if (c.amount_usd !== undefined && c.state !== "list") top.append(el("div", "amt", money(c.amount_usd))); root.append(top);
  if (c.merchant) root.append(el("div", "what", (c.item ? c.item + " · " : "") + c.merchant));
  if (c.detail) root.append(el("div", "detail", c.detail));
  if (c.sample_label) root.append(el("div", "sample", c.sample_label));
  if (c.missing && c.missing.length && c.state === "not_delivered") { const m = el("div", "miss"); c.missing.forEach((f) => m.append(el("span", "", "missing: " + f.replace(/[_.]+/g, " ")))); root.append(m); }
  if (c.state === "not_delivered" && c.refund_amount_usd !== undefined) root.append(el("div", "refund", "Refund recommended: " + money(c.refund_amount_usd)));
  if (c.purchases) { const t = el("table"); c.purchases.forEach((p) => { const r = el("tr"); r.append(el("td", "", p.item + " · " + p.merchant), el("td", "", money(p.amount_usd)), el("td", "s s-" + p.status, LABEL[p.status] || p.status)); t.append(r); }); root.append(t); }
  if (c.refund_text) root.append(el("pre", "", c.refund_text));
  const row = el("div", "row");
  if (c.signed !== undefined) row.append(el("span", "tag" + (c.signed ? " signed" : ""), c.signed ? "ed25519 signed" : "unsigned"));
  if (c.source) row.append(el("span", "tag", c.source === "predge" ? "Predge verdict" : "offline sample"));
  if (c.state === "not_delivered" && c.purchase_id) { const b = el("button", "", "Request refund"); b.onclick = () => post({ jsonrpc: "2.0", method: "ui/message", params: { role: "user", content: { type: "text", text: "Ask them for a refund." } } }); row.append(b); }
  root.append(row);
  if (c.verify_url) { const a = el("a", "", c.verify_url); a.href = c.verify_url; a.target = "_blank"; a.rel = "noopener"; root.append(a); }
  postSize();
}
function post(m) { parent.postMessage(m, "*"); }
function postSize() { post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: document.documentElement.scrollHeight } }); }
let nextId = 1;
addEventListener("message", (e) => {
  const m = e.data; if (!m || typeof m !== "object") return;
  if (m.method === "ui/notifications/tool-result") render(m.params && m.params.structuredContent && m.params.structuredContent.card);
  else if (m.method === "ui/notifications/tool-input") { /* arguments are not needed to draw the card */ }
  else if (m.card) render(m.card);
});
post({ jsonrpc: "2.0", id: nextId++, method: "ui/initialize", params: { protocolVersion: "2025-11-21", appInfo: { name: "kept-receipt", version: "0.2.0" }, appCapabilities: {} } });
post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
</script></body></html>`;
