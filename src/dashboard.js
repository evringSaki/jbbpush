'use strict';

/**
 * 生成自动刷新的本地看板 data/push/dashboard.html
 * 每轮采集后重写；页面每 30 秒自刷新，并显示下一轮倒计时。
 */

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readRows(jsonl, limit = 24) {
  try {
    const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean).reverse();
  } catch (e) {
    return [];
  }
}

function renderLines(text) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return '<div class="gap"></div>';
    if (/^加倍补/.test(line)) return `<h2>${esc(line)}</h2>`;
    if (/^- 时间：/.test(line)) return `<div class="meta">${esc(line.replace(/^- /, ''))}</div>`;
    if (/^- /.test(line)) return `<div class="row">${esc(line.replace(/^- /, ''))}</div>`;
    if (/^[💡⏰🔄🚫❔]/.test(line)) {
      const m = line.match(/^(.+?) · (\d+) 件$/);
      if (m) return `<h3>${esc(m[1])} <span class="count">${m[2]}</span></h3>`;
      return `<h3>${esc(line)}</h3>`;
    }
    return `<div class="note">${esc(line)}</div>`;
  }).join('\n');
}

function buildDashboard(outDir, { text, rows, intervalMin = 5 }) {
  const now = Date.now();
  const latest = rows[0] || {};
  const dir = path.join(outDir, 'push');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>加倍补 商品监控</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--line:#e6e8ec;--text:#1b1f26;--muted:#6b7280;--accent:#c8161d;--ok:#0f7b46;--warn:#b45309}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 20px 48px}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:20px;margin:0;letter-spacing:.5px}
  .sub{color:var(--muted);font-size:12.5px}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.95fr);gap:18px;align-items:start}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  .card h2{font-size:17px;margin:0 0 6px}
  .meta{color:var(--muted);font-size:13px}
  .meta+.meta{margin-top:2px}
  h3{font-size:13.5px;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid var(--line);color:#374151;font-weight:600}
  h3 .count{display:inline-block;min-width:20px;padding:0 6px;border-radius:9px;background:#f1f2f5;color:var(--muted);font-size:12px;text-align:center;margin-left:2px}
  .row{padding:6px 0;border-bottom:1px dashed #f0f1f4;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;word-break:break-all}
  .row:last-child{border-bottom:0}
  .note{color:var(--muted);font-size:13px;margin-top:10px}
  .gap{height:10px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #f0f1f4;white-space:nowrap}
  th{color:var(--muted);font-weight:500;font-size:12px}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .add{color:var(--ok);font-weight:600}
  .del{color:var(--accent);font-weight:600}
  .chg{color:var(--warn);font-weight:600}
  .zero{color:#c3c7ce}
  .stat{display:flex;gap:10px;flex-wrap:wrap;margin:2px 0 14px}
  .pill{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12.5px;color:var(--muted);background:#fbfbfc}
  .pill b{color:var(--text);font-size:14px;margin-left:4px}
  footer{margin-top:18px;color:var(--muted);font-size:12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>加倍补 商品监控</h1>
      <div class="sub"><span class="dot"></span>每 ${intervalMin} 分钟自动采集 · 页面每 30 秒刷新 · <span id="cd">--</span></div>
    </div>
    <div class="sub">下一轮约 <b id="next">--</b></div>
  </header>

  <div class="grid">
    <section class="card">
      ${renderLines(text)}
    </section>

    <aside class="card">
      <h2 style="font-size:14px;margin-bottom:10px;color:#374151">最近 ${rows.length} 轮</h2>
      <div class="stat">
        <span class="pill">当前<b>${latest.count == null ? '-' : latest.count}</b></span>
        <span class="pill">新增<b class="add">${latest.added == null ? '-' : latest.added}</b></span>
        <span class="pill">下架<b class="del">${latest.removed == null ? '-' : latest.removed}</b></span>
        <span class="pill">变动<b class="chg">${latest.changed == null ? '-' : latest.changed}</b></span>
      </div>
      <table>
        <thead><tr><th>时间</th><th class="num">总数</th><th class="num">新增</th><th class="num">下架</th><th class="num">变动</th></tr></thead>
        <tbody>
        ${rows.map((r) => {
          const t = String(r.time || '').slice(11);
          const c = (v) => (v ? `<td class="num ${v > 0 ? 'add' : ''}">${v}</td>` : '<td class="num zero">0</td>');
          const d = (v) => (v ? `<td class="num del">${v}</td>` : '<td class="num zero">0</td>');
          const g = (v) => (v ? `<td class="num chg">${v}</td>` : '<td class="num zero">0</td>');
          return `<tr><td>${esc(t)}</td><td class="num">${r.count == null ? '-' : r.count}</td>${c(r.added)}${d(r.removed)}${g(r.changed)}</tr>`;
        }).join('\n        ') || '<tr><td colspan="5" style="color:#9aa0aa">暂无历史</td></tr>'}
        </tbody>
      </table>
      <div class="note" style="margin-top:14px">数据来源：${esc(rows[0] && rows[0].channel || 'cdp')} · 完整：${latest.complete ? '是' : '否'}</div>
    </aside>
  </div>

  <footer>
    <span>基线：${esc(path.join('data', 'snapshots', 'baseline.json'))}</span>
    <span>更新于 ${new Date(now + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19)}（UTC+8）</span>
  </footer>
</div>
<script>
  var start = Date.now(), period = ${intervalMin} * 60 * 1000;
  function tick(){
    var left = Math.max(0, period - (Date.now() - start));
    var s = Math.floor(left / 1000);
    document.getElementById('cd').textContent = '下次刷新 ' + s + 's';
    var d = new Date(Date.now() + left + 8 * 3600e3);
    document.getElementById('next').textContent = d.toISOString().slice(11, 16);
  }
  tick(); setInterval(tick, 1000);
</script>
</body>
</html>`;

  const file = path.join(dir, 'dashboard.html');
  try {
    fs.writeFileSync(file, html, 'utf8');
  } catch (e) {
    try { fs.writeFileSync(file.replace(/\.html$/, '.busy.html'), html, 'utf8'); } catch (e2) {}
  }
  return file;
}

module.exports = { buildDashboard, readRows };
