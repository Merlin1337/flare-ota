// Server-rendered dashboard, served only on DASHBOARD_HOST after Cloudflare Access (verified in
// app.ts). No JavaScript: charts are inline SVG, mutations are plain form POSTs with an Origin
// check, attributed to the Access user.

import { SCOPES, isPlatform, type AppIdentity, type AuditEntry, type GroupSummary, type Scope, type UpdateMetrics } from "@flare-ota/core";
import qrcode from "qrcode-generator";
import { JAKARTA_WOFF2 } from "./fonts.ts";
import type { Principal } from "./auth.ts";
import type { Env } from "./env.ts";
import { errorResponse } from "./errors.ts";
import { Invalid, type Services } from "./services.ts";
import type { Store } from "./store.ts";

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
@font-face{font-family:"Jakarta";src:url(/_fonts/jakarta.woff2) format("woff2");font-weight:200 800;font-display:swap}
:root{color-scheme:dark;--bg:#050506;--panel:rgba(255,255,255,.028);--panel2:rgba(255,255,255,.045);--solid:#0c0c0e;--raise:rgba(255,255,255,.06);--line:rgba(255,255,255,.07);--line2:rgba(255,255,255,.12);
--fg:#f6f3ef;--fg2:#c9c3bc;--muted:#857e77;--faint:#4f4a45;--accent:#ff7a1a;--accent2:#ffb547;--accentInk:#1a0b02;--glow:rgba(255,122,26,.22);
--ok:#3ddc97;--okBg:rgba(61,220,151,.10);--bad:#ff6b6b;--badBg:rgba(255,107,107,.10);--warn:#ffb547;--warnBg:rgba(255,181,71,.11);--ios:#8b9cff;--android:#3ddc97;
--font:"Jakarta",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"SF Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f6f4f1;--panel:rgba(255,255,255,.75);--panel2:#ffffff;--solid:#ffffff;--raise:rgba(20,16,12,.05);--line:rgba(20,16,12,.08);--line2:rgba(20,16,12,.14);
--fg:#140f0b;--fg2:#3b342e;--muted:#7a716a;--faint:#b4aca5;--accent:#f0620b;--accent2:#f59e0b;--accentInk:#fff;--glow:rgba(240,98,11,.14);
--ok:#0f9d63;--okBg:#e7f6ef;--bad:#d93636;--badBg:#fcebeb;--warn:#c26a00;--warnBg:#fdf1de;--ios:#5568f5;--android:#0f9d63}}
*{box-sizing:border-box}html,body{margin:0}
body{min-height:100vh;font:15px/1.5 var(--font);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;
background-image:radial-gradient(1100px 620px at 92% -8%,rgba(255,122,26,.20),transparent 60%),radial-gradient(800px 500px at 20% 110%,rgba(255,181,71,.07),transparent 60%);background-attachment:fixed}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(rgba(255,255,255,.07) 1px,transparent 1.2px);background-size:24px 24px;
-webkit-mask-image:radial-gradient(900px 520px at 85% 0%,#000,transparent 70%);mask-image:radial-gradient(900px 520px at 85% 0%,#000,transparent 70%)}
a{color:inherit;text-decoration:none}
.num{font-variant-numeric:tabular-nums}
code,.mono{font:12px/1.4 var(--mono);color:var(--muted)}
.app{position:relative;display:grid;grid-template-columns:272px minmax(0,1fr);gap:8px;min-height:100vh;padding:16px}
aside{position:sticky;top:16px;height:calc(100vh - 32px);display:flex;flex-direction:column;padding:22px 16px;border:1px solid var(--line);border-radius:26px;
background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.012));backdrop-filter:blur(18px)}
.brand{display:flex;align-items:center;gap:12px;padding:2px 10px 26px;font-weight:750;font-size:21px;letter-spacing:-.035em}
.brand .mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#3a1a07,#120804);border:1px solid rgba(255,122,26,.4);box-shadow:0 10px 30px -8px rgba(255,122,26,.7),inset 0 1px 0 rgba(255,255,255,.08)}
.brand .mark svg{width:21px;height:21px}
nav{display:grid;gap:4px}
nav a{position:relative;display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:14px;color:var(--fg2);font-weight:550;font-size:15px;transition:background .2s,color .2s}
nav a svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.7}
nav a:hover{color:var(--fg);background:var(--raise)}
nav a.on{color:var(--fg);background:linear-gradient(90deg,rgba(255,122,26,.14),rgba(255,122,26,.02) 75%)}
nav a.on::before{content:"";position:absolute;left:-1px;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--accent)}
nav a.on svg{stroke:var(--accent)}
.status{margin-top:22px;padding:14px;border-radius:16px;border:1px solid var(--line);background:var(--panel)}
.status b{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:650}.status small{display:block;color:var(--muted);font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--okBg)}
.dot.live{animation:pulse 2.4s ease-in-out infinite}@keyframes pulse{50%{box-shadow:0 0 0 6px transparent}}
.me{margin-top:auto;display:flex;align-items:center;gap:12px;padding:12px;border-radius:16px;border:1px solid var(--line);background:var(--panel)}
.avatar{width:36px;height:36px;flex:none;border-radius:50%;display:grid;place-items:center;font-weight:750;font-size:14px;color:var(--accentInk);background:linear-gradient(135deg,var(--accent2),var(--accent))}
.me small{display:block;color:var(--muted);font-size:12px}.me div span{display:block;font-size:13.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
main{position:relative;overflow:clip;padding:10px 26px 60px;max-width:1380px;width:100%}
.topbar{display:flex;align-items:center;gap:14px;margin-bottom:34px}
.search{position:relative;flex:0 1 420px}.search svg{position:absolute;left:16px;top:50%;transform:translateY(-50%);width:17px;height:17px;stroke:var(--muted);fill:none;stroke-width:2}
.search input{width:100%;height:46px;padding:0 18px 0 44px;border-radius:15px;font-size:14.5px}
.grow{flex:1}
.livepill{display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:550;color:var(--fg2);height:40px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--panel);backdrop-filter:blur(10px)}
.crumb{font-size:13px;color:var(--muted);margin-bottom:10px;font-weight:550}
h1{margin:0;font-weight:750;font-size:30px;line-height:1.1;letter-spacing:-.035em}
.display{font-size:58px;line-height:1.02;letter-spacing:-.05em;font-weight:780}.display.sm{font-size:44px}
.grad{background:linear-gradient(100deg,var(--accent) 10%,var(--accent2) 90%);-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:17px;color:var(--fg2);margin:14px 0 0;max-width:720px}
.sub{color:var(--muted);margin:8px 0 0}
.top{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:26px}
.card{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015));border:1px solid var(--line);border-radius:22px;backdrop-filter:blur(14px)}
@media (prefers-color-scheme:light){.card{background:var(--panel2);box-shadow:0 1px 2px rgba(20,16,12,.04),0 18px 40px -26px rgba(20,16,12,.25)}aside{background:rgba(255,255,255,.6)}}
.stats{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:14px;margin:34px 0 30px}
.stat{position:relative;overflow:hidden;padding:20px 22px}
.stat .l{font-size:13px;color:var(--muted);font-weight:600}
.stat .v{font-weight:760;font-size:38px;letter-spacing:-.045em;line-height:1.05;margin-top:12px;font-variant-numeric:tabular-nums}
.stat .h{font-size:13px;color:var(--muted);margin-top:6px}.stat .h b{color:var(--fg2);font-weight:650}
.stat.hero{padding-bottom:60px;border-color:rgba(255,122,26,.25);background:radial-gradient(130% 120% at 100% 0%,rgba(255,122,26,.16),transparent 55%),linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015))}
.stat .spark{position:absolute;left:0;bottom:0;width:100%;height:58px}
.ringrow{display:flex;align-items:center;gap:14px;margin-top:12px}.ringrow .t{font-size:13px;color:var(--muted);line-height:1.4;min-width:0}.ringrow .t b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--fg);font-weight:650;font-size:14px}
.bad{color:var(--bad)}.ok{color:var(--ok)}
.tabs{display:inline-flex;gap:4px;padding:5px;border:1px solid var(--line);border-radius:18px;background:var(--panel);margin-bottom:18px}
.tabs a{display:inline-flex;align-items:center;gap:8px;padding:11px 22px;border-radius:13px;font-weight:650;font-size:14.5px;color:var(--muted);transition:color .2s}
.tabs a:hover{color:var(--fg)}.tabs a span{font-size:12px;padding:1px 8px;border-radius:99px;background:var(--raise);color:var(--muted)}
.tabs a.on{color:var(--fg);background:var(--raise);box-shadow:inset 0 0 0 1px var(--line2)}
.tabs a.on span{background:var(--accent);color:var(--accentInk)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:18px;align-items:start}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px}
.rcard{display:flex;flex-direction:column;gap:18px;padding:20px;transition:transform .25s,border-color .25s}
.rcard:hover{transform:translateY(-2px)}
.rcard.roll{border-color:rgba(255,181,71,.45);background:radial-gradient(120% 80% at 50% 0%,rgba(255,181,71,.10),transparent 60%),linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015))}
.rcard.live{border-color:rgba(61,220,151,.22)}.rcard.back{border-color:rgba(255,107,107,.35)}.rcard.paused{opacity:.82}
.rhead{display:flex;align-items:flex-start;gap:14px}
.rav{position:relative;width:46px;height:46px;flex:none;border-radius:50%;display:grid;place-items:center;font-weight:750;font-size:18px;background:var(--raise);border:1px solid var(--line2)}
.rav i{position:absolute;right:-2px;bottom:-2px;width:16px;height:16px;border-radius:50%;border:3px solid var(--solid);background:var(--ok)}
.roll .rav i{background:var(--warn)}.back .rav i{background:var(--bad)}.paused .rav i{background:var(--muted)}
.rhead h3{margin:0;font-size:17px;font-weight:700;letter-spacing:-.02em;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rhead small{display:block;margin-top:4px;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rhead .grow{min-width:0}
.badge{flex:none;font-size:12.5px;font-weight:750;padding:5px 11px;border-radius:10px;border:1px solid var(--line2);color:var(--fg2);background:var(--raise)}
.roll .badge{color:var(--warn);border-color:rgba(255,181,71,.4);background:var(--warnBg)}.live .badge{color:var(--ok);border-color:rgba(61,220,151,.3);background:var(--okBg)}.back .badge{color:var(--bad);border-color:rgba(255,107,107,.35);background:var(--badBg)}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.plat{padding:12px 14px;border-radius:16px;background:var(--panel);border:1px solid var(--line)}
.plat{min-width:0}.plat .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12.5px;color:var(--muted);font-weight:600;white-space:nowrap}.plat .row span:last-child{overflow:hidden;text-overflow:ellipsis;font-weight:550}
.plat .pv{font-size:26px;font-weight:760;letter-spacing:-.04em;color:var(--fg);margin:2px 0 10px;font-variant-numeric:tabular-nums}
.plat.ios .pv{color:var(--ios)}.plat.android .pv{color:var(--android)}
.track{height:6px;border-radius:99px;background:var(--raise);overflow:hidden}.track i{display:block;height:100%;border-radius:99px}
.ios .track i,.track.ios i{background:var(--ios)}.android .track i,.track.android i{background:var(--android)}
.kv4{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.kv4 div{font-size:12px;color:var(--muted);font-weight:600}.kv4 b{display:block;font-size:17px;color:var(--fg);font-weight:720;letter-spacing:-.02em;margin-top:2px;font-variant-numeric:tabular-nums}
.kv4 b.bad{color:var(--bad)}
.ract{display:flex;gap:10px}.ract>*{flex:1}.ract form{display:flex}.ract form button,.ract a{width:100%;justify-content:center}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
.chip::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.live{background:var(--okBg);color:var(--ok)}.chip.roll{background:var(--warnBg);color:var(--warn)}.chip.paused{background:var(--raise);color:var(--muted)}.chip.back{background:var(--badBg);color:var(--bad)}
.ch{display:flex;align-items:center;gap:10px;padding:20px 22px 12px}.ch h2{margin:0;font-size:16.5px;font-weight:720;letter-spacing:-.02em}.ch small{color:var(--muted)}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:650;padding:4px 10px;border-radius:10px;background:var(--raise);color:var(--fg2);border:1px solid var(--line)}
.empty{padding:34px 22px;color:var(--muted);text-align:center}
.fleet{padding:6px 22px 20px;display:flex;align-items:center;gap:20px}
.legend{display:grid;gap:12px;flex:1}.legend div{display:flex;align-items:center;gap:9px;font-size:14px;color:var(--fg2);font-weight:550}.legend b{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--fg);font-weight:720}
.sw{width:10px;height:10px;border-radius:4px}
.list{padding:0 22px 16px}.li{display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px solid var(--line);font-size:13.5px}.li:first-child{border-top:0}
.li .grow{min-width:0}.li .mini{width:84px}
.feed{padding:2px 22px 14px}.ev{display:flex;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.ev:first-child{border-top:0}
.ev .ic{width:30px;height:30px;flex:none;border-radius:10px;display:grid;place-items:center;background:var(--raise);border:1px solid var(--line)}
.ev .ic i{width:8px;height:8px;border-radius:50%;background:var(--muted)}.ev .ic.pub i{background:var(--accent)}.ev .ic.roll i{background:var(--warn)}.ev .ic.back i{background:var(--bad)}.ev .ic.ok i{background:var(--ok)}
.ev p{margin:0;font-size:13.5px;color:var(--fg2);line-height:1.45}.ev p b{color:var(--fg);font-weight:650}.ev small{color:var(--muted);font-size:12px}
form{display:inline-flex;gap:8px;align-items:center;margin:0}
input,select,button,.btn{font:inherit;font-size:13.5px;height:40px;padding:0 14px;border:1px solid var(--line2);border-radius:12px;background:var(--panel);color:var(--fg)}
input::placeholder{color:var(--muted)}
select{-webkit-appearance:none;appearance:none;padding-right:36px;cursor:pointer;background-repeat:no-repeat;background-position:right 13px center;background-size:12px;
background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23a39b93' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")}
input:focus,select:focus{outline:none;border-color:rgba(255,122,26,.55);box-shadow:0 0 0 3px rgba(255,122,26,.12)}
button,.btn{display:inline-flex;align-items:center;gap:8px;white-space:nowrap;cursor:pointer;font-weight:650;background:var(--raise);transition:transform .15s,box-shadow .2s,border-color .2s}
button:hover,.btn:hover{border-color:var(--faint)}button:active{transform:translateY(1px)}
.btn svg,button svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.9}
.primary{background:var(--accent);border-color:transparent;color:var(--accentInk);box-shadow:inset 0 1px 0 rgba(255,255,255,.22)}
.primary:hover{background:#ff8a35;border-color:transparent}
.danger{color:var(--bad)}.ghost{background:transparent}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;padding:16px 22px;border-top:1px solid var(--line)}
.flash{display:flex;gap:24px;align-items:center;padding:22px;margin-bottom:22px;border:1px solid rgba(255,122,26,.4);background:radial-gradient(120% 140% at 0% 0%,var(--glow),transparent 60%),var(--panel);border-radius:22px;word-break:break-all}
.flash.bad{border-color:rgba(255,107,107,.4)}
.qr svg{width:190px;height:190px;background:#fff;border-radius:16px;padding:8px;display:block}
.platforms{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pcard{padding:22px;display:flex;gap:20px;align-items:center}.pcard .t b{display:block;font-size:13px;color:var(--muted);font-weight:650}.pcard .t .big{font-size:34px;font-weight:760;letter-spacing:-.045em;margin:4px 0;font-variant-numeric:tabular-nums}.pcard .t small{color:var(--muted)}
.ctl{padding:18px 22px;border-top:1px solid var(--line)}.ctl b{display:block;font-size:14.5px;font-weight:700}.ctl p{margin:4px 0 14px;color:var(--muted);font-size:13px;line-height:1.5}
.ctl form+form{margin-left:6px}.suffix{position:relative;display:inline-flex}.suffix input{width:96px;padding-right:30px}.suffix span{position:absolute;right:13px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:13px}
.kv{display:inline-flex;gap:5px;font-size:12px;color:var(--muted);padding:3px 9px;margin:2px 6px 2px 0;border-radius:8px;background:var(--raise)}.kv b{color:var(--fg2);font-weight:650}
td .ev{display:inline-flex;padding:0;border:0;vertical-align:middle;margin-right:6px}
dl{display:grid;grid-template-columns:130px 1fr;gap:12px 18px;margin:0;padding:6px 22px 22px;font-size:14px}dt{color:var(--muted);font-weight:550}dd{margin:0;color:var(--fg2)}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);padding:14px 22px;border-bottom:1px solid var(--line)}
td{padding:15px 22px;border-top:1px solid var(--line);color:var(--fg2);vertical-align:middle}tr:first-child+tr td{border-top:0}tr:hover td{background:rgba(255,255,255,.015)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:18px;align-items:start}
.stack{display:grid;gap:18px;align-content:start}
.flare{position:absolute;right:-40px;top:-120px;width:700px;height:460px;pointer-events:none}
dialog.modal{width:min(560px,calc(100vw - 32px));padding:0;border:1px solid var(--line2);border-radius:24px;background:var(--solid);color:var(--fg);box-shadow:0 40px 120px -20px rgba(0,0,0,.8)}
dialog.modal::backdrop{background:rgba(5,5,6,.6);backdrop-filter:blur(6px)}
dialog.modal[open]{animation:pop .18s ease-out}@keyframes pop{from{opacity:0;transform:translateY(6px) scale(.98)}}
.modal .in{padding:26px}.modal h2{margin:0 0 6px;font-size:21px;font-weight:750;letter-spacing:-.03em}
.choice{display:block;position:relative;margin-top:12px;padding:16px 16px 16px 46px;border-radius:16px;border:1px solid var(--line2);background:var(--panel);cursor:pointer}
.choice input{position:absolute;left:16px;top:18px;width:18px;height:18px;margin:0;padding:0;-webkit-appearance:none;appearance:none;border-radius:50%;border:1.5px solid var(--line2);background:var(--panel2);cursor:pointer;transition:border-color .15s}.choice input:checked{border-color:var(--accent);background:radial-gradient(circle,var(--accent) 0 4px,transparent 4.6px),var(--panel2)}.choice input:focus{outline:none}.choice input:focus-visible{box-shadow:0 0 0 3px rgba(255,122,26,.28)}.choice input:disabled{opacity:.4;cursor:not-allowed}.modal h2:focus{outline:none}
.choice:has(input:checked){border-color:rgba(255,122,26,.55);background:linear-gradient(180deg,rgba(255,122,26,.08),transparent)}
.choice b{display:block;font-size:14.5px}.choice small{display:block;color:var(--muted);font-size:12.5px;margin-top:2px}
.choice ul{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:6px}.choice li{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--fg2)}
.modal .acts{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}
.appcard{display:flex;align-items:center;gap:12px;margin:0 2px 22px;padding:12px;border-radius:18px;border:1px solid var(--line);background:var(--panel)}
.appcard img,.appcard .ph{width:44px;height:44px;flex:none;border-radius:12px;object-fit:cover;background:var(--raise);border:1px solid var(--line2)}
.appcard .ph{display:grid;place-items:center;font-weight:750;font-size:18px;color:var(--fg2)}
.appcard b{display:block;font-size:15px;font-weight:720;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.appcard small{display:block;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.appcard>div{min-width:0}
.codebox{position:relative}.codebox pre.cmd{padding-right:44px}
.copy{position:absolute;top:7px;right:7px;width:30px;height:30px;padding:0;justify-content:center;border-radius:9px;background:var(--panel2);color:var(--muted)}
.copy:hover{color:var(--fg)}.copy svg{width:15px;height:15px;stroke-width:1.8}.copy .i-done{display:none}.copy.done{color:var(--ok);border-color:rgba(61,220,151,.45)}.copy.done .i-copy{display:none}.copy.done .i-done{display:block}
.help{display:inline-flex;width:15px;height:15px;margin-left:5px;vertical-align:-2px;color:var(--muted);cursor:help}.help:hover{color:var(--fg2)}.help svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round}
.onboard{padding:24px 26px;margin:30px 0 8px;border-color:rgba(255,122,26,.35);background:radial-gradient(120% 140% at 0% 0%,rgba(255,122,26,.12),transparent 55%),linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.015))}
.onboard header{display:flex;align-items:center;gap:16px;margin-bottom:18px}.onboard h2{margin:0;font-size:20px;font-weight:750;letter-spacing:-.025em}.onboard header p{margin:3px 0 0;color:var(--muted);font-size:14px}
.progress{margin-left:auto;min-width:170px;text-align:right;font-size:13px;color:var(--muted);font-weight:600}.progress .track{margin-top:8px;height:7px}.progress .track i{background:var(--accent)}
.steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.step{padding:16px;border-radius:18px;border:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;gap:10px;min-width:0}
.step.done{opacity:.6}.step.next{border-color:rgba(255,122,26,.5)}
.step .n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-weight:750;font-size:13px;background:var(--raise);border:1px solid var(--line2)}
.step.done .n{background:var(--okBg);color:var(--ok);border-color:rgba(61,220,151,.4)}.step.next .n{background:var(--accent);color:var(--accentInk);border:0}
.step b{font-size:14.5px;font-weight:700}.step p{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5}
pre.cmd{margin:0;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.35);border:1px solid var(--line);font:12px/1.55 var(--mono);color:var(--fg2);white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere}
@media (prefers-color-scheme:light){pre.cmd{background:#f3f0ec}}
pre.cmd .c{color:var(--muted)}pre.cmd .p{color:var(--accent)}
.alert{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:var(--badBg);border:1px solid rgba(255,107,107,.3);color:var(--bad);font-size:12.5px;font-weight:600}
.alert span{flex:1}.alert button{height:32px;font-size:12.5px}
.confirm{max-width:720px;padding:26px}.confirm h2{margin:0 0 6px;font-size:22px;font-weight:750;letter-spacing:-.03em}.confirm .targets{display:grid;gap:10px;margin:18px 0 22px}
.confirm .t{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:16px;background:var(--panel);border:1px solid var(--line)}.confirm .t b{display:block}.confirm .t small{color:var(--muted)}
.confirm .acts{display:flex;gap:10px}
@media (max-width:1180px){.steps{grid-template-columns:1fr 1fr}}
@media (max-width:1180px){.stats{grid-template-columns:1fr 1fr}.layout,.grid{grid-template-columns:1fr}}
@media (max-width:760px){.app{grid-template-columns:minmax(0,1fr);padding:10px;gap:4px}main{min-width:0}nav{overflow-x:auto;max-width:100%}aside{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 14px;border-radius:20px}.brand{padding:0;font-size:18px}.brand .mark{width:32px;height:32px}.appcard{order:3;flex-basis:100%;margin:0}nav{display:flex;margin-left:auto;gap:2px}nav a{padding:8px 10px;font-size:13.5px;gap:8px}nav a svg{display:none}nav a.on::before{display:none}.status,.me{display:none}main{padding:14px 2px 40px}.topbar{margin-bottom:20px}.livepill{display:none}.search{flex:1}.display{font-size:40px}.lead{font-size:15px}.stats{grid-template-columns:1fr;margin:22px 0}.cards{grid-template-columns:minmax(0,1fr)}.platforms,.duo{grid-template-columns:1fr 1fr}.flare{display:none}.tabs{max-width:100%}.tabs a{padding:10px 14px}table{display:block;overflow-x:auto}.steps{grid-template-columns:1fr}.top{flex-direction:column;align-items:flex-start}.layout,.grid{grid-template-columns:minmax(0,1fr)}}`;

const FLAME = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="fl" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff7a1a"/><stop offset="1" stop-color="#ffc56b"/></linearGradient></defs><path fill="url(#fl)" d="M12.6 2.2c.4 3-1.3 4.6-2.8 6.2C8.2 10 6.6 11.7 6.6 14.6A5.4 5.4 0 0 0 12 20a5.4 5.4 0 0 0 5.4-5.4c0-2.2-1-3.7-2.1-5 .1 1.5-.4 2.7-1.6 3.4.4-3.9-.4-7.6-1.1-10.8z"/></svg>`;
const ICON = {
  overview: `<svg viewBox="0 0 24 24"><path d="M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-4H4z"/></svg>`,
  tokens: `<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/></svg>`,
  audit: `<svg viewBox="0 0 24 24"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="8.5"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  open: `<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>`,
  up: `<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  qr: `<svg viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></svg>`,
};

// Concentric arcs behind the page title: the "flare".
const FLARE_ART = `<svg class="flare" viewBox="0 0 640 420" aria-hidden="true"><defs><radialGradient id="fg" cx="70%" cy="20%" r="75%"><stop offset="0" stop-color="#ffb547" stop-opacity=".75"/><stop offset="1" stop-color="#ff7a1a" stop-opacity="0"/></radialGradient></defs>
<g fill="none" stroke="url(#fg)">${[60, 110, 165, 225, 290, 360].map((r, i) => `<circle cx="450" cy="90" r="${r}" stroke-width="${1.6 - i * 0.18}" stroke-dasharray="${i % 2 ? "2 6" : "none"}"/>`).join("")}</g>
<circle cx="450" cy="90" r="5" fill="#ffb547"/><circle cx="450" cy="90" r="18" fill="#ff7a1a" opacity=".25"/></svg>`;


// The dashboard's only script, served from the Worker itself (CSP script-src 'self'): copy buttons.
const UI_JS = `{const c=document.body&&document.body.dataset.canonical;if(c)history.replaceState(null,"",c)}document.addEventListener("click",async(e)=>{const o=e.target.closest("[data-dialog]");if(o){const d=document.getElementById(o.dataset.dialog);if(d&&d.showModal){e.preventDefault();d.showModal();return}}if(e.target.tagName==="DIALOG"){e.target.close();return}const b=e.target.closest("[data-copy]");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.copy);b.classList.add("done");b.setAttribute("aria-label","Copied");setTimeout(()=>{b.classList.remove("done");b.setAttribute("aria-label","Copy")},1600)}catch{}});`;

/** Changes whenever UI_JS changes, so browsers never run a stale cached copy. */
const UI_VERSION = [...UI_JS].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7).toString(36);

const COPY_ICONS = `<svg class="i-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg><svg class="i-done" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

/** A code block with a copy button. `text` is what lands in the clipboard; `html` is what is shown. */
function codeBox(text: string, html = esc(text), extraClass = ""): string {
  return `<div class="codebox"><pre class="cmd ${extraClass}">${html}</pre><button type="button" class="copy" data-copy="${esc(text)}" aria-label="Copy" title="Copy">${COPY_ICONS}</button></div>`;
}

let fontBytes: Uint8Array<ArrayBuffer> | null = null;
function fontResponse(): Response {
  fontBytes ??= Uint8Array.from(atob(JAKARTA_WOFF2), (c) => c.charCodeAt(0));
  return new Response(fontBytes, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
}

function page(title: string, actor: string, body: string, active = "", host = "", canonical = ""): Response {
  const who = actor.replace(/^access:/, "");
  const link = (href: string, label: string, icon: string) => `<a href="${href}" class="${active === href ? "on" : ""}">${icon}${label}</a>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · flare-ota</title><link rel="preload" href="/_fonts/jakarta.woff2" as="font" type="font/woff2" crossorigin><style>${STYLE}</style><script src="/_assets/ui.js?v=${UI_VERSION}" defer></script></head><body${canonical ? ` data-canonical="${esc(canonical)}"` : ""}><div class="app">
<aside><a class="brand" href="/"><span class="mark">${FLAME}</span>flare-ota</a><!--app-card-->
<nav>${link("/", "Releases", ICON.overview)}${link("/tokens", "Tokens", ICON.tokens)}${link("/audit", "Audit log", ICON.audit)}</nav>
<div class="status"><b><span class="dot live"></span>All systems normal</b><small>${esc(host || "updates server")}</small></div>
<div class="me"><span class="avatar">${esc((who[0] ?? "?").toUpperCase())}</span><div><span>${esc(who)}</span><small>Signed in with Access</small></div></div></aside>
<main>${body}</main></div></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

function ring(percent: number | null, size = 64, color = "var(--accent)"): string {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const dash = (Math.min(100, Math.max(0, percent ?? 0)) / 100) * c;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" style="flex:none">
<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--raise)" stroke-width="6"/>
${percent ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ""}
<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="var(--fg)" font-size="${size / 4.6}" font-weight="650" font-family="Jakarta,-apple-system,sans-serif">${percent === null ? "—" : `${percent}%`}</text></svg>`;
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

const actorName = (actor: string) => actor.replace(/^(token|access):/, "");

function statusOf(group: GroupSummary): { cls: string; badge: string } {
  if (group.kind === "rollback-embedded") return { cls: "back", badge: "Embedded" };
  if (group.updates.length && group.updates.every((u) => u.paused)) return { cls: "paused", badge: "Paused" };
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  return rollout < 100 ? { cls: "roll", badge: `${rollout}%` } : { cls: "live", badge: "Live" };
}

function platformTile(m: UpdateMetrics | undefined, label: string, cls: string): string {
  if (!m) return `<div class="plat"><div class="row"><span>${label}</span><span>—</span></div><div class="pv" style="color:var(--faint)">—</div><div class="track"></div></div>`;
  const share = pct(m.running, m.population);
  return `<div class="plat ${cls}"><div class="row"><span>${label}</span><span>${m.population ? `${num(m.running)} / ${num(m.population)}` : "no devices"}</span></div><div class="pv">${share}%</div><div class="track"><i style="width:${share}%"></i></div></div>`;
}

function releaseCard(group: GroupSummary, metrics: UpdateMetrics[]): string {
  const of = (platform: string) => metrics.find((m) => m.groupId === group.id && m.platform === platform);
  const mine = metrics.filter((m) => m.groupId === group.id);
  const failed = mine.reduce((sum, m) => sum + m.failed, 0);
  const served = mine.reduce((sum, m) => sum + m.served, 0);
  const running = mine.reduce((sum, m) => sum + m.running, 0);
  const { cls, badge } = statusOf(group);
  const rollout = Math.max(...group.updates.map((u) => u.rolloutPercent));
  const hidden = `<input type="hidden" name="groupId" value="${esc(group.id)}">`;
  const action =
    cls === "roll"
      ? `<form method="post" action="/actions/rollout">${hidden}<input type="hidden" name="percent" value="${Math.min(100, Math.max(rollout * 2, rollout + 10))}"><button class="primary">${ICON.up}Raise to ${Math.min(100, Math.max(rollout * 2, rollout + 10))}%</button></form>`
      : cls === "live"
        ? `<form method="post" action="/actions/preview">${hidden}<input type="hidden" name="ttlMinutes" value="60"><button class="primary">${ICON.qr}Preview</button></form>`
        : "";
  return `<article class="card rcard ${cls}"><div class="rhead"><span class="rav">${esc((group.message || "?").trim()[0]?.toUpperCase() ?? "?")}<i></i></span>
<div class="grow"><h3>${esc(group.message || "(no message)")}</h3><small><span class="mono">${esc(group.id.slice(0, 8))}</span> · ${esc(actorName(group.actor))} · ${esc(since(group.createdAt))}</small></div><span class="badge">${esc(badge)}</span></div>
<div class="duo">${platformTile(of("ios"), "iOS", "ios")}${platformTile(of("android"), "Android", "android")}</div>
<div class="kv4"><div title="Devices running this release right now">Running<b>${num(running)}</b></div><div title="Devices this release was last offered to (downloads in progress included)">Offered<b>${num(served)}</b></div><div title="Devices where this release failed to launch. They are never offered it again.">Failed<b class="${failed ? "bad" : ""}">${num(failed)}</b></div></div>
${failed && cls !== "paused" && cls !== "back" ? `<div class="alert"><span>${num(failed)} device${failed === 1 ? "" : "s"} could not launch this release.</span><form method="post" action="/actions/pause">${hidden}<button class="danger">Pause it</button></form></div>` : ""}
<div class="ract"><a class="btn" href="/groups/${esc(group.id)}">${ICON.open}View details</a>${action}</div></article>`;
}


const help = (text: string) =>
  `<span class="help" title="${esc(text)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M6.1 6.2a1.95 1.95 0 1 1 2.75 1.78c-.52.24-.85.7-.85 1.25v.37"/><circle cx="8" cy="11.55" r=".55" fill="currentColor" stroke="none"/></svg></span>`;

function onboarding(state: { token: boolean; device: boolean; published: boolean }, updatesHost: string): string {
  const url = `https://${updatesHost || "<your-updates-host>"}`;
  const steps = [
    { done: state.token, title: "Create a publish token", text: "For your laptop and CI. flare-ota only stores its hash.", body: `<a class="btn" href="/tokens?new=1">${ICON.tokens}Create token</a>` },
    { done: state.device, title: "Connect your Expo app", text: "Copy <code>certificate.pem</code> printed by setup into <code>certs/</code>, then:", body: codeBox(`npx expo install expo-updates\nnpm i -D flare-ota\nFLARE_OTA_URL=${url} npx flare-ota init`) },
    { done: state.device, title: "Build a release binary", text: "The update URL and certificate live in the binary. Ticks itself when a device checks in.", body: codeBox("npx expo run:ios --configuration Release", `<span class="c"># or EAS Build, Xcode, CI…</span>\nnpx expo run:ios --configuration Release`) },
    { done: state.published, title: "Publish your first update", text: "Change some JavaScript, then ship it. Devices get it on their next launches.", body: codeBox(`npx flare-ota publish --branch production -m "First OTA"`, `<span class="c"># with FLARE_OTA_TOKEN set</span>\nnpx flare-ota publish \\\n  --branch production -m "First OTA"`) },
  ];
  const done = steps.filter((x) => x.done).length;
  const next = steps.findIndex((x) => !x.done);
  return `<section class="card onboard"><header><div><h2>Get your first update out</h2><p>Four steps, about 20 minutes. This panel disappears once updates flow.</p></div>
<div class="progress">${done} of 4 done<div class="track"><i style="width:${(done / 4) * 100}%"></i></div></div></header>
<div class="steps">${steps.map((x, i) => `<div class="step ${x.done ? "done" : i === next ? "next" : ""}"><span class="n">${x.done ? "✓" : i + 1}</span><b>${x.title}</b><p>${x.text}</p>${x.done ? "" : x.body}</div>`).join("")}</div></section>`;
}

function publishPanel(branch: string, updatesHost: string): string {
  return `<div class="card"><div class="ch"><h2>Publish an update</h2>${help("Updates are built from your app's code on your machine or CI, then uploaded here. The dashboard never touches your source.")}</div>
<div style="padding:0 22px 20px">${codeBox(`npx flare-ota publish --branch ${branch} -m "What changed"`, `<span class="c"># in your app's folder</span>\nnpx flare-ota publish \\\n  --branch ${esc(branch)} \\\n  -m "What changed"`)}
<p class="sub" style="font-size:12.5px;margin-top:10px">Needs <span class="mono">FLARE_OTA_TOKEN</span> and <span class="mono">FLARE_OTA_URL=https://${esc(updatesHost || "<updates-host>")}</span>. Add <span class="mono">--rollout 10</span> to start with 10% of devices.</p></div></div>`;
}

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

async function overviewPage(store: Store, env: Env, actor: string, host: string, branchParam: string | null, query: string | null): Promise<Response> {
  const [overview, activity, audit, tokens] = await Promise.all([store.overview(), store.activity(), store.auditLog(6), store.listTokens()]);
  const branches = [...new Set(overview.channels.map((c) => c.branch))].sort((x, y) => (x === "production" ? -1 : y === "production" ? 1 : x.localeCompare(y)));
  const branch = branchParam && branches.includes(branchParam) ? branchParam : branches[0] ?? "production";
  const q = (query ?? "").trim().slice(0, 80);
  const perBranch = await Promise.all(branches.map(async (b) => ({ branch: b, groups: await store.groups(b, 24), metrics: await store.metrics(b, null, 80) })));
  const current = perBranch.find((p) => p.branch === branch) ?? { branch, groups: [], metrics: [] };
  const needle = q.toLowerCase();
  const shown = current.groups.filter((g) => !needle || [g.message, g.id, g.actor, g.gitCommit ?? ""].some((v) => v.toLowerCase().includes(needle)));
  const allGroups = new Map(perBranch.flatMap((p) => p.groups.map((g) => [g.id, g] as const)));
  for (const entry of audit) {
    if (entry.target && /^[0-9a-f-]{36}$/.test(entry.target) && !allGroups.has(entry.target)) {
      const group = await store.group(entry.target);
      if (group) allGroups.set(group.id, group);
    }
  }
  const rolling = perBranch.flatMap((p) => p.groups).filter((g) => g.kind === "bundle" && g.updates.some((u) => u.rolloutPercent < 100 && !u.paused));
  const prod = perBranch.find((p) => p.branch === "production") ?? perBranch[0];
  const live = prod?.groups.find((g) => g.kind === "bundle" && g.updates.every((u) => u.rolloutPercent === 100 && !u.paused));
  const liveMetrics = live ? prod!.metrics.filter((m) => m.groupId === live.id) : [];
  const liveRunning = liveMetrics.reduce((s, m) => s + m.running, 0);
  const livePopulation = liveMetrics.reduce((s, m) => s + m.population, 0);
  const byPlatform = (p: string) => overview.runtimes.filter((r) => r.platform === p).reduce((s, r) => s + r.devices, 0);
  const ios = byPlatform("ios");
  const android = byPlatform("android");
  const hasPublishToken = tokens.some((t) => !t.revokedAt && t.scope === "publish");
  const published = perBranch.some((p) => p.groups.length > 0);
  const setupDone = hasPublishToken && overview.devices.last30d > 0 && published;
  const tabs = branches
    .map((b) => `<a class="${b === branch ? "on" : ""}" href="/?branch=${encodeURIComponent(b)}${q ? `&q=${encodeURIComponent(q)}` : ""}">${esc(b[0]!.toUpperCase() + b.slice(1))}<span>${perBranch.find((p) => p.branch === b)?.groups.length ?? 0}</span></a>`)
    .join("");
  const runtimeRows = overview.runtimes
    .slice(0, 5)
    .map((r) => `<div class="li"><span class="tag">${r.platform === "ios" ? "iOS" : "Android"}</span><span class="grow mono">${esc(r.runtimeVersion.slice(0, 10))}</span><div class="mini track ${r.platform}"><i style="width:${pct(r.devices, overview.devices.last30d)}%"></i></div><span class="num" style="width:52px;text-align:right;font-weight:650">${num(r.devices)}</span></div>`)
    .join("");
  const body = `${FLARE_ART}<div class="topbar"><form class="search" method="get" action="/">${ICON.search}<input type="hidden" name="branch" value="${esc(branch)}"><input name="q" value="${esc(q)}" placeholder="Search releases, commits, authors…" autocomplete="off"></form><span class="grow"></span>
<span class="livepill"><span class="dot live"></span>Live · ${new Date().toISOString().slice(11, 16)} UTC</span></div>
<h1 class="display">Release <span class="grad">control</span></h1>
<p class="lead">Ship JavaScript to every device in minutes. Watch it spread, and roll it back in one click.</p>
${setupDone ? "" : onboarding({ token: hasPublishToken, device: overview.devices.last30d > 0, published }, env.UPDATES_HOST ?? "")}
<div class="stats">
<div class="card stat hero"><div class="l">Active devices · 24 h${help("Installs that checked for an update in the last 24 hours (one check per app launch).")}</div><div class="v">${num(overview.devices.last24h)}</div><div class="h"><b>${num(overview.devices.last30d)}</b> in the last 30 days</div>${sparkline(activity.hourly)}</div>
<div class="card stat"><div class="l">Live in production${help("The newest production release at 100%: the share of eligible devices already running it.")}</div><div class="ringrow">${ring(live ? pct(liveRunning, livePopulation) : null, 66)}<div class="t"><b>${esc(live?.message ?? "Nothing live yet")}</b>${live ? `${num(liveRunning)} of ${num(livePopulation)} devices` : ""}</div></div></div>
<div class="card stat"><div class="l">Rollouts in progress${help("Releases offered to only part of your users. Raise them when the numbers look healthy.")}</div><div class="v" style="color:${rolling.length ? "var(--warn)" : "var(--fg)"}">${rolling.length}</div><div class="h">${rolling.length ? `${esc(rolling[0]!.message)} · <b>${Math.max(...rolling[0]!.updates.map((u) => u.rolloutPercent))}%</b>` : "Everything fully rolled out"}</div></div>
<div class="card stat"><div class="l">Failed launches · 7 d${help("Launches expo-updates reported as failed. Such a device falls back and is never offered that release again.")}</div><div class="v ${activity.failed7d ? "bad" : ""}">${num(activity.failed7d)}</div><div class="h">${activity.failed7d ? "Never re-offered to those devices" : "No launch failures reported"}</div></div></div>
<div class="layout"><div><div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><div class="tabs">${tabs}</div><span class="grow"></span>
${current.groups.length ? `<a class="btn danger" style="margin-bottom:18px" href="/confirm/rollback?branch=${encodeURIComponent(branch)}&to=previous" data-dialog="rollback-dialog">Roll back ${esc(branch)}…</a>` : ""}</div>
<div class="cards">${shown.map((g) => releaseCard(g, current.metrics)).join("") || `<div class="card empty" style="grid-column:1/-1">${q ? `No release on ${esc(branch)} matches “${esc(q)}”.` : `Nothing published on ${esc(branch)} yet. Run <code>npx flare-ota publish --branch ${esc(branch)}</code>.`}</div>`}</div></div>
<div class="stack">
${published ? publishPanel(branch, env.UPDATES_HOST ?? "") : ""}
<div class="card"><div class="ch"><h2>Fleet</h2>${help("Installs seen in the last 30 days, by platform and by app build. Each native build has a fingerprint; an update only reaches builds with the same one.")}<span class="grow"></span><small>30 days</small></div><div class="fleet">${donut([{ value: ios, color: "var(--ios)" }, { value: android, color: "var(--android)" }])}
<div class="legend"><div><span class="sw" style="background:var(--ios)"></span>iOS<b>${num(ios)}</b></div><div><span class="sw" style="background:var(--android)"></span>Android<b>${num(android)}</b></div></div></div>
<div class="list">${runtimeRows || '<div class="li" style="color:var(--muted)">No device has checked in yet.</div>'}</div></div>
<div class="card"><div class="ch"><h2>Activity</h2><span class="grow"></span><a class="tag" href="/audit">View all</a></div>${feed(audit, allGroups)}</div>
<div class="card"><div class="ch"><h2>Channels</h2>${help("Your app asks for a channel (set at build time). Each channel serves one branch. Most apps never change this.")}</div><div class="list">${overview.channels.map((c) => `<div class="li"><span class="grow" style="font-weight:600">${esc(c.name)}</span><span style="color:var(--muted)">→</span><span class="tag">${esc(c.branch)}</span></div>`).join("")}</div>
<div class="toolbar"><form method="post" action="/actions/channel"><input name="channel" placeholder="channel" required style="width:100px"><input name="branch" placeholder="branch" required style="width:100px"><button>Point</button></form></div></div>
</div></div>${await rollbackDialog(store, branch)}`;
  return page("Releases", actor, body, "/", host);
}

/** Rollback dialog for one branch: both options, with what each platform would go back to. */
async function rollbackDialog(store: Store, branch: string): Promise<string> {
  const targets = await store.rollbackTargets(branch, null);
  if (!targets.length) return "";
  const label = (p: string) => (p === "ios" ? "iOS" : "Android");
  const previous = await Promise.all(
    targets.map(async (t) => {
      if (!t.target) return `<li><span class="chip paused">${label(t.platform)}</span>no earlier release</li>`;
      const source = await store.group(t.target.groupId);
      return `<li><span class="chip live">${label(t.platform)}</span>${esc(source?.message || t.target.groupId.slice(0, 8))} <span style="color:var(--muted)">· ${esc(since(t.target.createdAt))}</span></li>`;
    }),
  );
  const canPrevious = targets.every((t) => t.target);
  return `<dialog id="rollback-dialog" class="modal"><form method="post" action="/actions/rollback" class="in" style="display:block"><input type="hidden" name="branch" value="${esc(branch)}">
<h2 tabindex="-1" autofocus>Roll back ${esc(branch)}</h2><p class="sub" style="margin:0">Every device on this branch switches on its next launches. Nothing is deleted; you can publish again any time.</p>
<label class="choice"><input type="radio" name="to" value="previous" ${canPrevious ? "checked" : "disabled"}><b>To the previous release</b><small>Re-sends the last good bundle as a new update.</small><ul>${previous.join("")}</ul></label>
<label class="choice"><input type="radio" name="to" value="embedded" ${canPrevious ? "" : "checked"}><b>To the app's built-in code</b><small>Devices drop every OTA update and run what shipped in their binary.</small></label>
<div class="acts"><button type="submit" formmethod="dialog" formnovalidate>Cancel</button><button class="primary" style="background:var(--bad)">Roll back now</button></div></form></dialog>`;
}

async function confirmRollback(store: Store, actor: string, host: string, params: URLSearchParams): Promise<Response> {
  const branch = params.get("branch") ?? "";
  const to = params.get("to") === "embedded" ? "embedded" : "previous";
  const platform = params.get("platform");
  const targets = await store.rollbackTargets(branch, platform && isPlatform(platform) ? platform : null);
  const label = (p: string) => (p === "ios" ? "iOS" : "Android");
  const rows = await Promise.all(
    targets.map(async (t) => {
      if (to === "embedded") return `<div class="t"><span class="chip back">${label(t.platform)}</span><div><b>Back to the code built into the app</b><small>Devices drop every OTA update and run what shipped in their binary.</small></div></div>`;
      if (!t.target) return `<div class="t"><span class="chip paused">${label(t.platform)}</span><div><b>No earlier release to go back to</b><small>Choose “the app's built-in code” instead.</small></div></div>`;
      const source = await store.group(t.target.groupId);
      return `<div class="t"><span class="chip live">${label(t.platform)}</span><div><b>${esc(source?.message || t.target.groupId.slice(0, 8))}</b><small>published ${esc(since(t.target.createdAt))} · re-sent to every device as a new update</small></div></div>`;
    }),
  );
  const blocked = to === "previous" && targets.some((t) => !t.target);
  const body = `<div class="crumb"><a href="/?branch=${encodeURIComponent(branch)}">Releases</a> · ${esc(branch)}</div>
<section class="card confirm"><h2>Roll back ${esc(branch)}?</h2><p class="sub" style="margin:0">Every device on this branch moves to what is listed below on its next launches. Nothing is deleted: you can publish again at any time.</p>
<div class="targets">${rows.join("") || `<div class="t"><div><b>Nothing is published on ${esc(branch)}.</b></div></div>`}</div>
<div class="acts">${targets.length && !blocked ? `<form method="post" action="/actions/rollback"><input type="hidden" name="branch" value="${esc(branch)}"><input type="hidden" name="to" value="${to}">${platform ? `<input type="hidden" name="platform" value="${esc(platform)}">` : ""}<button class="primary" style="background:var(--bad)">Roll back now</button></form>` : ""}<a class="btn" href="/?branch=${encodeURIComponent(branch)}">Cancel</a></div></section>`;
  return page(`Roll back ${branch}`, actor, body, "/", host);
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
    return `<div class="card pcard">${ring(pct(m.running, m.population), 84, color)}<div class="t"><b>${label}</b><div class="big num">${num(m.running)}</div><small>running of ${num(m.population)} eligible · ${num(m.served)} offered · <span class="${m.failed ? "bad" : ""}">${num(m.failed)} failed</span></small></div></div>`;
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
  const body = `${FLARE_ART}${flash}<div class="top"><div><div class="crumb"><a href="/">Releases</a> · ${esc(group.branch)}</div><h1 class="display sm">${esc(group.message || "(no message)")}</h1>
<p class="sub">${rolloutChip(group)}&nbsp; Published ${esc(since(group.createdAt))} by ${esc(actorName(group.actor))}</p></div></div>
<div class="grid"><div class="stack"><div class="platforms" style="margin:0">${card("ios", "iOS", "var(--ios)")}${card("android", "Android", "var(--android)")}</div>
<div class="card"><div class="ch"><h2>Details</h2></div><dl>
<dt>Release</dt><dd class="mono">${esc(group.id)}</dd><dt>Branch</dt><dd>${esc(group.branch)}</dd><dt>Kind</dt><dd>${group.kind === "bundle" ? "JavaScript bundle" : "Rollback to embedded"}</dd>
<dt>Rollout</dt><dd>${paused ? "paused" : `${rollout}%`}</dd>${group.gitCommit ? `<dt>Commit</dt><dd class="mono">${esc(group.gitCommit)}</dd>` : ""}
${group.sourceGroupId ? `<dt>Copied from</dt><dd><a class="mono" href="/groups/${esc(group.sourceGroupId)}">${esc(group.sourceGroupId)}</a></dd>` : ""}
<dt>Runtimes</dt><dd>${group.updates.map((u) => `${u.platform === "ios" ? "iOS" : "Android"} <span class="mono">${esc(u.runtimeVersion.slice(0, 12))}</span>`).join(" · ")}</dd></dl></div></div>
<div class="card"><div class="ch"><h2>Controls</h2></div>${controls}</div></div>`;
  return page(group.message || "Release", actor, body, "/", host, flash ? `/groups/${group.id}` : "");
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

const SCOPE_INFO: Record<Scope, [string, string]> = {
  read: ["Read", "See releases, metrics and the audit log. For dashboards and AI agents that only look."],
  publish: ["Publish", "Upload bundles and publish releases. What CI and your laptop need. Cannot roll back or create tokens."],
  admin: ["Admin", "Everything: rollouts, rollbacks, channels, preview links and tokens. Keep these few."],
};

function tokenForm(): string {
  return `<form method="post" action="/actions/token-create" class="in" style="display:block"><h2 tabindex="-1" autofocus>New token</h2><p class="sub" style="margin:0 0 18px">Shown once, then only its hash is kept.</p>
<label style="display:block;font-size:13px;font-weight:650;margin-bottom:6px">Name</label><input name="name" placeholder="e.g. github-actions, my-laptop" required pattern="[\\w .@:-]{1,64}" style="width:100%">
<div style="font-size:13px;font-weight:650;margin:18px 0 0">Permission</div>
${SCOPES.map((scope) => `<label class="choice"><input type="radio" name="scope" value="${scope}" ${scope === "publish" ? "checked" : ""}><b>${SCOPE_INFO[scope][0]}${scope === "publish" ? ' <span class="chip roll" style="margin-left:6px">Recommended</span>' : ""}</b><small>${SCOPE_INFO[scope][1]}</small></label>`).join("")}
<div class="acts"><button type="submit" formmethod="dialog" formnovalidate>Cancel</button><button class="primary">Create token</button></div></form>`;
}

async function tokensPage(store: Store, actor: string, host: string, flash = "", showForm = false): Promise<Response> {
  const rows = (await store.listTokens())
    .map((t) => `<tr><td><b style="color:var(--fg);font-weight:650">${esc(t.name)}</b></td><td><span class="chip ${t.scope === "admin" ? "back" : t.scope === "publish" ? "roll" : "live"}">${esc(t.scope)}</span></td><td>${esc(t.createdAt.slice(0, 10))}</td><td>${esc(t.lastUsedAt ? since(t.lastUsedAt) : "never")}</td>
<td style="text-align:right">${t.revokedAt ? '<span style="color:var(--muted)">revoked</span>' : `<form method="post" action="/actions/token-revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button class="danger ghost">Revoke</button></form>`}</td></tr>`)
    .join("");
  return page("Tokens", actor, `${flash}<div class="top"><div><div class="crumb">Workspace · Tokens</div><h1 class="display sm">Tokens</h1><p class="sub">Keys for the CLI, CI and AI agents. Each one has a single permission level.</p></div>
<a class="btn primary" href="/tokens?new=1" data-dialog="token-dialog">+ New token</a></div>
${showForm ? `<section class="card modal" style="max-width:560px;margin-bottom:22px">${tokenForm()}</section>` : ""}
<div class="card"><table><tr><th>Name</th><th>Permission</th><th>Created</th><th>Last used</th><th></th></tr>${rows || '<tr><td colspan="5" class="empty">No tokens yet. Create one for your laptop or CI.</td></tr>'}</table></div>
<dialog id="token-dialog" class="modal">${tokenForm()}</dialog>`, "/tokens", host, flash ? "/tokens" : "");
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function appCard(app: AppIdentity): string {
  if (!app.name && !app.iconHash) return "";
  const icon = app.iconHash ? `<img src="/_app/icon?h=${esc(app.iconHash.slice(0, 12))}" alt="">` : `<span class="ph">${esc((app.name ?? "?")[0]!.toUpperCase())}</span>`;
  const meta = [app.version ? `v${app.version}` : "", app.iosBundleId ?? app.androidPackage ?? ""].filter(Boolean).join(" · ");
  return `<div class="appcard">${icon}<div><b>${esc(app.name ?? "Your app")}</b><small>${esc(meta || "Expo app")}</small></div></div>`;
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
  if (request.method === "GET" && url.pathname === "/_app/icon") {
    const { iconHash } = await store.appIdentity();
    const object = iconHash ? await env.BUCKET.get(`assets/${iconHash}`) : null;
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
  }
  const response = await render(request, env, store, services, principal);
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const html = (await response.text()).replace("<!--app-card-->", appCard(await store.appIdentity()));
  return new Response(html, { status: response.status, headers: response.headers });
}

async function render(request: Request, env: Env, store: Store, services: Services, principal: Principal): Promise<Response> {
  const url = new URL(request.url);
  const actor = principal.actor;
  const host = url.hostname;
  try {
    if (request.method === "GET") {
      if (url.pathname === "/_fonts/jakarta.woff2") return fontResponse();
      if (url.pathname === "/_assets/ui.js") return new Response(UI_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
      if (url.pathname === "/") return await overviewPage(store, env, actor, host, url.searchParams.get("branch"), url.searchParams.get("q"));
      if (url.pathname === "/confirm/rollback") return await confirmRollback(store, actor, host, url.searchParams);
      const groupMatch = /^\/groups\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (groupMatch) return await groupPage(store, actor, groupMatch[1]!, host);
      if (url.pathname === "/audit") return await auditPage(store, actor, host);
      if (url.pathname === "/tokens") return await tokensPage(store, actor, host, "", url.searchParams.get("new") === "1");
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
        const flash = `<div class="flash"><div class="qr">${qrSvg(preview.deepLink)}</div><div style="min-width:0;flex:1"><h2 style="margin:0 0 6px;font-size:16px">Preview link ready</h2>
<p class="sub" style="margin:0 0 10px">Scan with a device whose build declares the <code>flare-preview</code> header. Expires in ${Math.round((Date.parse(preview.expiresAt) - Date.now()) / 60_000)} min (${esc(preview.expiresAt.slice(0, 16).replace("T", " "))} UTC).</p>${codeBox(preview.deepLink)}</div></div>`;
        return await groupPage(store, actor, f.groupId ?? "", host, flash);
      }
      case "/actions/token-create": {
        const scope = (f.scope ?? "") as Scope;
        if (!SCOPES.includes(scope)) throw new Invalid("Unknown scope.");
        const created = await services.createToken(f.name ?? "", scope, actor);
        return await tokensPage(store, actor, host, `<div class="flash"><div><h2 style="margin:0 0 6px;font-size:16px">New ${esc(scope)} token: ${esc(f.name)}</h2><p class="sub" style="margin:0 0 10px">Copy it now. Only its hash is stored, so it cannot be shown again.</p>${codeBox(created.token)}
<p class="sub" style="margin:14px 0 8px">Use it on your machine, or store it as a CI secret:</p>${codeBox(`export FLARE_OTA_TOKEN=${created.token}`, "export FLARE_OTA_TOKEN=&lt;token&gt;")}<div style="height:8px"></div>${codeBox("gh secret set FLARE_OTA_TOKEN", `<span class="c"># GitHub Actions: paste the token when asked</span>\ngh secret set FLARE_OTA_TOKEN`)}</div></div>`);
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
