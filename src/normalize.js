'use strict';

const { TAG_MAP, TAB_TODAY, TAB_TOMORROW } = require('./config');

const CRAWLER_VERSION = '1.0.0';

function firstNum(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstStr(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/** 时间戳统一为毫秒；10 位秒级时间戳自动升位 */
function toMs(v) {
  const n = firstNum(v);
  if (n === null) return null;
  if (n > 1e12) return Math.round(n);
  if (n > 1e9) return Math.round(n * 1000);
  return null;
}

/** 固定按北京时间格式化，不受运行机器时区影响 */
function fmtBj(ms) {
  const n = toMs(ms);
  if (!n) return '';
  const d = new Date(n + 8 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function hhmm(ms) {
  const s = fmtBj(ms);
  return s ? s.slice(11, 16) : '';
}

function discountText(price, listPrice) {
  if (!price || !listPrice || price >= listPrice) return '';
  return `${(price / listPrice * 10).toFixed(1)}折`;
}

function uniq(arr, limit = 8) {
  const out = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function mapRawTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => TAG_MAP[t] || '').filter(Boolean);
}

function saleStatusOf({ promoStatus, canSell, soldOut, remainNum, startMs, endMs, now }) {
  if (startMs && now < startMs) return 'upcoming';
  if (soldOut === true || remainNum === 0) return 'sold_out';
  if (endMs && now > endMs) return 'ended';
  if (promoStatus === '1' || canSell === 'Y') return 'on_sale';
  if (promoStatus === '2') return 'upcoming';
  return 'unknown';
}

const STATUS_TEXT = {
  on_sale: '抢购中',
  upcoming: '即将开抢',
  sold_out: '已售罄',
  ended: '已结束',
  unknown: '未知',
};

/**
 * App 构建（h5static）商品 -> 统一结构
 * 数据位置：providerData[0].productResult
 */
function normalizeSeckill(item, tab, ctx) {
  const pr = (item && item.productResult) || {};
  const pe = pr.productExtInfo || {};
  const sp = pe.skuPriceInfo || {};
  const st = pe.skuStockInfo || {};
  const ti = pe.taskInfo || {};
  const now = ctx.now || Date.now();
  const source = ctx.source || 'ssr_app';

  const sku = firstStr(pr.skuId, item.itemIdentityId, pe.jump && pe.jump.params && pe.jump.params.skuId, pr.wareId);
  const name = firstStr(pr.name, pr.shortTitle, pr.wname);
  const price = firstNum(sp.price, pr.promotionPrice, pr.pPrice, pr.displayPrice, pr.jdPrice);
  const listPrice = firstNum(sp.basePrice, sp.jdPrice, pr.jdPrice, pr.pPrice);
  const jdPrice = firstNum(sp.jdPrice, pr.jdPrice);
  const origPrice = firstNum(sp.originalPrice, sp.regularPrice);
  const startMs = toMs(firstNum(pe.stageStartTime, pr.timeBegin, pe.startDate, pr.startDate));
  const endMs = toMs(firstNum(pr.timeEnd, pr.promoEndTime));
  const promoStatus = firstStr(pr.promotionStatus);
  const canSell = firstStr(pr.canSell);
  const soldOut = st.soldOut === true;
  const remainNum = firstNum(st.remainNum, pr.leftPromoStock);
  const soldRate = firstNum(st.soldRate);
  const limitCount = firstNum(st.limitCount, pr.pomotionStock);
  const totalStock = firstNum(pr.pomotionStock, st.limitCount);
  const bookingCount = firstNum(ti.bookingCount);
  const soldPercent = soldRate !== null ? soldRate : (firstNum(pr.productProcess) || null);

  const status = saleStatusOf({ promoStatus, canSell, soldOut, remainNum, startMs, endMs, now });
  // 销售状态与库存状态分开表达：
  //   saleStatusText：抢购中 / 10:00开抢 / 已售罄 / 已结束
  //   stock.statusText：仅剩8件 / 已售60% / 未开抢 / 已售罄
  let saleText = STATUS_TEXT[status];
  if (status === 'upcoming' && startMs) saleText = `${hhmm(startMs)}开抢`;
  let stockText = STATUS_TEXT[status];
  if (status === 'on_sale') {
    if (remainNum !== null) stockText = `仅剩${remainNum}件`;
    else if (soldPercent !== null) stockText = `已售${soldPercent}%`;
    else stockText = '抢购中';
  } else if (status === 'upcoming') {
    stockText = '未开抢';
  }

  const tags = uniq([
    tab || TAB_TODAY,
    ...mapRawTags(pe.tags),
    pe.jdSelf === true ? '京东自营' : '',
    status === 'upcoming' && startMs ? `${hhmm(startMs)}场` : '',
    status === 'on_sale' && soldPercent !== null ? `已售${soldPercent}%` : '',
    status === 'on_sale' && remainNum !== null ? `仅剩${remainNum}件` : '',
    totalStock !== null ? `限量${totalStock}件` : '',
    status === 'upcoming' && bookingCount ? `${bookingCount}人已解锁` : '',
    status === 'sold_out' ? '已售罄' : '',
    status === 'ended' ? '已结束' : '',
    listPrice && price && listPrice > price ? '补贴价' : '',
  ]);

  return {
    sku,
    name,
    url: sku ? `https://item.m.jd.com/product/${sku}.html` : '',
    price,
    priceText: price !== null ? `¥${price}` : '',
    listPrice,
    jdPrice,
    origPrice,
    discount: discountText(price, listPrice),
    saleTime: {
      start: fmtBj(startMs),
      startTs: startMs,
      end: fmtBj(endMs),
      endTs: endMs,
      // 「今日抢购」的日维度：pr.startDate 是当天 00:00，round 是当日场次
      activityDate: fmtBj(firstNum(pe.startDate, pr.startDate)),
      round: firstStr(pe.round, pr.round),
      // 「场次」只对未开抢商品有意义（10:00场/20:00场）；已开抢商品显示具体场次会误导
      label: status === 'upcoming' && startMs ? `${hhmm(startMs)}场` : '',
      source: pe.stageStartTime ? 'productExtInfo.stageStartTime' : (pr.timeBegin ? 'productResult.timeBegin' : ''),
    },
    saleStatus: status,
    saleStatusText: saleText,
    stock: {
      status,
      statusText: stockText,
      remainNum,
      soldPercent,
      limitCount,
      totalStock,
      soldOut,
      canSell,
      bookingCount,
    },
    tags,
    activityTab: tab || TAB_TODAY,
    listType: 'activity',
    source,
    sources: [source],
    capturedAt: ctx.capturedAt || new Date().toISOString(),
    raw: {
      itemIdentityId: firstStr(item.itemIdentityId, pr.skuId),
      promotionStatus: promoStatus,
      stageStatus: pe.stageStatus,
      productProcess: pr.productProcess,
      canSell,
      rawTags: Array.isArray(pe.tags) ? pe.tags : [],
      cornerLabels: Array.isArray(pe.cornerLabels) ? pe.cornerLabels.map((x) => x && x.type).filter(Boolean) : [],
    },
  };
}

/** H5 构建（pro.m）推荐流商品 -> 统一结构（无库存字段） */
function normalizeFeedGoods(g, ctx) {
  const jump = (g && g.jump && g.jump.params) || {};
  const sku = firstStr(jump.skuId, g.skuId, g.wareId);
  const name = firstStr(g.wname, g.name, g.skuName);
  const price = firstNum(g.displayPrice, g.pPrice, g.jdPrice, g.basePrice);
  const listPrice = firstNum(g.jdPrice, g.basePrice);
  const endMs = toMs(g.jdPricePromoEndTime);
  const benefit = Array.isArray(g.benefitList)
    ? g.benefitList.map((b) => b && b.benifitText).filter(Boolean)
    : [];
  const tags = uniq([
    '推荐',
    ...mapRawTags(g.tags),
    g.displayPriceNewDesc && g.displayPriceNewDesc.prefix,
    g.mainLabelDetail && g.mainLabelDetail.labelMessage,
    ...benefit,
  ], 6);

  return {
    sku,
    name,
    url: sku ? `https://item.m.jd.com/product/${sku}.html` : '',
    price,
    priceText: price !== null ? `¥${price}` : '',
    listPrice,
    jdPrice: listPrice,
    origPrice: null,
    discount: discountText(price, listPrice),
    saleTime: {
      start: '',
      startTs: null,
      end: fmtBj(endMs),
      endTs: endMs,
      activityDate: '',
      round: '',
      label: '',
      source: g.jdPricePromoEndTime ? 'jdPricePromoEndTime' : '',
    },
    saleStatus: 'unknown',
    saleStatusText: '推荐位（无库存/开抢信息）',
    stock: {
      status: 'unknown',
      statusText: '未知',
      remainNum: null,
      soldPercent: null,
      limitCount: null,
      totalStock: null,
      soldOut: null,
      canSell: '',
      bookingCount: null,
    },
    tags,
    activityTab: '推荐',
    listType: 'recommendation',
    source: ctx.source || 'ssr_h5_feed',
    sources: [ctx.source || 'ssr_h5_feed'],
    capturedAt: ctx.capturedAt || new Date().toISOString(),
    raw: {
      tags: Array.isArray(g.tags) ? g.tags.slice(0, 8) : [],
      goodsType: g.goodsType,
      shopName: g.shopName || '',
    },
  };
}

/** 按 SKU 去重；重复时保留字段更完整的记录（活动清单优先） */
function dedupeBySku(records, priority = []) {
  const rank = (r) => {
    const i = priority.indexOf(r.source);
    return i === -1 ? 99 : i;
  };
  const map = new Map();
  for (const r of records) {
    if (!r || !r.sku) continue;
    const old = map.get(r.sku);
    if (!old) { map.set(r.sku, r); continue; }
    const keep = rank(r) < rank(old) ? r : old;
    const other = keep === r ? old : r;
    keep.sources = uniq([...(keep.sources || []), ...(other.sources || [])], 5);
    // 用另一条记录补齐缺失的价格/时间
    for (const k of ['price', 'listPrice', 'jdPrice', 'origPrice', 'name']) {
      if ((keep[k] === null || keep[k] === undefined || keep[k] === '') && other[k]) keep[k] = other[k];
    }
    map.set(r.sku, keep);
  }
  return [...map.values()];
}

function buildSummary(products, recommendations) {
  const count = (fn) => products.filter(fn).length;
  return {
    activityTotal: products.length,
    today: count((p) => p.activityTab === TAB_TODAY),
    tomorrow: count((p) => p.activityTab === TAB_TOMORROW),
    onSale: count((p) => p.saleStatus === 'on_sale'),
    upcoming: count((p) => p.saleStatus === 'upcoming'),
    soldOut: count((p) => p.saleStatus === 'sold_out'),
    ended: count((p) => p.saleStatus === 'ended'),
    unknown: count((p) => p.saleStatus === 'unknown'),
    recommendationTotal: recommendations.length,
  };
}

module.exports = {
  CRAWLER_VERSION,
  normalizeSeckill,
  normalizeFeedGoods,
  dedupeBySku,
  buildSummary,
  fmtBj,
  toMs,
  firstNum,
  firstStr,
  discountText,
};
