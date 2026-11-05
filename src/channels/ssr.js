'use strict';

const { URLS, UA_APP, UA_MOBILE, EDGE_IPS } = require('../config');
const { fetchHtml } = require('../http');
const { parseActivity, extractActivityName } = require('../parse');
const { normalizeSeckill, normalizeFeedGoods, dedupeBySku } = require('../normalize');

function nowIso() {
  return new Date().toISOString();
}

/**
 * 主数据源：App 内置页（h5static）
 * 商品由服务端直出到 __react_data__，一次请求即可拿到「今日抢购」全量清单，
 * 不依赖滚动、不依赖 queryBabelFeeds（该接口带 h5st 签名且匿名访问常被 403）。
 */
async function fetchSeckillSsr(opts = {}) {
  const capturedAt = nowIso();
  const res = await fetchHtml(URLS.app, {
    cookie: opts.cookie || '',
    ua: UA_APP,
    timeout: opts.timeout || 20000,
    retries: opts.retries || 3,
    referer: 'https://h5static.m.jd.com/',
  });
  if (!res.ok) {
    return {
      ok: false, products: [], meta: null, capturedAt,
      error: res.error || `HTTP ${res.status}`, bytes: res.bytes, status: res.status,
    };
  }
  const parsed = parseActivity(res.html);
  if (!parsed.ok) {
    return { ok: false, products: [], meta: null, capturedAt, error: parsed.error, bytes: res.bytes, status: res.status };
  }
  const products = dedupeBySku(
    parsed.collected.seckill.map(({ tab, node }) => normalizeSeckill(node, tab, { capturedAt })),
    ['ssr_app']
  );
  // 原始 HTML 里 itemIdentityId 的出现次数：用于证明解析器没有漏掉商品楼层
  parsed.meta.rawItemIdentityCount = (res.html.match(/"itemIdentityId"\s*:/g) || []).length;
  return {
    ok: products.length > 0,
    products,
    meta: parsed.meta,
    activityName: extractActivityName(res.html, ''),
    capturedAt,
    bytes: res.bytes,
    status: res.status,
    error: products.length ? '' : 'SSR 中未解析到商品楼层',
  };
}

/**
 * 补充数据源：H5 页（pro.m）
 * 该构建把商品放在 feeds.goodsList，属于推荐位，并且只直出第一页；
 * feeds.hasNextPage=true 时，剩余数据必须由浏览器通道翻页补齐。
 */
async function fetchFeedSsr(opts = {}) {
  const capturedAt = nowIso();
  let res = null;
  let parsed = null;
  // pro.m 偶尔会返回“京东验证”/CSR 空壳：换 UA、换 CDN 边缘再试
  const attempts = [
    { ua: UA_APP, ip: '' },
    ...EDGE_IPS.map((ip) => ({ ua: UA_APP, ip })),
    { ua: UA_MOBILE, ip: '' },
  ];
  for (const { ua, ip } of attempts) {
    res = await fetchHtml(URLS.h5, {
      cookie: opts.cookie || '',
      ua,
      timeout: opts.timeout || 20000,
      retries: ip ? 1 : (opts.retries || 3),
      referer: 'https://pro.m.jd.com/',
      resolveIp: ip,
    });
    if (!res.ok) continue;
    parsed = parseActivity(res.html);
    if (parsed.ok) break;
  }
  if (!res || !res.ok) {
    return {
      ok: false, products: [], meta: null, capturedAt,
      error: (res && (res.error || `HTTP ${res.status}`)) || 'fetch failed', bytes: res ? res.bytes : 0, status: res ? res.status : 0,
    };
  }
  if (!parsed || !parsed.ok) {
    return { ok: false, products: [], meta: null, capturedAt, error: parsed ? parsed.error : 'parse failed', bytes: res.bytes, status: res.status };
  }
  const all = [];
  for (const { feeds } of parsed.collected.feeds) {
    for (const g of feeds.goodsList) all.push(normalizeFeedGoods(g, { capturedAt }));
  }
  const products = dedupeBySku(all, ['ssr_h5_feed']);
  parsed.meta.rawWareIdCount = (res.html.match(/"wareId"\s*:/g) || []).length;
  return {
    ok: products.length > 0,
    products,
    meta: parsed.meta,
    activityName: extractActivityName(res.html, ''),
    capturedAt,
    bytes: res.bytes,
    status: res.status,
    error: products.length ? '' : 'H5 SSR 中未解析到 feeds.goodsList',
  };
}

module.exports = { fetchSeckillSsr, fetchFeedSsr };
