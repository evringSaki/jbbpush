'use strict';

/**
 * 播报生成
 *
 * 输出形如：
 *   加倍补 商品更新
 *   - 时间：2026-11-06 3:06
 *   - 当前商品数：29（上轮 29）
 *   - 变更：新增 3（💡 抢购中 1 · ⏰ 预告 2） / 下架 0 / 变动 0
 *
 *   💡 抢购中 · 1 件
 *   - 100030561995 北京稻香村四季平安糕点礼盒530g ¥64（原价 ¥99） · 💡 抢购中 仅剩8件 总量20
 *
 *   ⏰ 预告 · 2 件
 *   - 100266436301 维达乳霜纸 3层40抽*单包 ¥1（原价 ¥9.9） · ⏰ 预告（今天 10:00 开抢）665/10000
 */

const fs = require('fs');
const path = require('path');
const { STATUS_LABEL, bjStampMinute, snapshotOf, diffSnapshot, readBaseline, writeSnapshot } = require('./snapshot');

const HEADER = '加倍补 商品更新';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** '2026-11-06 20:00' -> { d:'2026-11-06', hm:'20:00' } */
function splitSale(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return { d: `${m[1]}-${m[2]}-${m[3]}`, hm: `${m[4]}:${m[5]}` };
}

function dayDiff(d, today) {
  const a = Date.parse(`${d}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

function saleWord(s) {
  const sp = splitSale(s);
  if (!sp) return '';
  const today = bjStampMinute().date;
  const diff = dayDiff(sp.d, today);
  if (diff === 0) return `今天 ${sp.hm}`;
  if (diff === 1) return `明天 ${sp.hm}`;
  if (diff === -1) return `昨天 ${sp.hm}`;
  if (diff === null) return `${sp.d} ${sp.hm}`;
  return `${sp.d.slice(5)} ${sp.hm}`;
}

function money(v) {
  return v === null || v === undefined ? '?' : `¥${v}`;
}

function priceText(it) {
  const p = money(it.price);
  if (it.listPrice !== null && it.listPrice !== undefined && it.listPrice !== it.price) {
    return `${p}（原价 ¥${it.listPrice}）`;
  }
  return p;
}

function statusTail(it) {
  if (it.status === 'on_sale') {
    const head = '💡 抢购中';
    // 剩余/总量，形如 8/20，和预告行的 预约/总量 保持同一种写法
    if (it.remainNum !== null && it.remainNum !== undefined && it.totalStock !== null && it.totalStock !== undefined) {
      return `${head} ${it.remainNum}/${it.totalStock}`;
    }
    if (it.remainNum !== null && it.remainNum !== undefined) return `${head} 仅剩${it.remainNum}件`;
    if (it.soldPercent !== null && it.soldPercent !== undefined) return `${head} 已售${it.soldPercent}%`;
    return head;
  }

  if (it.status === 'upcoming') {
    const when = saleWord(it.start);
    const head = when ? `⏰ 预告（${when} 开抢）` : '⏰ 预告';
    // 预约人数/总量，形如 18/200；缺一侧时退化显示
    if (it.bookingCount !== null && it.bookingCount !== undefined && it.totalStock !== null && it.totalStock !== undefined) {
      return `${head}${it.bookingCount}/${it.totalStock}`;
    }
    if (it.totalStock !== null && it.totalStock !== undefined) return `${head}总量${it.totalStock}`;
    if (it.bookingCount) return `${head}预约${it.bookingCount}`;
    return head;
  }

  if (it.status === 'sold_out') {
    return `🚫 已售罄${it.totalStock !== null && it.totalStock !== undefined ? ` 总量${it.totalStock}` : ''}`;
  }
  if (it.status === 'ended') return '⌛ 已结束';
  return `❔ ${it.statusText || STATUS_LABEL[it.status] || '未知'}`;
}

function itemLine(it) {
  return `- ${it.sku} ${it.name} ${priceText(it)} · ${statusTail(it)}`;
}

function changedLine(it) {
  const desc = (it.fields || []).map((f) => f.text).join(' · ');
  return `- ${it.sku} ${it.name} · ${desc}`;
}

function removedLine(it) {
  return `- ${it.sku} ${it.name} ${priceText(it)}`;
}

function section(title, lines) {
  if (!lines.length) return '';
  return `${title} · ${lines.length} 件\n${lines.join('\n')}`;
}

function groupByStatus(list) {
  const onSale = [];
  const upcoming = [];
  const other = [];
  for (const it of list) {
    if (it.status === 'on_sale') onSale.push(it);
    else if (it.status === 'upcoming') upcoming.push(it);
    else other.push(it);
  }
  // 抢购中：剩余少的排前面（更紧迫）；预告：按开抢时间升序
  onSale.sort((a, b) => (a.remainNum === null ? 1e9 : a.remainNum) - (b.remainNum === null ? 1e9 : b.remainNum));
  upcoming.sort((a, b) => {
    const ta = a.startTs || (splitSale(a.start) ? Date.parse(`${splitSale(a.start).d}T${splitSale(a.start).hm}:00+08:00`) : 0);
    const tb = b.startTs || (splitSale(b.start) ? Date.parse(`${splitSale(b.start).d}T${splitSale(b.start).hm}:00+08:00`) : 0);
    return (ta || 0) - (tb || 0);
  });
  return { onSale, upcoming, other };
}

function countByStatus(list) {
  let onSale = 0;
  let upcoming = 0;
  for (const it of list) {
    if (it.status === 'on_sale') onSale++;
    else if (it.status === 'upcoming') upcoming++;
  }
  return { onSale, upcoming, other: list.length - onSale - upcoming };
}

/**
 * 生成播报文本
 * @param {object} p
 * @param {object|null} p.prev  上一轮快照
 * @param {object} p.curr       本轮快照
 * @param {object} p.diff       diffSnapshot 结果
 * @param {boolean} p.degraded  本轮是否降级采样（未拿到登录态）
 */
function buildReportText({ prev, curr, diff, degraded, expectedTotal, now, mode = 'new' }) {
  const st = bjStampMinute(now);
  const prevCount = prev ? prev.count : null;
  const onlyNew = mode !== 'change' && mode !== 'always';
  const head = [];
  const blocks = [];

  head.push(diff.first ? '加倍补 监控已启动' : (onlyNew ? '加倍补 商品上新' : HEADER));
  head.push(`- 时间：${st.short}`);
  head.push(`- 当前商品数：${curr.count}${prevCount === null ? '（首轮基线）' : `（上轮 ${prevCount}）`}`);

  if (diff.first) {
    head.push('- 规则：已建立基线，之后只在有新商品上架时推送');
  } else if (onlyNew) {
    const a = countByStatus(diff.added);
    head.push(
      `- 本次上新：${diff.added.length} 件` +
      (diff.added.length ? `（💡 抢购中 ${a.onSale} · ⏰ 预告 ${a.upcoming}${a.other ? ` · 其他 ${a.other}` : ''}）` : '')
    );
  } else {
    const a = countByStatus(diff.added);
    const removedCount = degraded ? 0 : diff.removed.length;
    const hidden = degraded ? diff.removed.length : 0;
    head.push(
      `- 变更：新增 ${diff.added.length}（💡 抢购中 ${a.onSale} · ⏰ 预告 ${a.upcoming}${a.other ? ` · 其他 ${a.other}` : ''}）` +
      ` / 下架 ${removedCount} / 变动 ${diff.changed.length}` +
      (hidden ? `（另有 ${hidden} 条本轮不可见）` : '')
    );
  }

  if (expectedTotal && curr.count !== expectedTotal) {
    head.push(`- 覆盖：${curr.count}/${expectedTotal}${curr.complete ? '' : '（本轮不完整）'}`);
  }
  if (degraded) {
    head.push('- ⚠ 本轮未取得登录态，App 专享商品不可见，已跳过「下架」判定（不更新基线）');
  }

  // 首轮：只确认通道，不刷屏（全量清单看 CSV）
  if (diff.first) {
    if (!diff.added.length) blocks.push('（本轮没有任何商品，检查采集是否成功）');
  } else if (onlyNew) {
    // 只推上新：库存、预约人数、价格波动一律不打扰，商品行里仍然展示当前值
    if (diff.added.length) {
      const g = groupByStatus(diff.added);
      const lines = [
        ...g.onSale.map(itemLine),
        ...g.upcoming.map(itemLine),
        ...g.other.map(itemLine),
      ];
      blocks.push(section('🆕 上新', lines));
    } else {
      blocks.push('（本轮无上新）');
    }
  } else {
    if (diff.added.length) {
      const g = groupByStatus(diff.added);
      blocks.push(section('💡 抢购中', g.onSale.map(itemLine)));
      blocks.push(section('⏰ 预告', g.upcoming.map(itemLine)));
      blocks.push(section('❔ 其他', g.other.map(itemLine)));
    }
    if (diff.changed.length) blocks.push(section('🔄 变动', diff.changed.map(changedLine)));
    if (!degraded && diff.removed.length) blocks.push(section('🚫 下架', diff.removed.map(removedLine)));
    if (!diff.added.length && !diff.changed.length && (degraded || !diff.removed.length)) {
      blocks.push(degraded ? '（本轮无可见变化）' : '（本轮无变化）');
    }
  }

  return [head.join('\n'), blocks.filter(Boolean).join('\n\n')].filter(Boolean).join('\n\n');
}

function writePush(outDir, text, extra = {}) {
  const dir = path.join(outDir, 'push');
  const st = bjStampMinute();
  const histDir = path.join(dir, 'history', st.date);
  fs.mkdirSync(histDir, { recursive: true });

  const latest = path.join(dir, 'latest.txt');
  const hist = path.join(histDir, `${st.hm}.txt`);
  const md = path.join(dir, 'latest.md');

  fs.writeFileSync(latest, text + '\n', 'utf8');
  fs.writeFileSync(hist, text + '\n', 'utf8');
  fs.writeFileSync(md, '```\n' + text + '\n```\n', 'utf8');

  const jsonl = path.join(dir, 'feed.jsonl');
  fs.appendFileSync(
    jsonl,
    JSON.stringify({
      time: st.text,
      channel: extra.channel || '',
      count: extra.count,
      prevCount: extra.prevCount,
      added: extra.added,
      removed: extra.removed,
      changed: extra.changed,
      degraded: !!extra.degraded,
      complete: !!extra.complete,
      mode: extra.mode || 'new',
      notify: !!extra.notify,
    }) + '\n',
    'utf8'
  );

  // 历史只留最近 3 天
  try {
    const base = path.join(dir, 'history');
    const days = fs.readdirSync(base).sort();
    for (const d of days.slice(0, Math.max(0, days.length - 3))) {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
    }
  } catch (e) {}

  let dashboard = '';
  try {
    const { buildDashboard, readRows } = require('./dashboard');
    dashboard = buildDashboard(outDir, { text, rows: readRows(jsonl, 24), intervalMin: extra.intervalMin || 5 });
  } catch (e) {}

  return { latest, hist, md, jsonl, dashboard };
}

/**
 * 一轮完整的「采集结果 -> 播报」处理
 */
function runPush({ outDir, payload, channel = '', now, intervalMin = 5, mode = 'new' }) {
  const prev = readBaseline(outDir);
  const curr = snapshotOf(payload, { channel });
  const degraded = !!(prev && prev.complete && !curr.complete);
  const diff = diffSnapshot(prev, curr);

  const text = buildReportText({
    prev,
    curr,
    diff,
    degraded,
    expectedTotal: payload.meta ? payload.meta.expectedTotal : null,
    now,
    mode,
  });

  const onlyNew = mode !== 'change' && mode !== 'always';
  const removedCount = degraded ? 0 : diff.removed.length;
  const shouldNotify =
    mode === 'always' ||
    diff.first ||
    (onlyNew
      ? diff.added.length > 0
      : diff.added.length + removedCount + diff.changed.length > 0);

  const shouldUpdateBaseline = !degraded;
  const snapFiles = writeSnapshot(outDir, curr, { updateBaseline: shouldUpdateBaseline });
  const files = writePush(outDir, text, {
    count: curr.count,
    prevCount: prev ? prev.count : null,
    added: diff.added.length,
    removed: removedCount,
    changed: diff.changed.length,
    degraded,
    complete: curr.complete,
    channel: curr.channel,
    intervalMin,
    mode,
    notify: shouldNotify,
  });

  return { text, diff, snapFiles, files, curr, prev, degraded, mode, shouldNotify };
}

module.exports = { buildReportText, runPush, HEADER, saleWord, statusTail };
