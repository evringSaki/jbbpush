'use strict';

const fs = require('fs');
const path = require('path');
const { CRAWLER_VERSION } = require('./normalize');
const { ACTIVITY_ID, URLS } = require('./config');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function stamp() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""');
  return `"${s}"`;
}

function toCsv(products) {
  const header = [
    'SKU', '商品名称', '抢购价', '日常价', '京东价', '折扣',
    '抢购开始时间', '抢购结束时间', '活动日期', '场次', '销售状态', '库存状态',
    '剩余件数', '已售比例(%)', '总量', '预约人数', '活动标签',
    '所属板块', '数据来源', '商品链接', '采集时间',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const p of products) {
    const s = p.stock || {};
    lines.push([
      p.sku, p.name, p.price, p.listPrice, p.jdPrice, p.discount,
      p.saleTime && p.saleTime.start, p.saleTime && p.saleTime.end,
      p.saleTime && p.saleTime.activityDate, p.saleTime && p.saleTime.label,
      p.saleStatusText, s.statusText || p.saleStatusText,
      s.remainNum, s.soldPercent, s.totalStock != null ? s.totalStock : s.limitCount,
      s.bookingCount, (p.tags || []).join(' | '),
      p.activityTab, p.source, p.url, p.capturedAt,
    ].map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function writeJson(file, data) {
  safeWrite(file, JSON.stringify(data, null, 2));
}

/**
 * 写文件容错：Windows 上 latest.csv / latest.json 可能被 Excel、预览面板占用（EBUSY）。
 * 推送模式每 5 分钟跑一次，不能因为一个文件被占用就让整轮失败：
 * 重试 3 次 -> 退化为 <name>.busy.<ext> -> 返回失败信息，由调用方决定是否告警。
 */
function safeWrite(file, data, encoding = 'utf8') {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, data, encoding);
      return { ok: true, file };
    } catch (e) {
      lastErr = e;
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) break;
      const until = Date.now() + 120;
      while (Date.now() < until) { /* 短自旋，保持同步 API */ }
    }
  }
  const alt = file.replace(/(\.[^.\\/]+)$/, '.busy$1');
  try {
    fs.writeFileSync(alt, data, encoding);
    return { ok: false, file: alt, error: `${path.basename(file)} 被占用（${lastErr && lastErr.code}），已写入 ${path.basename(alt)}` };
  } catch (e2) {
    return { ok: false, file, error: `${path.basename(file)} 写入失败：${e2.message}` };
  }
}

function writeOutputs(outDir, payload, opts = {}) {
  ensureDir(outDir);
  const archive = opts.archive !== false;
  const ts = stamp();
  const jsonLatest = path.join(outDir, 'jd-today-latest.json');
  const csvLatest = path.join(outDir, 'jd-today-latest.csv');

  const files = { json: '', jsonLatest, csv: '', csvLatest, warnings: [] };

  if (archive) {
    files.json = path.join(outDir, `jd-today-products-${ts}.json`);
    files.csv = path.join(outDir, `jd-today-products-${ts}.csv`);
    const r1 = safeWrite(files.json, JSON.stringify(payload, null, 2));
    const r2 = safeWrite(files.csv, toCsv(payload.products));
    if (!r1.ok) files.warnings.push(r1.error);
    if (!r2.ok) files.warnings.push(r2.error);
  }

  const rj = safeWrite(jsonLatest, JSON.stringify(payload, null, 2));
  const rc = safeWrite(csvLatest, toCsv(payload.products));
  if (!rj.ok) files.warnings.push(rj.error);
  if (!rc.ok) files.warnings.push(rc.error);

  if (payload.recommendations && payload.recommendations.length) {
    const recCsvLatest = path.join(outDir, 'jd-today-recommendations-latest.csv');
    const rr = safeWrite(recCsvLatest, toCsv(payload.recommendations));
    if (rr.ok) files.recommendationsCsvLatest = recCsvLatest;
    else files.warnings.push(rr.error);
    if (archive) {
      const recCsv = path.join(outDir, `jd-today-recommendations-${ts}.csv`);
      const rra = safeWrite(recCsv, toCsv(payload.recommendations));
      if (rra.ok) files.recommendationsCsv = recCsv;
    }
  }
  if (payload.trace && archive) {
    const traceFile = path.join(outDir, `trace-${ts}.json`);
    const rt = safeWrite(traceFile, JSON.stringify(payload.trace, null, 2));
    if (rt.ok) files.trace = traceFile;
  }
  return files;
}

function buildPayload({ products, recommendations, summary, audit, seckill, feed, browser, activityName, referenceSkus }) {
  const sources = {
    seckill: seckill ? {
      channel: 'h5static SSR',
      ok: seckill.ok,
      status: seckill.status,
      bytes: seckill.bytes,
      error: seckill.error || '',
      meta: seckill.meta,
    } : null,
    feed: feed ? {
      channel: 'pro.m SSR',
      ok: feed.ok,
      status: feed.status,
      bytes: feed.bytes,
      error: feed.error || '',
      meta: feed.meta,
    } : null,
    browser: browser ? {
      ok: browser.ok,
      channel: browser.channel,
      elapsedMs: browser.elapsedMs,
      apiBlocked: browser.apiBlocked,
      apiEnded: browser.apiEnded,
      domCount: browser.domCount,
      pages: (browser.pages || []).map((p) => ({
        pageNum: p.pageNum, status: p.status, code: p.code, queryCode: p.queryCode,
        floors: p.floors, goods: p.goods,
      })),
      errors: browser.errors || [],
    } : null,
  };

  return {
    meta: {
      activityId: ACTIVITY_ID,
      activityName: activityName || '',
      activityUrl: URLS.h5,
      appUrl: URLS.app,
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Shanghai (UTC+8)',
      crawlerVersion: CRAWLER_VERSION,
      expectedTotal: audit && audit.counts ? audit.counts.expectedTotal : null,
      requiredSkus: audit && audit.counts ? audit.counts.requiredSkus : null,
      fieldSpec: {
        sku: '商品 SKU',
        price: '抢购价（skuPriceInfo.price）',
        listPrice: '日常价（skuPriceInfo.basePrice）',
        jdPrice: '京东价（skuPriceInfo.jdPrice）',
        'saleTime.start': '开抢时间（productExtInfo.stageStartTime / timeBegin）',
        'saleTime.activityDate': '活动日期（productResult.startDate，当天 00:00）',
        'saleTime.round': '当日场次（productExtInfo.round）',
        'stock.status': 'on_sale / upcoming / sold_out / ended / unknown',
        'stock.remainNum': '剩余件数（productExtInfo.skuStockInfo.remainNum）',
        tags: '活动标签（tab/补贴/自营/场次/库存/预约）',
      },
    },
    summary,
    audit,
    products,
    recommendations,
    referenceSkus: referenceSkus || [],
    sources,
    trace: browser ? {
      sessions: (browser.sessions || []).map((s) => ({
        session: s.session,
        ua: s.ua,
        rounds: s.rounds,
        pages: s.pages,
        apiCalls: s.apiCalls,
        domCount: s.domCount,
      })),
      // 页面自己生成的 queryBabelFeeds 请求样本（含 body 字段结构；h5st/eid 仅本次会话有效）
      feedRequests: browser.feedRequests || [],
    } : null,
  };
}

module.exports = { writeOutputs, buildPayload, toCsv, ensureDir };
