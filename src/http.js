'use strict';

const https = require('https');
const { UA_APP, VERIFY_PHRASES } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVerifyPage(html) {
  if (!html) return false;
  return VERIFY_PHRASES.some((p) => html.includes(p));
}

/**
 * 指定 CDN 边缘 IP 抓 HTML：
 * 默认 DNS 偶尔会解析到“京东验证”页，换一个边缘（同一 Host/SNI）即可恢复 SSR。
 */
function fetchViaIp(url, { ip, headers, timeout = 20000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { ...headers, 'Accept-Encoding': 'identity' },
      ...(ip ? { lookup: (hostname, opts, cb) => cb(null, ip, 4) } : {}),
      ...(ip ? { servername: u.hostname } : {}),
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const html = buf.toString('utf8');
        const ok = res.statusCode >= 200 && res.statusCode < 300 && !isVerifyPage(html);
        resolve({
          ok,
          status: res.statusCode || 0,
          html,
          bytes: buf.length,
          error: ok ? '' : (res.statusCode >= 300 ? `HTTP ${res.statusCode}` : 'verify-page'),
          url,
          ip,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({
      ok: false, status: 0, html: '', bytes: 0,
      error: e.message || 'request failed', url, ip,
    }));
    req.end();
  });
}

/**
 * 抓取 HTML（自动重试 + 超时 + 验证页识别）
 * Node 18+ 的 fetch 自带 gzip/br 解压，这里无需手工解压。
 */
async function fetchHtml(url, opts = {}) {
  const {
    cookie = '',
    ua = UA_APP,
    timeout = 20000,
    retries = 3,
    referer = '',
    accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    resolveIp = '',
  } = opts;

  const baseHeaders = {
    'User-Agent': ua,
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    ...(referer ? { Referer: referer } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };

  // 指定边缘 IP 时走 https.request（可自定义 DNS lookup）
  if (resolveIp) {
    return fetchViaIp(url, { ip: resolveIp, headers: baseHeaders, timeout });
  }

  // Node 16 及更老的云函数运行时没有全局 fetch，退回 https.request（带重试）
  if (typeof fetch !== 'function') {
    let last = { ok: false, status: 0, html: '', bytes: 0, error: 'not-started', url };
    for (let attempt = 1; attempt <= retries; attempt++) {
      last = await fetchViaIp(url, { headers: baseHeaders, timeout });
      if (last.ok) return last;
      if (attempt < retries) await sleep(1200 * attempt + Math.floor(Math.random() * 800));
    }
    return last;
  }

  let last = { ok: false, status: 0, html: '', bytes: 0, error: 'not-started', url };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: ac.signal,
        headers: baseHeaders,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const html = buf.toString('utf8');
      last = {
        ok: res.ok && !isVerifyPage(html),
        status: res.status,
        html,
        bytes: buf.length,
        error: res.ok ? (isVerifyPage(html) ? 'verify-page' : '') : `HTTP ${res.status}`,
        url: res.url || url,
      };
      if (last.ok) return last;
    } catch (e) {
      last = {
        ok: false,
        status: 0,
        html: '',
        bytes: 0,
        error: e.name === 'AbortError' ? 'timeout' : e.message,
        url,
      };
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(1200 * attempt + Math.floor(Math.random() * 800));
  }
  return last;
}

/** 从 HTML 中提取 <title>（用于确认拿到的是不是目标活动页） */
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

module.exports = { fetchHtml, sleep, isVerifyPage, extractTitle };
