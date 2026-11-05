'use strict';

/**
 * 腾讯云函数 SCF 入口：匿名抓取「加倍补」并推送到 PushPlus
 *
 * 特点：
 *   - 不需要京东 Cookie（只用服务端直出的 16 条 SSR 数据）
 *   - 不需要浏览器 / Chromium（纯 HTTP，零外部依赖）
 *   - 每次执行约 1~3 秒，5 分钟一次也在免费额度内
 *
 * 环境变量：
 *   PUSHPLUS_TOKEN   必填，PushPlus 的 token
 *   NOTIFY_MODE      change（默认，只在有新增/下架/变动时推）| always（每轮都推）
 *   PUSHPLUS_TOPIC   可选，PushPlus 群组编码（一对多推送）
 *
 * 定时触发器：0 *\/5 * * * * *
 */

const { fetchSeckillSsr } = require('./src/channels/ssr');
const { dedupeBySku, buildSummary } = require('./src/normalize');
const { runPush } = require('./src/report');
const { notify } = require('./src/notify');

const TOKEN = process.env.PUSHPLUS_TOKEN || '';
const MODE = (process.env.NOTIFY_MODE || 'new').toLowerCase();
const TOPIC = process.env.PUSHPLUS_TOPIC || '';

// SCF 只有 /tmp 可写；同一实例复用时基线得以保留，冷启动会退化为“首轮全量”
const OUT_DIR = process.env.OUT_DIR || '/tmp/jd-babel';

async function runOnce() {
  const started = Date.now();

  const seckill = await fetchSeckillSsr({ timeout: 15000, retries: 3 });
  if (!seckill.ok) {
    return { ok: false, stage: 'fetch', error: seckill.error, elapsedMs: Date.now() - started };
  }

  const products = dedupeBySku(seckill.products, ['ssr_app']);
  if (!products.length) {
    return { ok: false, stage: 'parse', error: '解析到 0 条商品（页面可能改版或触发验证）', elapsedMs: Date.now() - started };
  }

  const payload = {
    meta: { expectedTotal: 0, activityName: seckill.activityName || '' },
    summary: buildSummary(products, []),
    // 匿名模式只有 SSR 这 16 条，complete 恒为 true，避免误判“降级”
    audit: { complete: true, counts: { expectedTotal: 0 } },
    products,
  };

  const pushed = runPush({ outDir: OUT_DIR, payload, channel: 'ssr', intervalMin: 5, mode: MODE });

  const added = pushed.diff.added.length;
  const removed = pushed.diff.removed.length;
  const changed = pushed.diff.changed.length;
  const shouldSend = pushed.shouldNotify;

  let sent = null;
  if (!TOKEN) {
    return { ok: false, stage: 'notify', error: '缺少环境变量 PUSHPLUS_TOKEN', elapsedMs: Date.now() - started };
  }

  if (shouldSend) {
    const title = pushed.diff.first
      ? `加倍补 首轮基线 ${products.length} 件`
      : `加倍补 +${added} -${removed} ~${changed}（${products.length} 件）`;
    sent = await notifyWithTitle(pushed.text, title);
  }

  return {
    ok: true,
    products: products.length,
    added,
    removed,
    changed,
    first: pushed.diff.first,
    pushed: shouldSend,
    sent: sent ? sent.ok : null,
    pushError: sent && !sent.ok ? sent.error : undefined,
    elapsedMs: Date.now() - started,
  };
}

/** PushPlus 允许自定义标题，这里单独传，不发群组时也不影响 */
async function notifyWithTitle(text, title) {
  return notify(text, {
    channel: 'pushplus',
    token: TOKEN,
    title,
    topic: TOPIC || undefined,
  });
}

exports.main_handler = async (event, context) => {
  try {
    const result = await runOnce();
    console.log('[jd-babel]', JSON.stringify(result));
    return result;
  } catch (e) {
    console.error('[jd-babel] fatal', e && e.stack ? e.stack : e);
    return { ok: false, stage: 'fatal', error: String((e && e.message) || e) };
  }
};

// 本地调试：node deploy/scf/index.js
if (require.main === module) {
  exports.main_handler({ Type: 'Timer' }, {}).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
