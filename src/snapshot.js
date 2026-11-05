'use strict';

/**
 * 快照与差异
 *
 * 每一轮采集后存一份精简快照（只保留对比需要的字段），
 * 下一轮与它逐 SKU 比较，得到 新增 / 下架 / 变动。
 *
 * 基线文件：<outDir>/snapshots/baseline.json
 * 历史归档：<outDir>/snapshots/history/<YYYY-MM-DD>/<HHmm>.json（默认保留 7 天）
 */

const fs = require('fs');
const path = require('path');

const SNAP_VERSION = 1;

function bjNow(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600e3);
}

function pad(x) {
  return String(x).padStart(2, '0');
}

function bjStampMinute(d = new Date()) {
  const t = bjNow(d);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hm: `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}`,
    text: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    short: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${t.getUTCHours()}:${pad(t.getUTCMinutes())}`,
  };
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 把一条商品压成对比用的精简条目 */
function toItem(p) {
  const s = p.stock || {};
  return {
    sku: String(p.sku || ''),
    name: p.name || '',
    price: num(p.price),
    listPrice: num(p.listPrice),
    status: p.saleStatus || 'unknown',
    statusText: p.saleStatusText || '',
    stockText: s.statusText || '',
    start: (p.saleTime && p.saleTime.start) || '',
    startTs: (p.saleTime && p.saleTime.startTs) || null,
    remainNum: num(s.remainNum),
    totalStock: num(s.totalStock != null ? s.totalStock : s.limitCount),
    soldPercent: num(s.soldPercent),
    bookingCount: num(s.bookingCount),
  };
}

function snapshotOf(payload, opts = {}) {
  const items = {};
  for (const p of payload.products || []) {
    const it = toItem(p);
    if (!it.sku) continue;
    items[it.sku] = it;
  }
  const st = bjStampMinute();
  return {
    version: SNAP_VERSION,
    capturedAt: st.text,
    count: Object.keys(items).length,
    complete: payload.audit ? !!payload.audit.complete : false,
    channel: opts.channel || '',
    expectedTotal: payload.meta ? payload.meta.expectedTotal : null,
    items,
  };
}

/**
 * 参与「变动」判定的字段。
 *
 * 注意：剩余件数、总量、预约人数**故意不在这里**。
 * 这几项每轮都会变（预约人数几分钟就涨几个），如果算进去，
 * 就会变成每 5 分钟推一条「预约 2806→2809」，纯噪音。
 * 它们仍然会展示在播报的单条商品行里，只是不触发推送。
 */
const FIELDS = [
  { key: 'price', label: '价格', fmt: (v) => (v === null ? '?' : `¥${v}`) },
  { key: 'listPrice', label: '原价', fmt: (v) => (v === null ? '?' : `¥${v}`) },
  { key: 'status', label: '状态', fmt: (v) => STATUS_LABEL[v] || v },
];

const STATUS_LABEL = {
  on_sale: '抢购中',
  upcoming: '预告',
  sold_out: '已售罄',
  ended: '已结束',
  unknown: '未知',
};

function diffSnapshot(prev, curr) {
  if (!prev || !prev.items) {
    return { first: true, added: Object.values(curr.items), removed: [], changed: [] };
  }

  const added = [];
  const removed = [];
  const changed = [];

  for (const [sku, it] of Object.entries(curr.items)) {
    const old = prev.items[sku];
    if (!old) {
      added.push(it);
      continue;
    }
    const fields = [];
    for (const f of FIELDS) {
      const a = old[f.key];
      const b = it[f.key];
      if (a === b) continue;
      // 库存/预约人数从 null 变成数值属于首次拿到，不算变动
      if ((a === null || a === undefined) && (b === null || b === undefined)) continue;
      if (f.key === 'remainNum' && a === null && b !== null && old.status === 'upcoming') continue;
      fields.push({ key: f.key, label: f.label, from: a, to: b, text: `${f.label} ${f.fmt(a)}→${f.fmt(b)}` });
    }
    if (fields.length) changed.push({ ...it, fields });
  }

  for (const [sku, old] of Object.entries(prev.items)) {
    if (!curr.items[sku]) removed.push(old);
  }

  return { first: false, added, removed, changed };
}

function baselinePath(outDir) {
  return path.join(outDir, 'snapshots', 'baseline.json');
}

function readBaseline(outDir) {
  const file = baselinePath(outDir);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !data.items) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * 写入本轮快照。
 * 只有「本轮是完整结果」才更新基线，避免降级采样（如未登录 16 条）
 * 覆盖掉 29 条的基线，导致下一轮误报 13 条下架。
 */
function writeSnapshot(outDir, snap, { updateBaseline = true, keepDays = 7 } = {}) {
  const dir = path.join(outDir, 'snapshots');
  const histDir = path.join(dir, 'history', bjStampMinute().date);
  fs.mkdirSync(histDir, { recursive: true });

  const st = bjStampMinute();
  const histFile = path.join(histDir, `${st.hm}.json`);
  fs.writeFileSync(histFile, JSON.stringify(snap, null, 1), 'utf8');

  if (updateBaseline) {
    fs.writeFileSync(baselinePath(outDir), JSON.stringify(snap, null, 1), 'utf8');
  }

  // 清理过期历史
  try {
    const base = path.join(dir, 'history');
    const days = fs.readdirSync(base).sort();
    for (const d of days.slice(0, Math.max(0, days.length - keepDays))) {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
    }
  } catch (e) {}

  return { file: histFile, baseline: baselinePath(outDir) };
}

module.exports = {
  SNAP_VERSION,
  STATUS_LABEL,
  bjStampMinute,
  snapshotOf,
  diffSnapshot,
  readBaseline,
  writeSnapshot,
  baselinePath,
};
