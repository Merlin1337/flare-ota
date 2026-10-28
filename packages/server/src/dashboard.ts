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
:root{--bg:#fafaf9;--fg:#0c0a09;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#ea580c;--bad:#dc2626;--ok:#16a34a}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#fafaf9;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#fb923c;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line)}
header b{font-size:16px}header a{color:var(--muted);text-decoration:none}header a:hover{color:var(--fg)}header .me{margin-left:auto;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:20px}h2{font-size:15px;margin:28px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card .n{font-size:24px;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
code{font:12px ui-monospace,monospace}.muted{color:var(--muted)}.bad{color:var(--bad)}.ok{color:var(--ok)}
form{display:inline-flex;gap:6px;align-items:center;margin:2px 6px 2px 0}input,select,button{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--bad)}
.bar{height:6px;background:var(--line);border-radius:3px;min-width:80px}.bar>i{display:block;height:100%;background:var(--accent);border-radius:3px}
.flash{padding:10px 14px;border:1px solid var(--accent);border-radius:8px;margin-bottom:16px;word-break:break-all}
.qr svg{width:220px;height:220px;background:#fff;border-radius:8px}`;

function page(title: string, actor: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · flare-ota</title><style>${STYLE}</style></head><body>
<header><b>flare-ota</b><a href="/">Overview</a><a href="/tokens">Tokens</a><a href="/audit">Audit log</a><span class="me">${esc(actor)}</span></header>
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

function metricsRows(metrics: UpdateMetrics[], groups: Map<string, GroupSummary>): string {
  if (metrics.length === 0) return `<tr><td colspan="7" class="muted">Nothing published yet.</td></tr>`;
  return metrics
    .map((m) => {
      const group = groups.get(m.groupId);
      const adoption = pct(m.running, m.population);
      return `<tr>
<td><a href="/groups/${esc(m.groupId)}"><code>${esc(m.groupId.slice(0, 8))}</code></a><div class="muted">${esc(group?.message ?? "")}</div></td>
<td>${esc(m.platform)}<div class="muted"><code>${esc(m.runtimeVersion.slice(0, 12))}</code></div></td>
<td>${m.paused ? '<span class="bad">paused</span>' : `${m.rolloutPercent}%`}</td>
<td>${m.served}</td>
<td>${m.running}<div class="bar"><i style="width:${adoption}%"></i></div><span class="muted">${adoption}% of ${m.population}</span></td>
<td class="${m.failed ? "bad" : ""}">${m.failed}</td>
<td class="muted">${esc(group?.createdAt.slice(0, 16).replace("T", " ") ?? "")}</td></tr>`;
    })
    .join("");
}

function groupActions(group: GroupSummary): string {
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  const paused = group.updates.every((u) => u.paused);
  const id = esc(group.id);
  return `
<form method="post" action="/actions/rollout"><input type="hidden" name="groupId" value="${id}"><input name="percent" type="number" min="${rollout}" max="100" value="${Math.min(100, Math.max(rollout, rollout < 100 ? rollout + 10 : 100))}" style="width:70px"><button>Set rollout %</button></form>
<form method="post" action="/actions/${paused ? "resume" : "pause"}"><input type="hidden" name="groupId" value="${id}"><button class="${paused ? "" : "danger"}">${paused ? "Resume" : "Pause"}</button></form>
<form method="post" action="/actions/promote"><input type="hidden" name="groupId" value="${id}"><input name="branch" placeholder="branch" required pattern="[a-z0-9][a-z0-9._-]*" style="width:110px"><button>Promote</button></form>
<form method="post" action="/actions/preview"><input type="hidden" name="groupId" value="${id}"><input name="ttlMinutes" type="number" min="1" max="10080" value="60" style="width:70px"><button>Preview link</button></form>`;
}

async function overviewPage(store: Store, actor: string): Promise<Response> {
  const overview = await store.overview();
  const branches = [...new Set(overview.channels.map((c) => c.branch))];
  let sections = "";
  for (const branch of branches) {
    const [metrics, groups] = await Promise.all([store.metrics(branch, null, 10), store.groups(branch, 10)]);
    const byId = new Map(groups.map((g) => [g.id, g]));
    sections += `<h2>Branch ${esc(branch)} <span class="muted">· channels ${esc(overview.channels.filter((c) => c.branch === branch).map((c) => c.name).join(", "))}</span></h2>
<table><tr><th>Group</th><th>Platform / runtime</th><th>Rollout</th><th>Served</th><th>Running</th><th>Failed</th><th>Published</th></tr>${metricsRows(metrics, byId)}</table>
<p><form method="post" action="/actions/rollback"><input type="hidden" name="branch" value="${esc(branch)}"><select name="to"><option value="previous">to previous bundle</option><option value="embedded">to embedded bundle</option></select><select name="platform"><option value="">all platforms</option><option>ios</option><option>android</option></select><button class="danger">Roll back ${esc(branch)}</button></form></p>`;
  }
  const runtimes = overview.runtimes.map((r) => `<tr><td>${esc(r.platform)}</td><td><code>${esc(r.runtimeVersion)}</code></td><td>${r.devices}</td></tr>`).join("");
  return page("Overview", actor, `
<div class="cards"><div class="card"><div class="muted">Devices, 24 h</div><div class="n">${overview.devices.last24h}</div></div>
<div class="card"><div class="muted">Devices, 30 days</div><div class="n">${overview.devices.last30d}</div></div>
<div class="card"><div class="muted">Channels</div><div class="n">${overview.channels.length}</div></div></div>
${sections}
<h2>Native runtimes in the fleet (30 days)</h2><table><tr><th>Platform</th><th>Runtime version</th><th>Devices</th></tr>${runtimes || '<tr><td colspan="3" class="muted">No device has checked in yet.</td></tr>'}</table>
<h2>Channels</h2><table><tr><th>Channel</th><th>Branch</th></tr>${overview.channels.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.branch)}</td></tr>`).join("")}</table>
<p><form method="post" action="/actions/channel"><input name="channel" placeholder="channel" required><input name="branch" placeholder="branch" required><button>Point channel at branch</button></form></p>`);
}

async function groupPage(store: Store, actor: string, id: string, flash = ""): Promise<Response> {
  const group = await store.group(id);
  if (!group) return page("Not found", actor, "<p>Update group not found.</p>");
  const metrics = (await store.metrics(group.branch, null, 50)).filter((m) => m.groupId === id);
  return page(`Group ${id.slice(0, 8)}`, actor, `${flash}
<h2>${esc(group.message || "(no message)")}</h2>
<p class="muted">Branch <b>${esc(group.branch)}</b> · ${esc(group.kind)} · by ${esc(group.actor)} · ${esc(group.createdAt)}${group.gitCommit ? ` · commit <code>${esc(group.gitCommit.slice(0, 10))}</code>` : ""}${group.sourceGroupId ? ` · from <a href="/groups/${esc(group.sourceGroupId)}"><code>${esc(group.sourceGroupId.slice(0, 8))}</code></a>` : ""}</p>
<table><tr><th>Group</th><th>Platform / runtime</th><th>Rollout</th><th>Served</th><th>Running</th><th>Failed</th><th>Published</th></tr>${metricsRows(metrics, new Map([[group.id, group]]))}</table>
<p>${groupActions(group)}</p>`);
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
        return page("Audit log", actor, `<h2>Audit log</h2><table><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr>${rows}</table>`);
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
  return page("Tokens", actor, `${flash}<h2>API and MCP tokens</h2>
<p class="muted"><b>read</b>: metrics and lists · <b>publish</b>: upload and publish (CI) · <b>admin</b>: rollouts, rollbacks, channels, previews, tokens.</p>
<table><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="5" class="muted">No tokens.</td></tr>'}</table>
<p><form method="post" action="/actions/token-create"><input name="name" placeholder="name, e.g. github-actions" required pattern="[\\w .@:-]{1,64}"><select name="scope">${SCOPES.map((s) => `<option${s === "publish" ? " selected" : ""}>${s}</option>`).join("")}</select><button class="primary">Create token</button></form></p>`);
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

