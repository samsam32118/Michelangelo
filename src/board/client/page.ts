/**
 * The page HTML served at GET / (the server imports pageHtml; Node-safe: a string, no DOM at import time). System
 * fonts only, no external requests, no inline handlers; the modules load from /app/client/main.js.
 */

const CSS = String.raw`
:root{--bg:#f7f7f8;--panel:#ffffff;--panel2:#f4f4f6;--ink:#1d1d22;--muted:#6e6e78;--line:#e4e4e9;--line2:#d4d4da;--grid:#cfd0d6;
--accent:#2f6fed;--accent-ink:#ffffff;--accent-soft:rgba(47,111,237,.10);--ai:#8b5cf6;--ai-soft:rgba(139,92,246,.12);--ok:#1f9d55;--warn:#d97706;--bad:#e5483d;
--shadow:0 1px 2px rgba(20,20,40,.06),0 4px 16px rgba(20,20,40,.08);--shadow-lg:0 8px 40px rgba(20,20,40,.18);
--font:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--r:12px;--panel-w:340px;color-scheme:light}
:root[data-theme=dark]{--bg:#16161a;--panel:#1f1f25;--panel2:#26262d;--ink:#ececf1;--muted:#9a9aa6;--line:#2e2e36;--line2:#3a3a44;--grid:#34343c;
--accent:#4c8dff;--accent-soft:rgba(76,141,255,.16);--ai:#a37bff;--ai-soft:rgba(163,123,255,.16);
--shadow:0 1px 2px rgba(0,0,0,.4),0 4px 16px rgba(0,0,0,.35);--shadow-lg:0 8px 40px rgba(0,0,0,.6);color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16161a;--panel:#1f1f25;--panel2:#26262d;--ink:#ececf1;--muted:#9a9aa6;--line:#2e2e36;--line2:#3a3a44;--grid:#34343c;--accent:#4c8dff;--ai:#a37bff;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:14px/1.45 var(--font);-webkit-font-smoothing:antialiased;overflow:hidden}
button,input,textarea,select{font:inherit;color:inherit}
button{cursor:pointer;border:0;background:none;padding:0}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
kbd{font:500 10px/1 var(--mono);color:var(--muted)}
#app{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:minmax(0,1fr) auto;height:100vh;height:100dvh}
#stage{grid-column:1;grid-row:1;position:relative;overflow:hidden;min-height:200px}
#grid{position:absolute;inset:0;background-image:radial-gradient(circle,var(--grid) 1px,transparent 1.35px);pointer-events:none}
#board{position:absolute;inset:0;display:block;touch-action:none;outline:none}
.pill{position:absolute;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);display:flex;align-items:center;gap:2px;padding:4px;z-index:5}
#status{top:12px;left:12px;gap:8px;padding:6px 10px 6px 8px;font-size:13px}
#status .logo{width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,var(--accent),var(--ai))}
#status .conn{font-size:11px;color:var(--muted);display:inline-flex;align-items:center;gap:5px}
#status .conn::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--muted)}
#status .conn[data-state=live]::before{background:var(--ok)}#status .conn[data-state=polling]::before{background:var(--warn)}#status .conn[data-state=offline]::before{background:var(--bad)}#status .conn[data-state=detached]::before{background:var(--ai)}
#tools{top:58px;left:12px;flex-wrap:wrap;max-width:calc(100% - 24px)}
.tool{position:relative;width:38px;height:38px;border-radius:9px;display:grid;place-items:center;color:var(--ink);transition:background .12s,color .12s}
.tool:hover{background:var(--panel2)}
.tool.on{background:var(--accent);color:var(--accent-ink)}
.tool kbd{position:absolute;right:3px;bottom:2px;font-size:8.5px;opacity:.75}
.tool.on kbd{color:var(--accent-ink)}
.sep{width:1px;height:22px;background:var(--line);margin:0 4px;flex:none}
#zoombar{top:12px;right:12px}
.icon-btn{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;color:var(--ink);font-size:16px}
.icon-btn:hover{background:var(--panel2)}
.icon-btn[aria-pressed=true]{background:var(--accent-soft);color:var(--accent)}
.zoom{min-width:52px;height:32px;border-radius:8px;font:500 12px var(--mono);color:var(--muted)}
.zoom:hover{background:var(--panel2)}
.follow{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ai);background:var(--ai-soft);border-radius:20px;padding:3px 9px 3px 7px}
.follow .pulse{width:7px;height:7px;border-radius:50%;background:var(--ai);box-shadow:0 0 0 0 var(--ai);animation:pulse 1.8s infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(139,92,246,.6)}70%{box-shadow:0 0 0 7px rgba(139,92,246,0)}100%{box-shadow:0 0 0 0 rgba(139,92,246,0)}}
.copy-changes{font-size:12px;background:var(--ai);color:#fff;border-radius:8px;padding:4px 9px}
.ai-cursor{position:absolute;left:0;top:0;color:var(--ai);pointer-events:none;z-index:6;display:flex;align-items:flex-start;transition:transform .18s ease-out;filter:drop-shadow(0 1px 2px rgba(0,0,0,.25))}
.ai-cursor span{margin:14px 0 0 -4px;background:var(--ai);color:#fff;font:600 11px var(--font);padding:2px 7px;border-radius:9px 9px 9px 2px}
.editor{position:absolute;z-index:7;border:0;outline:2px solid var(--accent);resize:none;overflow:hidden;margin:0;box-shadow:none;white-space:pre-wrap}
.prompt{position:absolute;z-index:8;width:288px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-lg);padding:8px}
.prompt textarea{width:100%;border:1px solid var(--line2);border-radius:7px;padding:7px 9px;background:var(--panel);resize:vertical;min-height:64px}
.prompt .hint{font-size:11px;color:var(--muted);margin-top:4px}
#toasts{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;align-items:center;z-index:9;pointer-events:none;width:min(560px,calc(100% - 24px))}
.toast{pointer-events:auto;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--muted);box-shadow:var(--shadow-lg);border-radius:10px;padding:9px 13px;display:flex;gap:8px;align-items:baseline;max-width:100%;animation:in .2s ease-out;transition:opacity .3s,transform .3s}
.toast b{font-size:11px;color:#fff;background:var(--muted);border-radius:6px;padding:1px 6px}
.toast.ai{border-left-color:var(--ai)}.toast.ai b{background:var(--ai)}.toast.human{border-left-color:var(--accent)}.toast.human b{background:var(--accent)}.toast.error{border-left-color:var(--bad)}
.toast.out{opacity:0;transform:translateY(8px)}
@keyframes in{from{opacity:0;transform:translateY(8px)}}
#panel{grid-column:2;grid-row:1/3;width:var(--panel-w);background:var(--panel);border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
#panel[hidden]{display:none}
.panel-head{padding:12px 14px 8px;border-bottom:1px solid var(--line)}
.ladder{list-style:none;margin:0;padding:0;display:flex;gap:4px}
.ladder li{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;color:var(--muted);position:relative}
.ladder li::before{content:"";position:absolute;top:5px;left:-50%;width:100%;height:2px;background:var(--line);z-index:0}
.ladder li:first-child::before{display:none}
.ladder .dot{width:12px;height:12px;border-radius:50%;border:2px solid var(--line2);background:var(--panel);z-index:1}
.ladder li.done .dot{background:var(--ok);border-color:var(--ok)}.ladder li.done::before{background:var(--ok)}
.ladder li.next .dot{border-color:var(--accent)}.ladder li.active .dot{background:var(--accent);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.ladder li.active .name,.ladder li.next .name{color:var(--ink);font-weight:600}
.spend{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted);margin-top:8px}
.bar{flex:1;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar.hot i{background:var(--bad)}
.tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid var(--line)}
.tabs button{padding:8px 10px;border-radius:8px 8px 0 0;color:var(--muted);font-weight:500;display:inline-flex;align-items:center;gap:6px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.badge{min-width:16px;height:16px;border-radius:8px;background:var(--accent);color:#fff;font-size:10px;line-height:16px;text-align:center;padding:0 4px}
.badge[hidden]{display:none}
.pane{flex:1;overflow:auto;padding:12px 14px 16px;min-height:0}
.pane[hidden]{display:none}
.field{margin-bottom:10px}
.field label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:4px}
.field .need{display:none;font-size:10px;font-weight:600;color:var(--warn);background:rgba(217,119,6,.12);border-radius:5px;padding:0 5px}
.field.missing .need{display:inline}.field.missing input,.field.missing textarea{border-color:var(--warn);background:rgba(217,119,6,.04)}
.field input,.field textarea,.field select,.round input{width:100%;border:1px solid var(--line2);border-radius:8px;padding:7px 9px;background:var(--panel);resize:vertical}
.field input:focus,.field textarea:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 3px var(--accent-soft)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.hint{font-size:11px;color:var(--muted);margin:4px 0 0}
.empty{color:var(--muted);font-size:13px}
.chip{display:inline-flex;align-items:center;font-size:11px;font-weight:600;border-radius:6px;padding:1px 6px;background:var(--panel2);color:var(--muted)}
.chip.link{color:var(--accent);background:var(--accent-soft)}.chip.ok{color:var(--ok);background:rgba(31,157,85,.12)}
.st-proposed{color:var(--accent)!important;background:var(--accent-soft)!important}.st-decided{color:var(--ok)!important;background:rgba(31,157,85,.12)!important}
.lv-ask{color:var(--accent);background:var(--accent-soft)}.lv-warn{color:var(--bad);background:rgba(229,72,61,.12)}.lv-do{color:var(--ai);background:var(--ai-soft)}.lv-wait{color:var(--muted)}
.round{border:1px solid var(--line);border-radius:12px;padding:10px;margin-bottom:12px;background:var(--panel)}
.round.proposed{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.round.decided,.round.dropped{opacity:.85}
.round>header{display:flex;gap:8px;align-items:baseline}.round .meta{display:flex;gap:6px;margin:4px 0 8px}
.id{font:500 11px var(--mono);color:var(--muted)}
.notes,.why{font-size:13px;color:var(--muted);margin:6px 0}
.option{border:1px solid var(--line);border-radius:10px;padding:9px 10px;margin:8px 0;background:var(--panel2)}
.option.chosen{border-color:var(--ok);background:rgba(31,157,85,.06)}
.option header{display:flex;gap:6px;align-items:baseline}
.option p{margin:5px 0;font-size:13px}.kv b{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}.warnText{color:var(--warn)}
.shapes{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
.actions{display:flex;gap:6px;margin-top:8px}
.actions button,.comment button,.composer button,.tl-btn{border:1px solid var(--line2);border-radius:8px;padding:5px 12px;font-weight:500;background:var(--panel)}
.actions button:hover,.tl-btn:hover{background:var(--panel2)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover{filter:brightness(1.08);background:var(--accent)}
.comment{margin-top:8px;display:flex;flex-direction:column;gap:6px}.comment[hidden]{display:none}
.comment textarea{border:1px solid var(--line2);border-radius:8px;padding:6px 8px;background:var(--panel);resize:vertical}
#tab-chat:not([hidden]){display:flex;flex-direction:column;padding:0}
.log{list-style:none;margin:0;padding:12px 14px;flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px}
.msg{max-width:88%;padding:7px 10px;border-radius:12px;background:var(--panel2);font-size:13px;display:flex;flex-direction:column;gap:2px}
.msg.human{align-self:flex-end;background:var(--accent-soft);border-bottom-right-radius:4px}.msg.ai{border-bottom-left-radius:4px;background:var(--ai-soft)}
.msg .who{font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase}.msg.ai .who{color:var(--ai)}.msg.human .who{color:var(--accent)}
.msg time{font-size:10px;color:var(--muted);align-self:flex-end}.msg .text{white-space:pre-wrap;overflow-wrap:anywhere}
.composer{display:flex;gap:6px;padding:10px 12px;border-top:1px solid var(--line)}
.composer textarea{flex:1;border:1px solid var(--line2);border-radius:10px;padding:7px 10px;background:var(--panel);resize:none}
.composer .icon-btn{width:38px;height:auto;padding:0}
.advice{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.adv{display:flex;gap:8px;align-items:baseline;font-size:13px;padding:8px 10px;border:1px solid var(--line);border-radius:10px}
.adv>span:nth-child(2){flex:1}
#timeline{grid-column:1;grid-row:2;background:var(--panel);border-top:1px solid var(--line);position:relative;user-select:none}
.tl-head{display:flex;align-items:center;gap:10px;padding:6px 12px;font-size:12px;color:var(--muted);white-space:nowrap;min-width:0}
.tl-title{overflow:hidden;text-overflow:ellipsis;min-width:0}
.tl-title{font-weight:600;color:var(--ink)}.tl-time{font:500 12px var(--mono)}.grow{flex:1}
.tl-btn{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;font-size:12px}.tl-btn.icon-only{padding:3px 5px}
.tl-spend{display:inline-flex;align-items:center;gap:6px;font:500 11px var(--mono)}
.tl-spend .meter{width:64px;height:4px;border-radius:2px;background:var(--line);overflow:hidden}.tl-spend .meter i{display:block;height:100%;background:var(--accent)}.tl-spend .meter i.hot{background:var(--bad)}
.tl-body{position:relative;margin:0 12px 10px 76px;cursor:ew-resize;touch-action:none}
.tl-ruler{position:relative;height:16px;font:10px var(--mono);color:var(--muted)}
.tl-ruler span{position:absolute;top:0;padding-left:3px;border-left:1px solid var(--line2);height:12px;line-height:12px}
.tl-tracks{display:flex;flex-direction:column;gap:3px;max-height:96px;overflow-y:auto;overflow-x:hidden;margin-left:-76px;padding-left:76px}
.tl-track{position:relative;flex:none;height:22px;background:var(--panel2);border-radius:5px}
.tl-tname{position:absolute;right:100%;margin-right:8px;width:60px;text-align:right;font:500 11px var(--mono);color:var(--muted);line-height:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-clip{position:absolute;top:2px;bottom:2px;border-radius:4px;background:#bfdbfe;border:1px solid #3b74e6;color:#0f2c66;font-size:11px;font-weight:500;padding:0 6px;text-align:left;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:2px}
.tl-clip.k-text{background:#ddd0fe;border-color:#7c4ddb;color:#2e1366}.tl-clip.k-gen,.tl-clip.k-shape,.tl-clip.k-solid{background:#fde68a;border-color:#d4a514;color:#3d2f00}
.tl-track.audio .tl-clip{background:#bbf0cf;border-color:#27a35a;color:#0b3d20}
:root[data-theme=dark] .tl-clip{background:#24406e;color:#dbe8ff;border-color:#6c9cf5}:root[data-theme=dark] .tl-clip.k-text{background:#45307a;color:#ece4ff;border-color:#a487f5}:root[data-theme=dark] .tl-track.audio .tl-clip{background:#1f5236;color:#d6f7e3;border-color:#4ccb7f}
.tl-playhead{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--bad);z-index:2;pointer-events:none}
.tl-playhead::before{content:"";position:absolute;top:0;left:-5px;border:6px solid transparent;border-top:7px solid var(--bad)}
.tl-preview{position:absolute;bottom:100%;margin-bottom:8px;margin-left:76px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow-lg);padding:6px;z-index:10;pointer-events:none}
.tl-preview img{display:block;width:200px;max-height:220px;object-fit:contain;border-radius:6px;background:#111;min-height:60px}
.tl-preview .cap{display:block;font:500 11px var(--mono);color:var(--muted);margin-top:4px;text-align:center}
.tl-preview[hidden]{display:none}
.tl-empty{display:none;margin:0 12px 10px;font-size:12px;color:var(--muted)}
#timeline.no-project .tl-body,#timeline.no-project .tl-time,#timeline.no-project [data-mgl=still-at-playhead]{display:none}
#timeline.no-project .tl-empty{display:block}
#timeline.collapsed .tl-body,#timeline.collapsed .tl-empty{display:none}
#mgl-outline{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#mgl-outline.shown{position:fixed;left:12px;top:110px;bottom:180px;width:min(460px,calc(100% - 24px));height:auto;margin:0;clip:auto;white-space:normal;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-lg);padding:4px 14px 14px;z-index:20;font-size:12px}
#mgl-outline h2{font-size:14px}#mgl-outline h3{font-size:12px;color:var(--muted);margin:12px 0 4px}#mgl-outline ul{margin:0;padding-left:16px}
#help{position:fixed;inset:0;background:rgba(10,10,20,.35);display:grid;place-items:center;z-index:30}
#help[hidden]{display:none}
#help .sheet{background:var(--panel);border-radius:16px;box-shadow:var(--shadow-lg);width:min(560px,calc(100% - 32px));max-height:calc(100% - 64px);overflow:auto;padding:18px 22px}
#help header{display:flex;justify-content:space-between;align-items:center}#help h2{margin:0;font-size:17px}#help header button{font-size:22px;width:32px;height:32px;border-radius:8px}
#help dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:14px 0}#help dt{text-align:right}#help dd{margin:0}
#help kbd{font-size:11px;color:var(--ink);background:var(--panel2);border:1px solid var(--line2);border-bottom-width:2px;border-radius:5px;padding:2px 6px}
#help code{font:12px var(--mono);background:var(--panel2);padding:1px 5px;border-radius:4px}
.copy-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(600px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;z-index:40;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow-lg);padding:12px 14px;font-size:13px}
.copy-box p{margin:0 0 8px}.copy-box code{font:12px var(--mono);background:var(--panel2);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.copy-box textarea{width:100%;font:12px/1.4 var(--mono);border:1px solid var(--line2);border-radius:8px;padding:7px 9px;background:var(--panel2);resize:vertical}
.copy-box .actions{justify-content:flex-end}
@media (max-width:900px){
#app{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto auto}
#panel{grid-column:1;grid-row:3;width:auto;max-height:38vh;border-left:0;border-top:1px solid var(--line)}
.tl-tracks{max-height:62px;margin-left:0;padding-left:0}.tl-track{height:18px}.tl-track .tl-clip{font-size:10px}.tl-spend,.tl-btn:not(.icon-only) svg{display:none}
#timeline{grid-row:2}
.tl-body{margin-left:12px}.tl-tname{display:none}.tl-preview{margin-left:12px}
#tools{top:auto;bottom:12px;left:50%;transform:translateX(-50%);justify-content:flex-start;width:max-content;max-width:calc(100% - 24px);flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
#toasts{bottom:auto;top:60px}
.tool{width:31px;height:34px}.tool kbd,#tools .sep{display:none}
}
@media (max-width:600px){#zoombar .icon-btn[data-mgl^=zoom-],#zoombar .zoom,#zoombar [data-mgl=theme],#zoombar [data-mgl=help],#zoombar .sep{display:none}#status{max-width:calc(100% - 190px);overflow:hidden}#status .follow{display:none}.tl-time{font-size:11px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

export function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Board</title>
<style>${CSS}</style>
</head>
<body>
<div id="app">
  <main id="stage" aria-label="Board">
    <div id="grid" aria-hidden="true"></div>
    <canvas id="board" tabindex="0" aria-label="Board canvas. The tool bar edits it; the outline lists it as text; agents use mgl in the console."></canvas>
    <div id="status" class="pill"></div>
    <nav id="tools" class="pill" role="toolbar" aria-label="Tools"></nav>
    <div id="zoombar" class="pill" role="toolbar" aria-label="View and history"></div>
    <div id="toasts" aria-live="polite"></div>
  </main>
  <aside id="panel" aria-label="Brief, rounds, chat and next steps"></aside>
  <footer id="timeline" aria-label="Timeline"></footer>
</div>
<section id="mgl-outline" aria-label="Board outline"></section>
<div id="help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" hidden></div>
<noscript><p style="padding:24px">The board needs JavaScript. Without it: mgl board show, mgl board snapshot.</p></noscript>
<script type="module" src="/app/client/main.js"></script>
</body>
</html>
`;
}
