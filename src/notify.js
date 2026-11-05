'use strict';

/**
 * 推送通道：把播报文本发到手机 / 群里
 *
 * 支持（--notify <channel>）：
 *   wecom       企业微信群机器人   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *   feishu      飞书自定义机器人   https://open.feishu.cn/open-apis/bot/v2/hook/xxx
 *   dingtalk    钉钉自定义机器人   https://oapi.dingtalk.com/robot/send?access_token=xxx
 *   bark        iOS Bark          https://api.day.app/<你的key>
 *   serverchan  Server酱          https://sctapi.ftqq.com/<SendKey>.send
 *   telegram    Telegram Bot      https://api.telegram.org/bot<token>/sendMessage （需 --notify-chat）
 *   generic     任意 webhook      POST {"text": "..."}
 *
 * 用法：
 *   node src/cli.js --push --notify wecom --notify-url "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
 *   NOTIFY_CHANNEL=bark NOTIFY_URL=https://api.day.app/xxx node src/cli.js --push
 */

const http = require('http');
const https = require('https');

// 各通道单条消息的软上限（字符），超出按行切块多发几条
const LIMITS = {
  wecom: 1800,
  feishu: 12000,
  dingtalk: 12000,
  bark: 2500,
  serverchan: 20000,
  pushplus: 18000,
  telegram: 3500,
  generic: 12000,
};

function request(url, { method = 'POST', headers = {}, body, timeout = 12000, okCodes = [] } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ ok: false, error: `URL 不合法：${url}` });
    }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(payload ? { 'Content-Length': payload.byteLength } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(buf); } catch (e) {}
          // 企业微信/飞书/钉钉都用 code/errcode/StatusCode 表示业务错误；
          // PushPlus 用 code=200 表示成功，所以允许调用方指定成功码
          const bizCode = parsed && (parsed.errcode != null ? parsed.errcode : (parsed.code != null ? parsed.code : parsed.StatusCode));
          const bizOk = bizCode == null || bizCode === 0 || okCodes.includes(bizCode);
          const ok = res.statusCode >= 200 && res.statusCode < 300 && bizOk;
          resolve({ ok, status: res.statusCode, bizCode, body: buf.slice(0, 300) });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 按行切块，尽量不拆散一条商品 */
function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > limit) {
      out.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
    // 单行超长（极长商品名）时硬切
    while (cur.length > limit) {
      out.push(cur.slice(0, limit));
      cur = cur.slice(limit);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function buildRequest(channel, url, text, opts) {
  const title = opts.title || '加倍补 商品更新';
  switch (channel) {
    case 'wecom':
      return { url, body: { msgtype: 'text', text: { content: text } } };
    case 'feishu':
      return { url, body: { msg_type: 'text', content: { text } } };
    case 'dingtalk':
      return { url, body: { msgtype: 'text', text: { content: text } } };
    case 'bark': {
      // Bark 支持 POST /  body: {title, body}
      const base = url.replace(/\/+$/, '');
      return { url: `${base}`, body: { title, body: text, group: 'jd-babel' } };
    }
    case 'serverchan': {
      const target = /\.send$/.test(url) ? url : `${url.replace(/\/+$/, '')}.send`;
      return { url: target, body: { title, desp: text } };
    }
    case 'pushplus': {
      // PushPlus：token 可以直接写在 --notify-token，也可以放进 URL
      const token = opts.token || (url && !/^https?:/i.test(url) ? url : '');
      const target = /^https?:/i.test(url) ? url : 'https://www.pushplus.plus/send';
      const body = { token, title, content: text, template: 'txt' };
      if (opts.topic) body.topic = opts.topic;
      return { url: target, body, okCodes: [200] };
    }
    case 'telegram': {
      const target = /sendMessage$/.test(url) ? url : `${url.replace(/\/+$/, '')}/sendMessage`;
      return { url: target, body: { chat_id: opts.chatId || '', text, disable_web_page_preview: true } };
    }
    case 'generic':
    default:
      return { url, body: { text, title } };
  }
}

/**
 * @returns {Promise<{ok:boolean, sent:number, results:Array, error?:string}>}
 */
async function notify(text, opts = {}) {
  const channel = (opts.channel || 'generic').toLowerCase();
  const url = opts.url || '';
  if (channel === 'pushplus') {
    if (!url && !opts.token) return { ok: false, sent: 0, results: [], error: '缺少 PushPlus token（--notify-token 或 --notify-url）' };
  } else if (!url) {
    return { ok: false, sent: 0, results: [], error: '缺少 --notify-url' };
  }
  if (!LIMITS[channel] && channel !== 'generic') {
    return { ok: false, sent: 0, results: [], error: `未知通道 ${channel}` };
  }

  const limit = LIMITS[channel] || 12000;
  const parts = chunkText(text, limit);
  const results = [];

  for (let i = 0; i < parts.length; i++) {
    const { url: target, body, okCodes } = buildRequest(channel, url, parts[i], opts);
    const r = await request(target, { body, okCodes });
    results.push({ part: i + 1, total: parts.length, ...r });
    if (!r.ok) break;
    if (i < parts.length - 1) await new Promise((res) => setTimeout(res, 350)); // 避开机器人限频
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  return {
    ok,
    sent: results.filter((r) => r.ok).length,
    parts: parts.length,
    results,
    error: ok ? undefined : (results.find((r) => !r.ok) || {}).error || (results.find((r) => !r.ok) || {}).body || '发送失败',
  };
}

module.exports = { notify, chunkText, LIMITS };
