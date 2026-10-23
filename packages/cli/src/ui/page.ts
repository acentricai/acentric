// The dev UI's page. Its script, /app.js, is ./app.ts bundled for the
// browser when acentric dev starts.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>acentric dev</title>
<style>
:root {
  --bg: #fafaf9; --panel: #ffffff; --sunken: #f4f4f2; --line: #e5e4e0; --text: #1c1b19;
  --muted: #6b6a65; --accent: #3d5afe; --accent-soft: #e8ecff; --ok: #1e8e4f; --warn: #b86e00;
  --bad: #c62828; --bad-soft: #fdecec; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131312; --panel: #1b1b1a; --sunken: #232321; --line: #2f2e2c; --text: #ecebe7;
    --muted: #9b9a94; --accent: #8c9eff; --accent-soft: #252a45; --ok: #5bc98a; --warn: #f0a640;
    --bad: #ff7a7a; --bad-soft: #3a1f1f;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
button, input, select, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 5px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
textarea, input, select { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; width: 100%; }
textarea { font-family: var(--mono); font-size: 12.5px; resize: vertical; }
code, pre, .mono { font-family: var(--mono); font-size: 12.5px; }
pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
#app { display: grid; grid-template-columns: 270px 1fr; height: 100vh; }
aside { border-right: 1px solid var(--line); background: var(--panel); overflow: auto; display: flex; flex-direction: column; }
.brand { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
.brand b { font-size: 15px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; display: inline-block; }
.dot.idle { background: var(--ok); } .dot.busy { background: var(--warn); } .dot.faulted { background: var(--bad); }
.dot.connected { background: var(--ok); } .dot.disconnected { background: var(--bad); }
.section { padding: 12px 16px; }
.section h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 600; }
.agent { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
.chip { font-family: var(--mono); font-size: 11px; color: var(--muted); background: var(--sunken); border-radius: 4px; padding: 1px 6px; }
.instance { display: flex; gap: 8px; align-items: center; padding: 7px 8px; margin: 0 -8px; border-radius: 6px; cursor: pointer; }
.instance:hover { background: var(--sunken); }
.instance.selected { background: var(--accent-soft); }
.instance .meta { font-size: 12px; color: var(--muted); }
main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; height: 100vh; }
.head { padding: 12px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.head .id { font-family: var(--mono); font-size: 13px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--sunken); display: inline-flex; gap: 6px; align-items: center; }
.body { display: grid; grid-template-columns: 1fr 320px; min-height: 0; }
.log { overflow: auto; padding: 8px 0; }
.entry { padding: 6px 20px; border-bottom: 1px solid transparent; cursor: pointer; }
.entry:hover { background: var(--sunken); }
.entry .line { display: flex; gap: 10px; align-items: baseline; }
.entry .seq { color: var(--muted); font-family: var(--mono); font-size: 12px; width: 34px; text-align: right; flex: none; }
.entry .time { color: var(--muted); font-family: var(--mono); font-size: 12px; flex: none; }
.entry .kind { font-weight: 600; flex: none; }
.entry .summary { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.entry pre { margin: 6px 0 4px 44px; padding: 8px 10px; background: var(--sunken); border-radius: 6px; max-height: 420px; overflow: auto; }
.stream { margin: 8px 20px; padding: 8px 12px; border: 1px dashed var(--accent); border-radius: 8px; }
.stream .label { font-size: 12px; color: var(--accent); margin-bottom: 4px; }
.side { border-left: 1px solid var(--line); overflow: auto; background: var(--panel); }
.side .section { border-bottom: 1px solid var(--line); }
.effect { display: flex; justify-content: space-between; gap: 6px; padding: 2px 0; font-size: 13px; }
.event { font-size: 12.5px; padding: 3px 0; }
.event.bad { color: var(--bad); } .event.ok { color: var(--ok); }
.event pre { color: var(--bad); margin-top: 2px; }
.fault { margin: 10px 20px 0; padding: 10px 12px; background: var(--bad-soft); color: var(--bad); border-radius: 8px; }
.fault small { display: block; color: var(--muted); margin-top: 4px; }
.composer { border-top: 1px solid var(--line); padding: 10px 20px; display: grid; grid-template-columns: 160px 1fr auto; gap: 8px; align-items: start; background: var(--panel); }
.answer { grid-column: 1 / -1; font-size: 12.5px; color: var(--muted); min-height: 1em; }
.answer.bad { color: var(--bad); }
.empty { color: var(--muted); padding: 40px 20px; text-align: center; }
dialog { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: var(--text); width: min(560px, 92vw); padding: 18px; }
dialog::backdrop { background: rgb(0 0 0 / 35%); }
dialog h2 { margin: 0 0 12px; font-size: 16px; }
dialog label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
@media (max-width: 900px) { #app { grid-template-columns: 1fr; } aside { display: none; } .body { grid-template-columns: 1fr; } .side { display: none; } }
</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
