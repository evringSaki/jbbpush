'use strict';

/**
 * 浏览器通道（可选，用于补齐 H5 推荐流的 queryBabelFeeds 分页）
 *
 * 为什么需要浏览器：
 *   queryBabelFeeds 的请求体带 h5st 签名（时间 + 设备指纹绑定），离线构造/重放会 403；
 *   让页面自己发请求、我们只截获响应，是唯一稳定的翻页方式。
 *
 * 本通道做四件事：
 *   1) 多会话（不同 UA/指纹）打开页面，商品取并集，抵抗会话级个性化；
 *   2) 滚动窗口 + 内部滚动容器 + 点击「上滑更多加载」，触发 pageNum 递增；
 *   3) 截获 queryBabelFeeds 的每一页，记录 pageNum / queryCode / feedTransParam；
 *   4) 用 DOM 上的「抢购价」卡片数做独立计数，校验接口抓到的数量。
 */

const { chromium } = require('playwright-core');
const { URLS, UA_APP, UA_DESKTOP, UA_DESKTOP_EDGE, UA_DESKTOP_MAC } = require('../config');
const { normalizeSeckill, normalizeFeedGoods, dedupeBySku } = require('../normalize');
const { collect } = require('../parse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API_HOST = 'api.m.jd.com';
const FEED_FID = 'queryBabelFeeds';

function log(opts, msg) {
  if (opts.onLog) opts.onLog(msg);
}

async function launchBrowser(opts = {}) {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=zh-CN',
  ];
  const headless = opts.headless !== false;

  // 云端 / 容器：直接指定 chromium 路径，绕过 channel 探测
  const exe = opts.executablePath || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  if (exe) {
    try {
      const browser = await chromium.launch({
        executablePath: exe,
        headless,
        args,
        ignoreDefaultArgs: ['--enable-automation'],
      });
      return { browser, channel: `chromium:${exe}` };
    } catch (e) {
      // 落到下面的 channel 探测
    }
  }

  const candidates = [];
  if (opts.channel) candidates.push(opts.channel);
  for (const c of ['chrome', 'msedge', undefined]) {
    if (!candidates.includes(c)) candidates.push(c);
  }
  let lastErr = null;
  for (const channel of candidates) {
    try {
      const browser = await chromium.launch({
        channel,
        headless,
        args,
        ignoreDefaultArgs: ['--enable-automation'],
      });
      return { browser, channel: channel || 'chromium' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`无法启动浏览器（已尝试 ${exe || 'chrome/msedge/chromium'}）：${lastErr ? lastErr.message : 'unknown'}`);
}

/** 把一个 JSON 响应里所有像商品的对象收集出来 */
function harvestJson(root, ctx, sink) {
  let depth = 0;
  function walk(node) {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    depth++;
    try {
      if (node.itemIdentityId && node.productResult && typeof node.productResult === 'object') {
        const r = normalizeSeckill(node, ctx.tab || '今日抢购', ctx);
        if (r.sku) sink.seckill.push(r);
        return;
      }
      if (Array.isArray(node.goodsList)) {
        for (const g of node.goodsList) {
          if (g && typeof g === 'object' && (g.wareId || g.jdn || (g.jump && g.jump.params))) {
            const r = normalizeFeedGoods(g, ctx);
            if (r.sku) sink.feed.push(r);
          }
        }
      }
      if (node.wareId && (node.wname || node.name) && (node.displayPrice || node.jdPrice)) {
        const r = normalizeFeedGoods(node, ctx);
        if (r.sku) sink.feed.push(r);
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === 'productResult') continue;
        walk(v);
      }
    } finally {
      depth--;
    }
  }
  walk(root);
}

async function runSession(browser, sessionIdx, opts) {
  // 桌面 UA 才能触发 queryBabelFeeds 返回 200（App UA 会走 JSBridge 空壳分支 + 接口 403）
  const uas = [UA_DESKTOP, UA_DESKTOP_EDGE, UA_DESKTOP_MAC];
  const ua = uas[(sessionIdx - 1) % uas.length];
  const capturedAt = new Date().toISOString();

  // --cdp 模式：复用用户已登录浏览器的默认 context（保留 Cookie/登录态），不新建指纹
  let ctx = null;
  let ownContext = true;
  if (opts.cdp) {
    ctx = browser.contexts()[0] || null;
    if (ctx) ownContext = false;
  }
  if (!ctx) {
    ctx = await browser.newContext({
      userAgent: ua,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
  }

  // 重要：不要 addInitScript 覆盖 navigator.webdriver/languages/plugins。
  // 实测（AB 对照）这种“降低自动化特征”的写法反而触发京东反爬：
  //   queryBabelFeeds 从 2 次降到 1 次，卡片从 29 掉到 16。
  // 保持默认指纹即可，页面反而正常渲染 29 条。

  if (opts.cookie) {
    // Cookie 只发给 .jd.com 域，避免泄露到第三方
    const pairs = String(opts.cookie).split(';').map((x) => x.trim()).filter(Boolean);
    const cookies = pairs.map((p) => {
      const i = p.indexOf('=');
      return { name: p.slice(0, i), value: p.slice(i + 1), domain: '.jd.com', path: '/' };
    }).filter((c) => c.name);
    if (cookies.length) await ctx.addCookies(cookies).catch(() => {});
  }

  const page = await ctx.newPage();
  const sink = { seckill: [], feed: [] };
  const apiCalls = [];
  const feedRequests = [];
  const pageRecords = [];
  let inflight = 0;
  let apiEnded = false;
  let apiBlocked = false;
  let apiCodeError = '';

  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes(FEED_FID)) return;
    inflight++;
    if (feedRequests.length < 2) {
      const h = req.headers();
      feedRequests.push({
        url: u,
        headers: {
          referer: h.referer || '',
          'x-rp-client': h['x-rp-client'] || '',
          'x-babel-actid': h['x-babel-actid'] || '',
          'x-referer-page': h['x-referer-page'] || '',
          'user-agent': h['user-agent'] || '',
        },
        // 只保留前 6KB，够看清字段结构；h5st/eid 属于本次会话，敏感
        postData: (req.postData() || '').slice(0, 6000),
        postDataBytes: (req.postData() || '').length,
      });
    }
  });
  page.on('requestfailed', (req) => {
    if (!req.url().includes(FEED_FID)) return;
    inflight = Math.max(0, inflight - 1);
    apiBlocked = true;
  });

  page.on('response', async (res) => {
    const u = res.url();
    if (!u.includes(API_HOST)) return;
    const fid = (u.match(/functionId=([A-Za-z0-9_]+)/) || [])[1] || 'unknown';
    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      if (fid === FEED_FID) inflight = Math.max(0, inflight - 1);
      return;
    }
    const rec = {
      fid,
      status: res.status(),
      bytes: text.length,
      pageNum: null,
      code: '',
      queryCode: '',
      floors: 0,
      goods: 0,
      feedTransParam: '',
    };
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object') {
        rec.pageNum = j.pageNum != null ? Number(j.pageNum) : null;
        rec.code = String(j.code == null ? '' : j.code);
        rec.queryCode = String(j.queryCode == null ? '' : j.queryCode);
        rec.floors = Array.isArray(j.floorList) ? j.floorList.length : 0;
        rec.goods = Array.isArray(j.goodsList) ? j.goodsList.length : 0;
        rec.feedTransParam = j.feedTransParam ? String(j.feedTransParam).slice(0, 80) : '';
        harvestJson(j, { capturedAt, tab: '今日抢购', source: 'browser_api' }, sink);
      }
    } catch (e) {
      // 非 JSON（风控页/空响应）
    }
    if (fid === FEED_FID) {
      pageRecords.push(rec);
      if (res.status() === 403 || res.status() === 0 || rec.code === '403') apiBlocked = true;
      if (rec.code && rec.code !== '0') apiCodeError = rec.code;
      if (rec.queryCode === '1') apiEnded = true;
      if (rec.code === '0' && rec.queryCode !== '1' && rec.floors === 0) apiEnded = true;
      inflight = Math.max(0, inflight - 1);
    }
    if (apiCalls.length < 80) apiCalls.push(rec);
  });

  async function settle(maxMs) {
    const until = Date.now() + maxMs;
    while (inflight > 0 && Date.now() < until) await sleep(300);
  }

  async function stats() {
    return page.evaluate(() => {
      const t = document.body.innerText || '';
      const cards = (t.match(/抢购价/g) || []).length;
      const skuSet = new Set();
      for (const el of document.querySelectorAll('[data-sku],[data-skuid],[data-itemid]')) {
        const v = el.getAttribute('data-sku') || el.getAttribute('data-skuid') || el.getAttribute('data-itemid');
        if (v && /^\d{5,}$/.test(v)) skuSet.add(v);
      }
      const se = document.scrollingElement || document.documentElement;
      return {
        y: Math.round(window.scrollY),
        h: se ? se.scrollHeight : 0,
        bottom: se ? window.innerHeight + window.scrollY >= se.scrollHeight - 80 : false,
        cards,
        skuEls: skuSet.size,
        tail: t.replace(/\s+/g, ' ').slice(-140),
      };
    }).catch(() => ({ y: 0, h: 0, bottom: false, cards: 0, skuEls: 0, tail: '' }));
  }

  async function scrollOnce() {
    await page.evaluate(() => {
      // 桌面 UA 下页面是普通 window 滚动，逐屏往下滚即可触发懒加载；
      // 内部滚动容器的处理反而会把页面滚乱，这里不再碰它
      const step = Math.round(window.innerHeight * 0.85);
      window.scrollBy(0, step);
      try {
        window.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true }));
      } catch (e) {}
    }).catch(() => {});
  }

  let rounds = 0;
  try {
    // 会话 1 用 App 构建（有 16 条 SSR 兜底）；会话 2 用 H5 构建（推荐流首屏更全），交替
    const baseUrl = sessionIdx === 1 || sessionIdx % 2 === 1 ? URLS.app : URLS.h5;
    const url = sessionIdx === 1 ? baseUrl : `${baseUrl}&_s=${sessionIdx}_${Date.now()}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 等首屏 SSR 渲染 + 页面自身完成首批接口（桌面 UA 下 queryBabelFeeds 约 6~9s 才发）
    const waitUntil = Date.now() + 15000;
    let s0 = await stats();
    while (s0.cards === 0 && Date.now() < waitUntil) {
      await sleep(800);
      s0 = await stats();
    }
    await sleep(3000); // 给懒加载接口留出首次触发时间

    let idle = 0;
    let lastH = s0.h;
    let sameH = 0;
    for (let i = 0; i < (opts.maxScroll || 30); i++) {
      rounds = i + 1;
      const before = sink.seckill.length + sink.feed.length;
      await scrollOnce();
      await sleep(1300 + Math.floor(Math.random() * 700));

      // 关键：不要每轮都读 document.body.innerText，那是重操作，会阻塞页面主线程，
      // 导致 queryBabelFeeds 懒加载请求迟迟不触发。只在每隔 5 轮（或最后）采样一次。
      let s = { y: 0, h: lastH, bottom: false, cards: 0, skuEls: 0, tail: '' };
      if (i % 5 === 0 || i === (opts.maxScroll || 30) - 1) {
        s = await stats();
        if (s.h === lastH) sameH++; else { sameH = 0; lastH = s.h; }
        const after = sink.seckill.length + sink.feed.length;
        if (after > before) idle = 0; else if (inflight === 0) idle++;
        log(opts, `[会话${sessionIdx}] 滚动 ${i + 1}/${opts.maxScroll || 30}：高度=${s.h} 卡片=${s.cards} 商品=${after} 页码=${pageRecords.map((p) => p.pageNum).filter(Boolean).join(',') || '-'}`);
      }

      // 接口明确返回“没有下一页”才允许提前结束；接口报错不能当结束
      if (apiEnded && sameH >= 3) break;
      if (apiBlocked && i >= 5 && sameH >= 4) break;
      if (idle >= 8 && sameH >= 3) break;
    }
  } catch (e) {
    apiCodeError = apiCodeError || e.message.slice(0, 120);
  }

  // 从页面自身的 window.__react_data__ 取一份商品：
  // 即使 queryBabelFeeds 被 403，SSR 楼层仍在，可作为浏览器通道的兜底数据
  try {
    const pageData = await page.evaluate(() => {
      try { return window.__react_data__ || null; } catch (e) { return null; }
    });
    if (pageData && pageData.activityData) {
      const collected = collect(pageData.activityData);
      for (const { tab, node } of collected.seckill) {
        const r = normalizeSeckill(node, tab, { capturedAt, source: 'browser_ssr' });
        if (r.sku) sink.seckill.push(r);
      }
      for (const { feeds } of collected.feeds) {
        for (const g of feeds.goodsList || []) {
          const r = normalizeFeedGoods(g, { capturedAt, source: 'browser_ssr_feed' });
          if (r.sku) sink.feed.push(r);
        }
      }
    }
  } catch (e) {}

  const finalStats = await stats();
  if (ownContext) await ctx.close().catch(() => {});
  else await page.close().catch(() => {});
  return {
    session: sessionIdx,
    ua,
    products: dedupeBySku([...sink.seckill, ...sink.feed], ['ssr_app']),
    seckill: dedupeBySku(sink.seckill, ['ssr_app']),
    feed: dedupeBySku(sink.feed, ['ssr_h5_feed']),
    pages: pageRecords,
    apiCalls,
    feedRequests,
    apiEnded,
    apiBlocked,
    apiCodeError,
    domCount: Math.max(finalStats.cards, finalStats.skuEls),
    rounds,
    finalStats,
  };
}

async function crawlWithBrowser(opts = {}) {
  const sessions = Math.max(1, Number(opts.sessions || 1));
  const started = Date.now();
  let browser;
  let channel = '';
  try {
    if (opts.cdp) {
      // 连接用户已经启动的 Chrome/Edge（--remote-debugging-port=9222），复用其登录态
      browser = await chromium.connectOverCDP(opts.cdp);
      channel = 'cdp';
    } else {
      const launched = await launchBrowser(opts);
      browser = launched.browser;
      channel = launched.channel;
    }
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      channel: '',
      sessions: [],
      products: [],
      pages: [],
      domCount: 0,
      apiBlocked: false,
      apiEnded: false,
      elapsedMs: Date.now() - started,
    };
  }

  const results = [];
  for (let i = 1; i <= sessions; i++) {
    if (i > 1) await sleep(1500);
    log(opts, `[浏览器] 会话 ${i}/${sessions} 开始（${channel}）`);
    try {
      const r = await runSession(browser, i, opts);
      results.push(r);
      log(opts, `[浏览器] 会话 ${i} 完成：商品 ${r.products.length}，卡片 ${r.domCount}，接口页 ${r.pages.length}，403=${r.apiBlocked}`);
    } catch (e) {
      log(opts, `[浏览器] 会话 ${i} 异常：${e.message}`);
      results.push({
        session: i, ua: '', products: [], seckill: [], feed: [], pages: [], apiCalls: [],
        apiEnded: false, apiBlocked: false, apiCodeError: e.message.slice(0, 120),
        domCount: 0, rounds: 0, finalStats: {},
      });
    }
  }
  // 对 connectOverCDP 而言 close() 只断开连接，不会关闭用户浏览器（实测）
  await browser.close().catch(() => {});

  const all = results.flatMap((r) => r.products);
  const products = dedupeBySku(all, ['ssr_app']);
  const pages = results.flatMap((r) => r.pages);
  const domCount = Math.max(0, ...results.map((r) => r.domCount));
  return {
    ok: products.length > 0 || domCount > 0 || pages.length > 0,
    channel,
    sessions: results,
    products,
    pages,
    feedRequests: results.flatMap((r) => r.feedRequests || []),
    domCount,
    apiBlocked: results.some((r) => r.apiBlocked),
    apiEnded: results.some((r) => r.apiEnded),
    errors: results.map((r) => r.apiCodeError).filter(Boolean),
    elapsedMs: Date.now() - started,
  };
}

module.exports = { crawlWithBrowser, launchBrowser, harvestJson };
