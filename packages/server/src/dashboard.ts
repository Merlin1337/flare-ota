// Server-rendered dashboard, served only on DASHBOARD_HOST after Cloudflare Access (verified in
// app.ts). No JavaScript: charts are inline SVG, mutations are plain form POSTs with an Origin
// check, attributed to the Access user.

import { SCOPES, isPlatform, type AuditEntry, type GroupSummary, type Scope, type UpdateMetrics } from "@flare-ota/core";
import qrcode from "qrcode-generator";
import type { Principal } from "./auth.ts";
import type { Env } from "./env.ts";
import { errorResponse } from "./errors.ts";
import { Invalid, type Services } from "./services.ts";
import type { Store } from "./store.ts";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
:root{color-scheme:dark;--bg:#07080a;--panel:#0d0f12;--panel2:#12151a;--raise:#171b21;--line:rgba(255,255,255,.065);--line2:rgba(255,255,255,.11);
--fg:#eef1f5;--fg2:#bcc3cd;--muted:#7a838f;--faint:#4b525c;--accent:#ff7a1a;--accent2:#ffb547;--accentInk:#1a0d03;--glow:rgba(255,122,26,.16);
--ok:#34d399;--okBg:rgba(52,211,153,.1);--bad:#f87171;--badBg:rgba(248,113,113,.1);--warn:#fbbf24;--warnBg:rgba(251,191,36,.1);--ios:#9aa7ff;--android:#3ddc97;
--shadow:0 1px 0 rgba(255,255,255,.04) inset,0 24px 48px -24px rgba(0,0,0,.6)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f4f5f7;--panel:#ffffff;--panel2:#fafbfc;--raise:#f1f3f6;--line:#e8eaee;--line2:#dadee5;
--fg:#0b0d10;--fg2:#30363f;--muted:#6b7280;--faint:#a3a9b3;--accent:#f26a0f;--accent2:#f59e0b;--accentInk:#fff;--glow:rgba(242,106,15,.10);
--ok:#059669;--okBg:#e8f7f1;--bad:#dc2626;--badBg:#fdeeee;--warn:#b45309;--warnBg:#fdf4e3;--ios:#5b6cff;--android:#10a36a;
--shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px -18px rgba(16,24,40,.18)}}
*{box-sizing:border-box}html,body{margin:0}
body{font:14px/1.5 "SF Pro Text",-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;font-feature-settings:"cv11","ss01"}
a{color:inherit;text-decoration:none}
.num,.kpi .v,td.n{font-variant-numeric:tabular-nums}
code,.mono{font:12px/1.4 "SF Mono",ui-monospace,Menlo,monospace;color:var(--muted)}
.app{display:grid;grid-template-columns:248px 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:20px 14px;border-right:1px solid var(--line);background:var(--panel)}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 22px;font:650 16px/1 "SF Pro Display",-apple-system,Inter,sans-serif;letter-spacing:-.02em}
.brand .mark{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(145deg,#2a1406,#120904);border:1px solid rgba(255,122,26,.35);box-shadow:0 6px 18px -6px rgba(255,122,26,.55)}
.brand .mark svg{width:17px;height:17px}
.env{margin:0 10px 20px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--panel2);font-size:12px;color:var(--muted)}
.env b{display:flex;align-items:center;gap:7px;color:var(--fg);font-weight:600;font-size:13px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--okBg)}
.dot.live{animation:pulse 2.4s ease-in-out infinite}@keyframes pulse{50%{box-shadow:0 0 0 6px transparent}}
.navl{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:0 10px 8px}
nav a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;color:var(--fg2);font-weight:500;margin-bottom:2px}
nav a svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.7;opacity:.8}
nav a:hover{background:var(--raise);color:var(--fg)}nav a.on{background:var(--raise);color:var(--fg);box-shadow:inset 0 0 0 1px var(--line)}
.me{margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px;border-top:1px solid var(--line)}
.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:650;font-size:12px;color:var(--accentInk);background:linear-gradient(135deg,var(--accent2),var(--accent))}
.me small{display:block;color:var(--muted);font-size:11.5px}.me div span{font-size:13px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;display:block}
main{padding:28px 36px 60px;max-width:1320px;width:100%}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}
.crumb{font-size:12.5px;color:var(--muted);margin-bottom:6px}
h1{margin:0;font:650 26px/1.15 "SF Pro Display",-apple-system,Inter,sans-serif;letter-spacing:-.025em}
.sub{color:var(--muted);margin:6px 0 0}
.livepill{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fg2);padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:var(--panel)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.kpis{display:grid;grid-template-columns:1.35fr 1fr 1fr 1fr;gap:14px;margin-bottom:14px}
.kpi{position:relative;overflow:hidden;padding:18px 18px 16px}
.kpi .l{font-size:12.5px;color:var(--muted);font-weight:500;display:flex;align-items:center;gap:6px}
.kpi .v{font:650 34px/1.1 "SF Pro Display",-apple-system,Inter,sans-serif;letter-spacing:-.035em;margin-top:10px}
.kpi .h{font-size:12.5px;color:var(--muted);margin-top:6px}.kpi .h b{color:var(--fg2);font-weight:550}
.kpi.hero{background:radial-gradient(120% 140% at 100% 0%,var(--glow),transparent 60%),var(--panel)}
.kpi .spark{position:absolute;left:0;bottom:0;width:100%;height:46px;opacity:.95}
.kpi.hero{padding-bottom:54px}.kpi.hero .v,.kpi.hero .h{position:relative}
.ringrow{display:flex;align-items:center;gap:14px;margin-top:8px}.ringrow .t{font-size:13px;color:var(--fg2);line-height:1.35;min-width:0}.ringrow .t b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--fg);font-weight:600}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;align-items:start}
.stack{display:grid;gap:14px}
.ch{display:flex;align-items:center;gap:10px;padding:16px 18px 12px}.ch h2{margin:0;font:600 15px/1.2 "SF Pro Display",-apple-system,Inter,sans-serif;letter-spacing:-.01em}.ch .grow{flex:1}
.ch small{color:var(--muted)}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;text-transform:none;letter-spacing:0;padding:3px 9px;border-radius:999px;background:var(--raise);color:var(--fg2);border:1px solid var(--line)}
.branch{display:flex;align-items:center;gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:var(--panel2);font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.branch .grow{flex:1}
.rel{display:grid;grid-template-columns:minmax(0,1.6fr) 96px minmax(0,1fr) minmax(0,1fr) 54px;gap:18px;align-items:center;padding:14px 18px;border-top:1px solid var(--line);transition:background .15s}
.rel:hover{background:var(--panel2)}
.rel .title{font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rel .meta{font-size:12px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:650;padding:4px 10px;border-radius:999px;white-space:nowrap}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.live{background:var(--okBg);color:var(--ok)}.chip.roll{background:var(--warnBg);color:var(--warn)}.chip.paused{background:var(--raise);color:var(--muted)}.chip.back{background:var(--badBg);color:var(--bad)}
.ad{font-size:12px;color:var(--muted);min-width:0}.ad .row{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;white-space:nowrap;overflow:hidden}.ad .row b{color:var(--fg);font-weight:600}
.track{height:6px;border-radius:99px;background:var(--raise);overflow:hidden}.track i{display:block;height:100%;border-radius:99px}
.ios i{background:linear-gradient(90deg,color-mix(in srgb,var(--ios) 60%,transparent),var(--ios))}.android i{background:linear-gradient(90deg,color-mix(in srgb,var(--android) 60%,transparent),var(--android))}
.fail{text-align:right;font-weight:650}.fail.zero{color:var(--faint);font-weight:500}
.hdr{display:grid;grid-template-columns:minmax(0,1.6fr) 96px minmax(0,1fr) minmax(0,1fr) 54px;gap:18px;padding:9px 18px;border-top:1px solid var(--line);font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.hdr span:last-child{text-align:right}
.empty{padding:22px 18px;color:var(--muted);border-top:1px solid var(--line)}
.fleet{padding:4px 18px 18px;display:flex;align-items:center;gap:18px}
.legend{display:grid;gap:10px;flex:1}.legend div{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg2)}.legend b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--fg)}
.sw{width:9px;height:9px;border-radius:3px}
.list{padding:0 18px 14px}.li{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line);font-size:13px}.li:first-child{border-top:0}
.li .grow{flex:1;min-width:0}.li .mini{width:90px}
.feed{padding:2px 18px 12px}.ev{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.ev:first-child{border-top:0}
.ev .ic{width:28px;height:28px;flex:none;border-radius:8px;display:grid;place-items:center;background:var(--raise);border:1px solid var(--line)}
.ev .ic i{width:7px;height:7px;border-radius:50%;background:var(--muted)}.ev .ic.pub i{background:var(--accent)}.ev .ic.roll i{background:var(--warn)}.ev .ic.back i{background:var(--bad)}.ev .ic.ok i{background:var(--ok)}
.ev p{margin:0;font-size:13px;color:var(--fg2)}.ev p b{color:var(--fg);font-weight:600}.ev small{color:var(--muted);font-size:12px}
form{display:inline-flex;gap:8px;align-items:center;margin:0}
input,select,button{font:inherit;font-size:13px;height:34px;padding:0 12px;border:1px solid var(--line2);border-radius:10px;background:var(--panel2);color:var(--fg)}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--glow)}
button{cursor:pointer;font-weight:600;background:var(--raise)}button:hover{border-color:var(--faint)}
.primary{background:linear-gradient(180deg,var(--accent2),var(--accent));border-color:transparent;color:var(--accentInk);box-shadow:0 8px 20px -10px var(--accent)}
.danger{color:var(--bad)}.ghost{background:transparent}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;padding:14px 18px;border-top:1px solid var(--line);background:var(--panel2);border-radius:0 0 16px 16px}
.flash{display:flex;gap:22px;align-items:center;padding:18px;margin-bottom:14px;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);background:radial-gradient(120% 140% at 0% 0%,var(--glow),transparent 60%),var(--panel);border-radius:16px;word-break:break-all}
.flash.bad{border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.qr svg{width:180px;height:180px;background:#fff;border-radius:14px;padding:8px;display:block}
.platforms{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.pcard{padding:18px;display:flex;gap:18px;align-items:center}.pcard .t b{display:block;font-size:13px;color:var(--muted);font-weight:550}.pcard .t .big{font:650 28px/1.1 "SF Pro Display",-apple-system,Inter,sans-serif;letter-spacing:-.03em;margin:4px 0}.pcard .t small{color:var(--muted)}
.ctl{padding:16px 18px;border-top:1px solid var(--line)}.ctl b{display:block;font-size:13.5px;font-weight:600}.ctl p{margin:3px 0 12px;color:var(--muted);font-size:12.5px;line-height:1.45}
.ctl form+form{margin-left:6px}.suffix{position:relative;display:inline-flex}.suffix input{width:92px;padding-right:28px}.suffix span{position:absolute;right:11px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:13px}
.kv{display:inline-flex;gap:5px;font-size:12px;color:var(--muted);padding:2px 8px;margin:2px 6px 2px 0;border-radius:7px;background:var(--raise)}.kv b{color:var(--fg2);font-weight:550}
td .ev{display:inline-flex;padding:0;border:0;vertical-align:middle;margin-right:6px}
dl{display:grid;grid-template-columns:120px 1fr;gap:10px 16px;margin:0;padding:4px 18px 18px;font-size:13px}dt{color:var(--muted)}dd{margin:0;color:var(--fg2)}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:10px 18px;border-top:1px solid var(--line)}
td{padding:12px 18px;border-top:1px solid var(--line);color:var(--fg2);vertical-align:middle}tr:hover td{background:var(--panel2)}
@media (max-width:1100px){.kpis{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}}
@media (max-width:760px){.app{grid-template-columns:1fr}aside{position:static;height:auto}main{padding:20px 16px}.rel,.hdr{grid-template-columns:1fr 90px}.rel .ad,.hdr span:nth-child(n+3){display:none}.platforms{grid-template-columns:1fr}}`;

const FLAME = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="fl" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ffc56b"/></linearGradient></defs><path fill="url(#fl)" d="M12.6 2.2c.4 3-1.3 4.6-2.8 6.2C8.2 10 6.6 11.7 6.6 14.6A5.4 5.4 0 0 0 12 20a5.4 5.4 0 0 0 5.4-5.4c0-2.2-1-3.7-2.1-5 .1 1.5-.4 2.7-1.6 3.4.4-3.9-.4-7.6-1.1-10.8z"/></svg>`;
const ICON = {
  overview: `<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>`,
  tokens: `<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>`,
  audit: `<svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4"/></svg>`,
};

function page(title: string, actor: string, body: string, active = "", host = ""): Response {
  const who = actor.replace(/^access:/, "");
  const link = (href: string, label: string, icon: string) => `<a href="${href}" class="${active === href ? "on" : ""}">${icon}${label}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · flare-ota</title><style>${STYLE}</style></head><body><div class="app">
<aside><a class="brand" href="/"><span class="mark">${FLAME}</span>flare-ota</a>
<div class="env"><b><span class="dot live"></span>Operational</b>${esc(host || "updates server")}</div>
<div class="navl">Workspace</div><nav>${link("/", "Overview", ICON.overview)}${link("/tokens", "Tokens", ICON.tokens)}${link("/audit", "Audit log", ICON.audit)}</nav>
<div class="me"><span class="avatar">${esc((who[0] ?? "?").toUpperCase())}</span><div><span>${esc(who)}</span><small>Signed in with Access</small></div></div></aside>
<main>${body}</main></div></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: with no-referrer, browsers send `Origin: null` on form posts,
      // which the CSRF check below would (rightly) refuse.
      "referrer-policy": "same-origin",
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

// ---- inline SVG charts ----

function sparkline(values: number[]): string {
  const w = 400;
  const h = 64;
  const max = Math.max(1, ...values);
  const step = w / Math.max(1, values.length - 1);
  const points = values.map((v, i) => [i * step, h - 6 - (v / max) * (h - 16)] as const);
  // Smooth with midpoint quadratic curves.
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!;
    const [x1, y1] = points[i]!;
    d += ` Q${x0},${y0} ${(x0 + x1) / 2},${(y0 + y1) / 2}`;
  }
  d += ` T${points.at(-1)![0]},${points.at(-1)![1]}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
<path d="${d} L${w},${h} L0,${h} Z" fill="url(#sg)"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function ring(percent: number, size = 64, color = "var(--accent)"): string {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, percent)) / 100) * c;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="flex:none">
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--raise)" stroke-width="6"/>
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="var(--fg)" font-size="${size / 4.6}" font-weight="650" font-family="-apple-system,Inter,sans-serif">${percent}%</text></svg>`;
}

function donut(parts: { value: number; color: string }[], size = 116): string {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = parts
    .map((p) => {
      const len = (p.value / total) * c;
      const arc = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${p.color}" stroke-width="12" stroke-dasharray="${Math.max(0, len - 3)} ${c}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
      offset += len;
      return arc;
    })
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="flex:none"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--raise)" stroke-width="12"/>${arcs}
<text x="50%" y="47%" text-anchor="middle" fill="var(--fg)" font-size="20" font-weight="650" font-family="-apple-system,Inter,sans-serif">${num(total)}</text>
<text x="50%" y="63%" text-anchor="middle" fill="var(--muted)" font-size="10.5" font-family="-apple-system,Inter,sans-serif">devices</text></svg>`;
}

// ---- release rows ----

function rolloutChip(group: GroupSummary): string {
  if (group.kind === "rollback-embedded") return `<span class="chip back">Embedded</span>`;
  if (group.updates.length && group.updates.every((u) => u.paused)) return `<span class="chip paused">Paused</span>`;
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  return rollout < 100 ? `<span class="chip roll">${rollout}%</span>` : `<span class="chip live">Live</span>`;
}

function adoption(m: UpdateMetrics | undefined, label: string, cls: string): string {
  if (!m) return `<div class="ad"><div class="row"><span>${label}</span><span>—</span></div><div class="track"></div></div>`;
  const share = pct(m.running, m.population);
  const right = m.population === 0 ? "no devices" : `<b>${share}%</b>&nbsp;· ${num(m.running)}`;
  return `<div class="ad ${cls}"><div class="row"><span>${label}</span><span>${right}</span></div><div class="track"><i style="width:${share}%"></i></div></div>`;
}

const actorName = (actor: string) => actor.replace(/^(token|access):/, "");

function releaseRows(groups: GroupSummary[], metrics: UpdateMetrics[]): string {
  if (groups.length === 0) return `<div class="empty">Nothing published yet. Run <code>npx flare-ota publish</code>.</div>`;
  return groups
    .map((group) => {
      const of = (platform: string) => metrics.find((m) => m.groupId === group.id && m.platform === platform);
      const failed = metrics.filter((m) => m.groupId === group.id).reduce((sum, m) => sum + m.failed, 0);
      return `<a class="rel" href="/groups/${esc(group.id)}"><div><div class="title">${esc(group.message || "(no message)")}</div>
<div class="meta"><span class="mono">${esc(group.id.slice(0, 8))}</span> · ${esc(actorName(group.actor))} · ${esc(since(group.createdAt))}</div></div>
<div>${rolloutChip(group)}</div>${adoption(of("ios"), "iOS", "ios")}${adoption(of("android"), "Android", "android")}
<div class="fail ${failed ? "bad" : "zero"}">${failed}</div></a>`;
    })
    .join("");
}

const RELEASE_HEAD = `<div class="hdr"><span>Release</span><span>Status</span><span>iOS</span><span>Android</span><span>Failed</span></div>`;

// ---- activity feed ----

const ACTIONS: Record<string, [string, string]> = {
  publish: ["pub", "published"],
  rollout: ["roll", "changed the rollout of"],
  pause: ["roll", "paused"],
  resume: ["ok", "resumed"],
  rollback: ["back", "rolled back"],
  promote: ["pub", "promoted"],
  "set-channel": ["ok", "repointed channel"],
  "create-preview": ["ok", "created a preview link for"],
  "create-token": ["ok", "created a token"],
  "revoke-token": ["back", "revoked a token"],
  gc: ["ok", "collected garbage"],
};

function feed(entries: AuditEntry[], groups: Map<string, GroupSummary>): string {
  if (!entries.length) return `<div class="empty">No activity yet.</div>`;
  return `<div class="feed">${entries
    .map((e) => {
      const [cls, verb] = ACTIONS[e.action] ?? ["", e.action];
      const target = e.target ? groups.get(e.target)?.message ?? (e.action.includes("token") ? "" : e.target.slice(0, 8)) : "";
      const extra = e.action === "rollout" && e.details?.percent ? ` to <b>${esc(e.details.percent)}%</b>` : "";
      return `<div class="ev"><span class="ic ${cls}"><i></i></span><div><p><b>${esc(actorName(e.actor))}</b> ${esc(verb)} ${target ? `<b>${esc(target)}</b>` : ""}${extra}</p><small>${esc(since(e.at))}</small></div></div>`;
    })
    .join("")}</div>`;
}

// ---- pages ----

async function overviewPage(store: Store, actor: string, host: string): Promise<Response> {
  const [overview, activity, audit] = await Promise.all([store.overview(), store.activity(), store.auditLog(7)]);
  const branches = [...new Set(overview.channels.map((c) => c.branch))];
  const allGroups = new Map<string, GroupSummary>();
  let releases = "";
  let rolling: GroupSummary[] = [];
  let latestProd: { group: GroupSummary; metrics: UpdateMetrics[] } | null = null;
  for (const branch of branches) {
    const [metrics, groups] = await Promise.all([store.metrics(branch, null, 40), store.groups(branch, 6)]);
    for (const g of groups) allGroups.set(g.id, g);
    rolling = rolling.concat(groups.filter((g) => g.kind === "bundle" && g.updates.some((u) => u.rolloutPercent < 100 && !u.paused)));
    if (branch === "production" || (!latestProd && groups[0])) {
      const live = groups.find((g) => g.kind === "bundle" && g.updates.every((u) => u.rolloutPercent === 100 && !u.paused));
      if (live) latestProd = { group: live, metrics: metrics.filter((m) => m.groupId === live.id) };
    }
    // A channel named like its branch is the default setup: only show channels that add information.
    const channels = overview.channels.filter((c) => c.branch === branch && c.name !== branch).map((c) => `<span class="tag">channel ${esc(c.name)}</span>`).join(" ");
    releases += `<div class="branch"><span>${esc(branch)}</span>${channels}<span class="grow"></span>
<form method="post" action="/actions/rollback"><input type="hidden" name="branch" value="${esc(branch)}"><select name="to"><option value="previous">Previous bundle</option><option value="embedded">Embedded bundle</option></select><select name="platform"><option value="">All platforms</option><option value="ios">iOS</option><option value="android">Android</option></select><button class="danger ghost">Roll back</button></form></div>
${RELEASE_HEAD}${releaseRows(groups, metrics)}`;
  }
  for (const entry of audit) {
    if (entry.target && !allGroups.has(entry.target)) {
      const group = await store.group(entry.target);
      if (group) allGroups.set(group.id, group);
    }
  }
  const byPlatform = (p: string) => overview.runtimes.filter((r) => r.platform === p).reduce((s, r) => s + r.devices, 0);
  const ios = byPlatform("ios");
  const android = byPlatform("android");
  const prodRunning = latestProd ? latestProd.metrics.reduce((s, m) => s + m.running, 0) : 0;
  const prodPopulation = latestProd ? latestProd.metrics.reduce((s, m) => s + m.population, 0) : 0;
  const failedTotal = activity.failed7d;
  const runtimeRows = overview.runtimes
    .slice(0, 5)
    .map((r) => {
      const share = pct(r.devices, overview.devices.last30d);
      return `<div class="li"><span class="tag">${r.platform === "ios" ? "iOS" : "Android"}</span><span class="grow mono">${esc(r.runtimeVersion.slice(0, 10))}</span><div class="mini track ${r.platform}"><i style="width:${share}%"></i></div><span class="num" style="width:52px;text-align:right">${num(r.devices)}</span></div>`;
    })
    .join("");
  const body = `<div class="top"><div><div class="crumb">Workspace · Overview</div><h1>Overview</h1><p class="sub">Every release, every channel, and how far it has spread.</p></div>
<span class="livepill"><span class="dot live"></span>Live · updated ${new Date().toISOString().slice(11, 16)} UTC</span></div>
<div class="kpis">
<div class="card kpi hero"><div class="l">Active devices · 24 h</div><div class="v num">${num(overview.devices.last24h)}</div><div class="h"><b>${num(overview.devices.last30d)}</b> in the last 30 days</div>${sparkline(activity.hourly)}</div>
<div class="card kpi"><div class="l">Latest production release</div><div class="ringrow">${ring(pct(prodRunning, prodPopulation))}<div class="t"><b>${esc(latestProd?.group.message ?? "Nothing live yet")}</b>${latestProd ? `${num(prodRunning)} of ${num(prodPopulation)} devices` : ""}</div></div></div>
<div class="card kpi"><div class="l">Rollouts in progress</div><div class="v num">${rolling.length}</div><div class="h">${rolling.length ? rolling.slice(0, 2).map((g) => `${esc(g.message)} · <b>${Math.max(...g.updates.map((u) => u.rolloutPercent))}%</b>`).join("<br>") : "All releases fully rolled out"}</div></div>
<div class="card kpi"><div class="l">Failed launches · 7 days</div><div class="v num ${failedTotal ? "bad" : ""}">${num(failedTotal)}</div><div class="h">${failedTotal ? "Never re-offered to those devices" : "No launch failures reported"}</div></div>
</div>
<div class="grid"><div class="card"><div class="ch"><h2>Releases</h2><small>${branches.length} branch${branches.length === 1 ? "" : "es"}</small></div>${releases}</div>
<div class="stack">
<div class="card"><div class="ch"><h2>Fleet</h2><span class="grow"></span><small>30 days</small></div><div class="fleet">${donut([{ value: ios, color: "var(--ios)" }, { value: android, color: "var(--android)" }])}
<div class="legend"><div><span class="sw" style="background:var(--ios)"></span>iOS<b>${num(ios)}</b></div><div><span class="sw" style="background:var(--android)"></span>Android<b>${num(android)}</b></div></div></div>
<div class="list">${runtimeRows || '<div class="li muted">No device has checked in yet.</div>'}</div></div>
<div class="card"><div class="ch"><h2>Recent activity</h2><span class="grow"></span><a class="tag" href="/audit">View all</a></div>${feed(audit, allGroups)}</div>
<div class="card"><div class="ch"><h2>Channels</h2></div><div class="list">${overview.channels.map((c) => `<div class="li"><span class="grow">${esc(c.name)}</span><span class="muted">→</span><span class="tag">${esc(c.branch)}</span></div>`).join("")}</div>
<div class="toolbar"><form method="post" action="/actions/channel"><input name="channel" placeholder="channel" required style="width:96px"><input name="branch" placeholder="branch" required style="width:96px"><button>Point</button></form></div></div>
</div></div>`;
  return page("Overview", actor, body, "/", host);
}

async function groupPage(store: Store, actor: string, id: string, host: string, flash = ""): Promise<Response> {
  const group = await store.group(id);
  if (!group) return page("Not found", actor, `<h1>Release not found</h1>`, "", host);
  const [allMetrics, channels] = await Promise.all([store.metrics(group.branch, null, 50), store.listChannels()]);
  const metrics = allMetrics.filter((m) => m.groupId === id);
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  const paused = group.updates.every((u) => u.paused);
  const bundle = group.kind === "bundle";
  const targets = [...new Set(channels.map((c) => c.branch))].filter((b) => b !== group.branch);
  const card = (platform: string, label: string, color: string) => {
    const m = metrics.find((x) => x.platform === platform);
    if (!m) return `<div class="card pcard"><div class="t"><b>${label}</b><div class="big muted">—</div><small>Not part of this release</small></div></div>`;
    return `<div class="card pcard">${ring(pct(m.running, m.population), 84, color)}<div class="t"><b>${label}</b><div class="big num">${num(m.running)}</div><small>running of ${num(m.population)} eligible · ${num(m.served)} served · <span class="${m.failed ? "bad" : ""}">${num(m.failed)} failed</span></small></div></div>`;
  };
  const control = (title: string, text: string, body: string) => `<div class="ctl"><b>${title}</b><p>${text}</p>${body}</div>`;
  const hidden = `<input type="hidden" name="groupId" value="${esc(group.id)}">`;
  const next = Math.min(100, rollout < 100 ? Math.max(rollout * 2, rollout + 10) : 100);
  const controls = bundle
    ? [
        control("Rollout", rollout < 100 ? `Now on ${rollout}% of eligible devices. Rollouts only grow; roll back to withdraw.` : "Fully rolled out to every eligible device.",
          rollout < 100 ? `<form method="post" action="/actions/rollout">${hidden}<div class="suffix"><input name="percent" type="number" min="${rollout + 1}" max="100" value="${next}"><span>%</span></div><button class="primary">Increase</button></form><form method="post" action="/actions/rollout">${hidden}<input type="hidden" name="percent" value="100"><button>Go to 100%</button></form>` : `<div class="track" style="height:8px"><i style="width:100%;background:linear-gradient(90deg,var(--accent2),var(--accent))"></i></div>`),
        control(paused ? "Paused" : "Pause", paused ? "New devices are not offered this release. Devices already on it keep it." : "Stop offering this release to new devices. Devices already on it keep it.",
          `<form method="post" action="/actions/${paused ? "resume" : "pause"}">${hidden}<button class="${paused ? "primary" : "danger"}">${paused ? "Resume rollout" : "Pause rollout"}</button></form>`),
        control("Promote", "Republish these exact bundles on another branch, at 100%.",
          targets.length ? `<form method="post" action="/actions/promote">${hidden}<select name="branch">${targets.map((b) => `<option>${esc(b)}</option>`).join("")}</select><button>Promote</button></form>` : `<p class="muted" style="margin:0">No other branch yet.</p>`),
        control("Preview on a device", "A signed, expiring QR code that runs this release on one phone, whatever the rollout says.",
          `<form method="post" action="/actions/preview">${hidden}<select name="ttlMinutes"><option value="15">15 minutes</option><option value="60" selected>1 hour</option><option value="1440">24 hours</option><option value="10080">7 days</option></select><button>Create QR code</button></form>`),
      ].join("")
    : control("Rollback release", "This release sends devices back to the JavaScript embedded in their binary.", "");
  const body = `${flash}<div class="top"><div><div class="crumb"><a href="/">Overview</a> · ${esc(group.branch)}</div><h1>${esc(group.message || "(no message)")}</h1>
<p class="sub">${rolloutChip(group)}&nbsp; Published ${esc(since(group.createdAt))} by ${esc(actorName(group.actor))}</p></div></div>
<div class="grid"><div class="stack"><div class="platforms" style="margin:0">${card("ios", "iOS", "var(--ios)")}${card("android", "Android", "var(--android)")}</div>
<div class="card"><div class="ch"><h2>Details</h2></div><dl>
<dt>Release</dt><dd class="mono">${esc(group.id)}</dd><dt>Branch</dt><dd>${esc(group.branch)}</dd><dt>Kind</dt><dd>${group.kind === "bundle" ? "JavaScript bundle" : "Rollback to embedded"}</dd>
<dt>Rollout</dt><dd>${paused ? "paused" : `${rollout}%`}</dd>${group.gitCommit ? `<dt>Commit</dt><dd class="mono">${esc(group.gitCommit)}</dd>` : ""}
${group.sourceGroupId ? `<dt>Copied from</dt><dd><a class="mono" href="/groups/${esc(group.sourceGroupId)}">${esc(group.sourceGroupId)}</a></dd>` : ""}
<dt>Runtimes</dt><dd>${group.updates.map((u) => `${u.platform === "ios" ? "iOS" : "Android"} <span class="mono">${esc(u.runtimeVersion.slice(0, 12))}</span>`).join(" · ")}</dd></dl></div></div>
<div class="card"><div class="ch"><h2>Controls</h2></div>${controls}</div></div>`;
  return page(group.message || "Release", actor, body, "", host);
}

async function auditPage(store: Store, actor: string, host: string): Promise<Response> {
  const entries = await store.auditLog(200);
  const names = new Map<string, string>();
  for (const id of new Set(entries.map((e) => e.target).filter((t): t is string => !!t && /^[0-9a-f-]{36}$/.test(t)))) {
    const group = await store.group(id);
    if (group) names.set(id, group.message || id.slice(0, 8));
  }
  const detail = (d: Record<string, unknown> | null) =>
    d ? Object.entries(d).filter(([k]) => k !== "message").map(([k, v]) => `<span class="kv">${esc(k)} <b>${esc(String(v))}</b></span>`).join("") : "";
  const rows = entries
    .map((e) => {
      const [cls, verb] = ACTIONS[e.action] ?? ["", e.action];
      const target = e.target ? names.get(e.target) ?? e.target.slice(0, 8) : "";
      return `<tr><td class="num" style="white-space:nowrap;color:var(--muted)">${esc(e.at.replace("T", " ").slice(0, 16))}</td><td style="white-space:nowrap"><b style="color:var(--fg);font-weight:600">${esc(actorName(e.actor))}</b></td>
<td style="white-space:nowrap"><span class="ev"><span class="ic ${cls}" style="width:22px;height:22px;border-radius:7px"><i></i></span></span> ${esc(verb)}</td><td>${names.has(e.target ?? "") ? `<a href="/groups/${esc(e.target)}"><b style="color:var(--fg);font-weight:550">${esc(target)}</b></a>` : `<span class="mono">${esc(target)}</span>`}</td><td>${detail(e.details)}</td></tr>`;
    })
    .join("");
  return page("Audit log", actor, `<div class="top"><div><div class="crumb">Workspace · Audit log</div><h1>Audit log</h1><p class="sub">Every publish, rollout, rollback, channel, preview and token change, with who did it.</p></div></div>
<div class="card"><table><tr><th>When (UTC)</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr>${rows || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}</table></div>`, "/audit", host);
}

async function tokensPage(store: Store, actor: string, host: string, flash = ""): Promise<Response> {
  const rows = (await store.listTokens())
    .map((t) => `<tr><td><b style="color:var(--fg);font-weight:600">${esc(t.name)}</b></td><td><span class="chip ${t.scope === "admin" ? "back" : t.scope === "publish" ? "roll" : "live"}">${esc(t.scope)}</span></td><td>${esc(t.createdAt.slice(0, 10))}</td><td>${esc(t.lastUsedAt ? since(t.lastUsedAt) : "never")}</td>
<td style="text-align:right">${t.revokedAt ? '<span class="muted">revoked</span>' : `<form method="post" action="/actions/token-revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="danger ghost">Revoke</button></form>`}</td></tr>`)
    .join("");
  return page("Tokens", actor, `${flash}<div class="top"><div><div class="crumb">Workspace · Tokens</div><h1>Tokens</h1><p class="sub"><b>read</b> sees metrics · <b>publish</b> uploads and publishes (CI) · <b>admin</b> changes rollouts, rollbacks, channels, previews and tokens.</p></div></div>
<div class="card"><table><tr><th>Name</th><th>Scope</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="5" class="empty">No tokens yet.</td></tr>'}</table>
<div class="toolbar"><form method="post" action="/actions/token-create"><input name="name" placeholder="Name, e.g. github-actions" required pattern="[\\w .@:-]{1,64}" style="width:240px"><select name="scope">${SCOPES.map((s) => `<option${s === "publish" ? " selected" : ""}>${s}</option>`).join("")}</select><button class="primary">Create token</button></form></div></div>`, "/tokens", host);
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
  const host = url.hostname;
  try {
    if (request.method === "GET") {
      if (url.pathname === "/") return await overviewPage(store, actor, host);
      const groupMatch = /^\/groups\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (groupMatch) return await groupPage(store, actor, groupMatch[1]!, host);
      if (url.pathname === "/audit") return await auditPage(store, actor, host);
      if (url.pathname === "/tokens") return await tokensPage(store, actor, host);
      return page("Not found", actor, `<h1>Not found</h1>`, "", host);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    // Forms are only accepted from the dashboard itself: same Origin, or (when a browser withholds
    // Origin) a Fetch Metadata header saying the request comes from this site.
    const sameOrigin = request.headers.get("origin") === url.origin || request.headers.get("sec-fetch-site") === "same-origin";
    if (!sameOrigin) return new Response("Cross-origin request refused.", { status: 403 });
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
        const flash = `<div class="flash"><div class="qr">${qrSvg(preview.deepLink)}</div><div><h2 style="margin:0 0 6px;font-size:16px">Preview link ready</h2>
<p class="sub" style="margin:0 0 10px">Scan with a device whose build declares the <code>flare-preview</code> header. Expires in ${Math.round((Date.parse(preview.expiresAt) - Date.now()) / 60_000)} min (${esc(preview.expiresAt.slice(0, 16).replace("T", " "))} UTC).</p><code>${esc(preview.deepLink)}</code></div></div>`;
        return await groupPage(store, actor, f.groupId ?? "", host, flash);
      }
      case "/actions/token-create": {
        const scope = (f.scope ?? "") as Scope;
        if (!SCOPES.includes(scope)) throw new Invalid("Unknown scope.");
        const created = await services.createToken(f.name ?? "", scope, actor);
        return await tokensPage(store, actor, host, `<div class="flash"><div><h2 style="margin:0 0 6px;font-size:16px">New ${esc(scope)} token: ${esc(f.name)}</h2><p class="sub" style="margin:0 0 10px">Copy it now. Only its hash is stored, so it cannot be shown again.</p><code style="color:var(--fg)">${esc(created.token)}</code></div></div>`);
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
    return page("Error", actor, `<div class="flash bad"><div><h2 style="margin:0 0 6px;font-size:16px">That did not work</h2><p class="sub" style="margin:0">${esc(message)}</p></div></div><a class="tag" href="/">Back to overview</a>`, "", host);
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}
