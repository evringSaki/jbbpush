'use strict';

/**
 * 单个 SKU 探测（用于核对用户给出的参考商品，例如 100238264645）
 * 只抓商品页的公开标题/店铺信息；价格由前端异步加载，这里不伪造。
 */

const { UA_APP } = require('../config');
const { fetchHtml } = require('../http');

function pick(html, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})"`);
  const m = re.exec(html || '');
  return m ? m[1].trim() : '';
}

async function probeSku(sku, opts = {}) {
  const url = `https://item.m.jd.com/product/${sku}.html`;
  const res = await fetchHtml(url, {
    cookie: opts.cookie || '',
    ua: UA_APP,
    timeout: opts.timeout || 15000,
    retries: 2,
  });
  if (!res.ok) {
    return { sku, url, found: false, error: res.error || `HTTP ${res.status}`, name: '', shop: '' };
  }
  const name = pick(res.html, 'skuName') || pick(res.html, 'name') || '';
  const shop = pick(res.html, 'shopName');
  const venderId = pick(res.html, 'venderId');
  return {
    sku,
    url,
    found: Boolean(name) || res.html.includes(String(sku)),
    name,
    shop,
    venderId,
    price: null, // 商品页价格由前端接口加载，未登录拿不到，不猜
    note: '价格/库存需登录态接口，未在此处伪造',
  };
}

module.exports = { probeSku };
