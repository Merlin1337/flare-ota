// Server-rendered dashboard, served only on DASHBOARD_HOST after Cloudflare Access (verified in
// app.ts). Mutations are plain form POSTs with an Origin check, attributed to the Access user.

import { SCOPES, isPlatform, type GroupSummary, type Scope, type UpdateMetrics } from "@flare-ota/core";
import qrcode from "qrcode-generator";
import type { Principal } from "./auth.ts";
import type { Env } from "./env.ts";
import { errorResponse } from "./errors.ts";
import { Invalid, type Services } from "./services.ts";
import type { Store } from "./store.ts";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
:root{--bg:#fbfaf8;--fg:#1c1917;--muted:#78716c;--line:#ece8e3;--card:#fff;--soft:#f5f2ee;--accent:#f97316;--accent-soft:#fff1e6;--bad:#dc2626;--bad-soft:#fdecec;--ok:#15803d;--ok-soft:#e9f7ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e0d0c;--fg:#f5f2ee;--muted:#a19a93;--line:#26221f;--card:#161412;--soft:#1d1a17;--accent:#fb923c;--accent-soft:#2a1a0e;--bad:#f87171;--bad-soft:#2b1414;--ok:#4ade80;--ok-soft:#10241a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}a:hover{color:var(--accent)}
header{position:sticky;top:0;z-index:1;display:flex;gap:22px;align-items:center;padding:12px 28px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;gap:8px;align-items:center;font-weight:650;font-size:15px;letter-spacing:-.01em}.brand svg{width:20px;height:20px}
nav{display:flex;gap:18px}nav a{color:var(--muted);font-weight:500}nav a.on{color:var(--fg)}
.me{margin-left:auto;color:var(--muted);font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:999px}
main{max-width:1160px;margin:0 auto;padding:28px}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 4px}h2{font-size:15px;margin:0}.sub{color:var(--muted);margin:0 0 22px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:30px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.kpi span{color:var(--muted);font-size:12.5px;font-weight:500}.kpi b{display:block;font-size:28px;letter-spacing:-.03em;margin-top:2px;font-weight:650}
.section{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:22px;overflow:hidden}
.section-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line)}.section-head .grow{flex:1}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--muted);font-weight:500}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 18px;vertical-align:middle}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding-top:10px;padding-bottom:10px;background:var(--soft)}
tr+tr td{border-top:1px solid var(--line)}
.rel b{display:block;font-weight:600}.rel small{color:var(--muted);font-size:12px}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.muted{color:var(--muted)}.bad{color:var(--bad)}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:3px 10px;border-radius:999px}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.live{background:var(--ok-soft);color:var(--ok)}.chip.roll{background:var(--accent-soft);color:var(--accent)}.chip.paused{background:var(--soft);color:var(--muted)}.chip.back{background:var(--bad-soft);color:var(--bad)}
.adopt{min-width:150px}.adopt .bar{height:6px;background:var(--soft);border-radius:3px;overflow:hidden;margin-bottom:5px}.adopt .bar i{display:block;height:100%;background:linear-gradient(90deg,#fb923c,#f97316);border-radius:3px}
.adopt small{color:var(--muted);font-size:12px}.adopt small b{color:var(--fg);font-weight:600}
.fail{font-weight:600}.fail.zero{color:var(--muted);font-weight:400}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:22px}
form{display:inline-flex;gap:6px;align-items:center;margin:0}
input,select,button{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{cursor:pointer;font-weight:500}button:hover{border-color:var(--muted)}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
.actions{display:flex;flex-wrap:wrap;gap:10px;padding:16px 18px;border-top:1px solid var(--line);background:var(--soft)}
.flash{padding:14px 18px;border:1px solid var(--accent);background:var(--accent-soft);border-radius:12px;margin-bottom:20px;word-break:break-all}
.qr svg{width:220px;height:220px;background:#fff;border-radius:10px;padding:6px}
.empty{padding:22px 18px;color:var(--muted)}
@media (max-width:820px){.kpis{grid-template-columns:1fr 1fr}.grid2{grid-template-columns:1fr}header{padding:12px 16px}main{padding:16px}th,td{padding:10px 12px}}`;

const FLAME = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="fl" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#fbbf24"/></linearGradient></defs><path fill="url(#fl)" d="M12.6 2.2c.4 3-1.3 4.6-2.8 6.2C8.2 10 6.6 11.7 6.6 14.6A5.4 5.4 0 0 0 12 20a5.4 5.4 0 0 0 5.4-5.4c0-2.2-1-3.7-2.1-5 .1 1.5-.4 2.7-1.6 3.4.4-3.9-.4-7.6-1.1-10.8z"/></svg>`;

function page(title: string, actor: string, body: string, active = ""): Response {
  const link = (href: string, label: string) => `<a href="${href}" class="${active === href ? "on" : ""}">${label}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · flare-ota</title><style>${STYLE}</style></head><body>
<header><a class="brand" href="/">${FLAME}flare-ota</a><nav>${link("/", "Releases")}${link("/tokens", "Tokens")}${link("/audit", "Audit log")}</nav><span class="me">${esc(actor.replace(/^access:/, ""))}</span></header>
<main>${body}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const num = (n: number) => n.toLocaleString("en-US");

function since(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function rolloutChip(group: GroupSummary): string {
  if (group.kind === "rollback-embedded") return `<span class="chip back">Embedded</span>`;
  if (group.updates.length && group.updates.every((u) => u.paused)) return `<span class="chip paused">Paused</span>`;
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  return rollout < 100 ? `<span class="chip roll">${rollout}%</span>` : `<span class="chip live">100%</span>`;
}

function adoption(m: UpdateMetrics | undefined): string {
  if (!m) return `<td class="muted">—</td>`;
  if (m.population === 0) return `<td class="adopt"><div class="bar"></div><small>no devices yet</small></td>`;
  const share = pct(m.running, m.population);
  return `<td class="adopt"><div class="bar"><i style="width:${share}%"></i></div><small><b>${share}%</b> · ${num(m.running)} of ${num(m.population)}</small></td>`;
}

/** One row per release (update group), with iOS and Android adoption side by side. */
function releaseRows(groups: GroupSummary[], metrics: UpdateMetrics[]): string {
  if (groups.length === 0) return `<tr><td colspan="6" class="empty">Nothing published yet. Run <code>npx flare-ota publish</code>.</td></tr>`;
  return groups
    .map((group) => {
      const of = (platform: string) => metrics.find((m) => m.groupId === group.id && m.platform === platform);
      const failed = metrics.filter((m) => m.groupId === group.id).reduce((sum, m) => sum + m.failed, 0);
      const by = group.actor.replace(/^(token|access):/, "");
      return `<tr>
<td class="rel"><a href="/groups/${esc(group.id)}"><b>${esc(group.message || "(no message)")}</b></a><small><code>${esc(group.id.slice(0, 8))}</code> · ${esc(by)}${group.gitCommit ? ` · <code>${esc(group.gitCommit.slice(0, 7))}</code>` : ""}</small></td>
<td>${rolloutChip(group)}</td>${adoption(of("ios"))}${adoption(of("android"))}
<td class="fail ${failed ? "bad" : "zero"}">${failed}</td>
<td class="muted">${esc(since(group.createdAt))}</td></tr>`;
    })
    .join("");
}

const RELEASE_HEAD = `<tr><th>Release</th><th>Rollout</th><th>iOS adoption</th><th>Android adoption</th><th>Failed</th><th>Published</th></tr>`;

function groupActions(group: GroupSummary): string {
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  const paused = group.updates.every((u) => u.paused);
  const id = esc(group.id);
  return `<div class="actions">
<form method="post" action="/actions/rollout"><input type="hidden" name="groupId" value="${id}"><input name="percent" type="number" min="${rollout}" max="100" value="${Math.min(100, Math.max(rollout, rollout < 100 ? rollout + 10 : 100))}" style="width:76px"><button class="primary">Set rollout %</button></form>
<form method="post" action="/actions/${paused ? "resume" : "pause"}"><input type="hidden" name="groupId" value="${id}"><button class="${paused ? "" : "danger"}">${paused ? "Resume" : "Pause"}</button></form>
<form method="post" action="/actions/promote"><input type="hidden" name="groupId" value="${id}"><input name="branch" placeholder="branch" required pattern="[a-z0-9][a-z0-9._-]*" style="width:120px"><button>Promote</button></form>
<form method="post" action="/actions/preview"><input type="hidden" name="groupId" value="${id}"><input name="ttlMinutes" type="number" min="1" max="10080" value="60" style="width:76px"><button>Preview link</button></form></div>`;
}

async function overviewPage(store: Store, actor: string): Promise<Response> {
  const overview = await store.overview();
  const branches = [...new Set(overview.channels.map((c) => c.branch))];
  let sections = "";
  let rolling = 0;
  for (const branch of branches) {
    const [metrics, groups] = await Promise.all([store.metrics(branch, null, 40), store.groups(branch, 8)]);
    rolling += groups.filter((g) => g.kind === "bundle" && g.updates.some((u) => u.rolloutPercent < 100 && !u.paused)).length;
    const channels = overview.channels.filter((c) => c.branch === branch).map((c) => `<span class="pill">${esc(c.name)}</span>`).join(" ");
    sections += `<section class="section"><div class="section-head"><h2>${esc(branch)}</h2>${channels}<span class="grow"></span>
<form method="post" action="/actions/rollback"><input type="hidden" name="branch" value="${esc(branch)}"><select name="to"><option value="previous">to previous bundle</option><option value="embedded">to embedded bundle</option></select><select name="platform"><option value="">all platforms</option><option>ios</option><option>android</option></select><button class="danger">Roll back</button></form></div>
<table>${RELEASE_HEAD}${releaseRows(groups, metrics)}</table></section>`;
  }
  const runtimes = overview.runtimes.map((r) => `<tr><td>${esc(r.platform)}</td><td><code>${esc(r.runtimeVersion.slice(0, 16))}</code></td><td>${num(r.devices)}</td></tr>`).join("");
  return page("Releases", actor, `<h1>Releases</h1><p class="sub">What each channel serves, and how far each release has spread.</p>
<div class="kpis"><div class="kpi"><span>Active devices · 24 h</span><b>${num(overview.devices.last24h)}</b></div>
<div class="kpi"><span>Devices · 30 days</span><b>${num(overview.devices.last30d)}</b></div>
<div class="kpi"><span>Rollouts in progress</span><b>${rolling}</b></div>
<div class="kpi"><span>Native runtimes</span><b>${overview.runtimes.length}</b></div></div>
${sections}
<div class="grid2"><section class="section"><div class="section-head"><h2>Native runtimes</h2><span class="pill">30 days</span></div><table><tr><th>Platform</th><th>Fingerprint</th><th>Devices</th></tr>${runtimes || '<tr><td colspan="3" class="empty">No device has checked in yet.</td></tr>'}</table></section>
<section class="section"><div class="section-head"><h2>Channels</h2></div><table><tr><th>Channel</th><th>Branch</th></tr>${overview.channels.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.branch)}</td></tr>`).join("")}</table>
<div class="actions"><form method="post" action="/actions/channel"><input name="channel" placeholder="channel" required style="width:120px"><input name="branch" placeholder="branch" required style="width:120px"><button>Point channel at branch</button></form></div></section></div>`, "/");
}

async function groupPage(store: Store, actor: string, id: string, flash = ""): Promise<Response> {
  const group = await store.group(id);
  if (!group) return page("Not found", actor, "<p>Update group not found.</p>");
  const metrics = (await store.metrics(group.branch, null, 50)).filter((m) => m.groupId === id);
  return page(`Release ${id.slice(0, 8)}`, actor, `${flash}
<h1>${esc(group.message || "(no message)")}</h1>
<p class="sub">Branch <b>${esc(group.branch)}</b> · ${esc(group.kind)} · by ${esc(group.actor.replace(/^(token|access):/, ""))} · ${esc(since(group.createdAt))}${group.gitCommit ? ` · commit <code>${esc(group.gitCommit.slice(0, 10))}</code>` : ""}${group.sourceGroupId ? ` · from <a href="/groups/${esc(group.sourceGroupId)}"><code>${esc(group.sourceGroupId.slice(0, 8))}</code></a>` : ""}</p>
<section class="section"><table>${RELEASE_HEAD}${releaseRows([group], metrics)}</table>${groupActions(group)}</section>`);
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

/** The only form fields the dashboard reads; anything else is ignored. */
const FORM_FIELDS = ["groupId", "percent", "branch", "to", "platform", "channel", "ttlMinutes", "scope", "name", "id"];

async function form(request: Request): Promise<Record<string, string>> {
  const data = await request.formData();
  const out: Record<string, string> = {};
  for (const key of FORM_FIELDS) {
    const value = data.get(key);
    if (typeof value === "string") out[key] = value.slice(0, 200);
  }
  return out;
}

export async function dashboard(request: Request, env: Env, store: Store, services: Services, principal: Principal): Promise<Response> {
  const url = new URL(request.url);
  const actor = principal.actor;
  try {
    if (request.method === "GET") {
      if (url.pathname === "/") return await overviewPage(store, actor);
      const groupMatch = /^\/groups\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (groupMatch) return await groupPage(store, actor, groupMatch[1]!);
      if (url.pathname === "/audit") {
        const rows = (await store.auditLog(200))
          .map((e) => `<tr><td class="muted">${esc(e.at.replace("T", " ").slice(0, 19))}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td><code>${esc(e.target ?? "")}</code></td><td class="muted"><code>${esc(e.details ? JSON.stringify(e.details) : "")}</code></td></tr>`)
          .join("");
        return page("Audit log", actor, `<h1>Audit log</h1><p class="sub">Every publish, rollout, rollback, channel, preview and token change, with who did it.</p>
<section class="section"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr>${rows || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}</table></section>`, "/audit");
      }
      if (url.pathname === "/tokens") return await tokensPage(store, actor);
      return page("Not found", actor, "<p>Not found.</p>");
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // Forms are only accepted from the dashboard itself.
    if (request.headers.get("origin") !== url.origin) return new Response("Cross-origin request refused.", { status: 403 });
    const f = await form(request);
    switch (url.pathname) {
      case "/actions/rollout":
        await services.setRollout(f.groupId ?? "", Number(f.percent), actor);
        return redirect(`/groups/${f.groupId}`);
      case "/actions/pause":
      case "/actions/resume":
        await services.setPaused(f.groupId ?? "", url.pathname.endsWith("pause"), actor);
        return redirect(`/groups/${f.groupId}`);
      case "/actions/promote": {
        const group = await services.promote(f.groupId ?? "", f.branch ?? "", 100, actor);
        return redirect(`/groups/${group.id}`);
      }
      case "/actions/rollback": {
        const platform = f.platform ? f.platform : null;
        if (platform !== null && !isPlatform(platform)) throw new Invalid("Unknown platform.");
        const group = await services.rollback(f.branch ?? "", platform, f.to === "embedded" ? "embedded" : "previous", actor);
        return redirect(`/groups/${group.id}`);
      }
      case "/actions/channel":
        await services.setChannel(f.channel ?? "", f.branch ?? "", actor);
        return redirect("/");
      case "/actions/preview": {
        const preview = await services.createPreview(f.groupId ?? "", Number(f.ttlMinutes ?? 60), null, actor);
        const flash = `<div class="flash"><div class="qr">${qrSvg(preview.deepLink)}</div>
<p>Scan with a device running a build that declares the <code>flare-preview</code> header. Expires ${esc(preview.expiresAt)}.</p><p><code>${esc(preview.deepLink)}</code></p></div>`;
        return await groupPage(store, actor, f.groupId ?? "", flash);
      }
      case "/actions/token-create": {
        const scope = (f.scope ?? "") as Scope;
        if (!SCOPES.includes(scope)) throw new Invalid("Unknown scope.");
        const created = await services.createToken(f.name ?? "", scope, actor);
        return await tokensPage(store, actor, `<div class="flash">New ${esc(scope)} token <b>${esc(f.name)}</b>. Copy it now, it is not shown again:<p><code>${esc(created.token)}</code></p></div>`);
      }
      case "/actions/token-revoke":
        await services.revokeToken(f.id ?? "", actor);
        return redirect("/tokens");
      default:
        return new Response("Not found", { status: 404 });
    }
  } catch (error) {
    const response = errorResponse(error);
    const { error: message } = (await response.json()) as { error: string };
    return page("Error", actor, `<div class="flash bad">${esc(message)}</div><p><a href="javascript:history.back()">Back</a></p>`);
  }
}

async function tokensPage(store: Store, actor: string, flash = ""): Promise<Response> {
  const rows = (await store.listTokens())
    .map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.scope)}</td><td class="muted">${esc(t.createdAt.slice(0, 10))}</td><td class="muted">${esc(t.lastUsedAt?.slice(0, 16).replace("T", " ") ?? "never")}</td>
<td>${t.revokedAt ? '<span class="muted">revoked</span>' : `<form method="post" action="/actions/token-revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="danger">Revoke</button></form>`}</td></tr>`)
    .join("");
  return page("Tokens", actor, `${flash}<h1>Tokens</h1>
<p class="sub"><b>read</b> sees metrics and lists · <b>publish</b> uploads and publishes (CI) · <b>admin</b> changes rollouts, rollbacks, channels, previews and tokens.</p>
<section class="section"><table><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="5" class="empty">No tokens.</td></tr>'}</table>
<div class="actions"><form method="post" action="/actions/token-create"><input name="name" placeholder="name, e.g. github-actions" required pattern="[\\w .@:-]{1,64}" style="width:230px"><select name="scope">${SCOPES.map((s) => `<option${s === "publish" ? " selected" : ""}>${s}</option>`).join("")}</select><button class="primary">Create token</button></form></div></section>`, "/tokens");
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

