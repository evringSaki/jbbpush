#!/usr/bin/env node
'use strict';

/**
 * 京东「今日抢购」全量采集 CLI
 *
 * 用法：
 *   node src/cli.js                         # 默认：SSR 双通道（快，约 1~3 秒）
 *   node src/cli.js --browser               # 追加浏览器通道，补齐推荐流分页
 *   node src/cli.js --cdp http://127.0.0.1:9222   # 连接已登录 Edge，抓全 29 条
 *   node src/cli.js --cookie "pt_key=...; pt_pin=..."   # 带登录态（可显著提高接口成功率/商品数）
 *
 * 常用参数：
 *   --out ./data          输出目录
 *   --cdp <url>           连接已登录浏览器（如 http://127.0.0.1:9222）
 *   --sessions 2          浏览器会话数（取并集）
 *   --max-scroll 30       每个会话最大滚动轮数
 *   --headed              有头浏览器（排查风控时用）
 *   --no-strict           校验不通过也返回 0（默认不通过返回 3）
 *   --trace               输出接口调用明细到 data/trace-*.json
 */

const fs = require('fs');
const path = require('path');
const { URLS, ACTIVITY_ID, DEFAULT_OUT_DIR, EXPECTED_TOTAL, REQUIRED_SKUS, ACTIVITY_NAME } = require('./config');
const { fetchSeckillSsr, fetchFeedSsr } = require('./channels/ssr');
const { crawlWithBrowser } = require('./channels/browser');
const { probeSku } = require('./channels/sku');
const { dedupeBySku, buildSummary, CRAWLER_VERSION } = require('./normalize');
const { buildAudit } = require('./validate');
const { writeOutputs, buildPayload, ensureDir } = require('./output');

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT_DIR,
    browser: false,
    headless: true,
    sessions: 1,
    maxScroll: 30,
    strict: true,
    timeout: 20000,
    cookie: process.env.JD_COOKIE || '',
    trace: false,
    quiet: false,
    json: false,
    channel: process.env.BROWSER_CHANNEL || '',
    cdp: process.env.CDP_URL || '',
    expect: Number(process.env.EXPECTED_TOTAL || EXPECTED_TOTAL) || 0,
    requireSkus: REQUIRED_SKUS.slice(),
    push: false,
    verbose: false,
    notify: process.env.NOTIFY_CHANNEL || '',
    notifyUrl: process.env.NOTIFY_URL || '',
    notifyChat: process.env.NOTIFY_CHAT || '',
    notifyToken: process.env.NOTIFY_TOKEN || '',
    notifyMode: process.env.NOTIFY_MODE || 'new',
    interval: Number(process.env.PUSH_INTERVAL || 5) || 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--browser') args.browser = true;
    else if (a === '--no-browser') args.browser = false;
    else if (a === '--headed') args.headless = false;
    else if (a === '--headless') args.headless = true;
    else if (a === '--sessions') args.sessions = Math.max(1, Number(next()) || 1);
    else if (a === '--max-scroll') args.maxScroll = Math.max(1, Number(next()) || 30);
    else if (a === '--timeout') args.timeout = Math.max(5000, Number(next()) || 20000);
    else if (a === '--cookie') args.cookie = next();
    else if (a === '--expect') args.expect = Math.max(0, Number(next()) || 0);
    else if (a === '--no-expect') args.expect = 0;
    else if (a === '--require-sku') {
      const list = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
      args.requireSkus = args.requireSkus.concat(list);
    }
    else if (a === '--strict') args.strict = true;
    else if (a === '--no-strict') args.strict = false;
    else if (a === '--trace') args.trace = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--json') args.json = true;
    else if (a === '--channel') args.channel = next();
    else if (a === '--cdp') { args.cdp = next(); args.browser = true; }
    else if (a === '--push') args.push = true;
    else if (a === '--notify') args.notify = next();
    else if (a === '--notify-url') args.notifyUrl = next();
    else if (a === '--notify-chat') args.notifyChat = next();
    else if (a === '--notify-token') args.notifyToken = next();
    else if (a === '--notify-mode') args.notifyMode = next();
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--interval') args.interval = Math.max(1, Number(next()) || 5);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, ''));
      process.exit(0);
    }
  }
  // 推送模式下 stdout 只保留播报内容，采集日志静默
  if (args.push && !args.verbose) args.quiet = true;
  return args;
}

function ts() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
}

function log(args, msg) {
  if (!args.quiet) console.log(`[${ts()}] ${msg}`);
}

function line(char = '─', n = 64) {
  return char.repeat(n);
}

/**
 * 把本轮播报推到手机/群里
 * 默认只在「有新增/下架/变动」时发；degraded 状态最多 30 分钟提醒一次，避免刷屏。
 */
async function deliver(args, pushed, outDir) {
  const { diff, degraded } = pushed;
  const removed = degraded ? 0 : diff.removed.length;
  const changed = diff.added.length + removed + diff.changed.length;
  // runPush 已按 mode 算好：new=只推上新 / change=推新增下架变动 / always=每轮
  let shouldSend = pushed.shouldNotify === undefined
    ? (args.notifyMode === 'always' || diff.first || changed > 0)
    : pushed.shouldNotify;

  if (degraded && !shouldSend) {
    const stateFile = path.join(outDir, 'push', 'state.json');
    let st = {};
    try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {}
    const last = st.lastDegradedNotify ? Date.parse(st.lastDegradedNotify) : 0;
    if (Date.now() - last > 30 * 60 * 1000) {
      shouldSend = true;
      st.lastDegradedNotify = new Date().toISOString();
      try { fs.writeFileSync(stateFile, JSON.stringify(st)); } catch (e) {}
    }
  }

  if (!shouldSend) {
    log(args, '[推送] 本轮无变化，跳过');
    return null;
  }

  if (args.notify === 'desktop') {
    const { execFile } = require('child_process');
    const ps = path.join(__dirname, '..', 'scripts', 'toast.ps1');
    await new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { timeout: 15000 }, () => resolve());
    });
    log(args, '[推送] 桌面通知已发出');
    return { ok: true };
  }

  if (!args.notifyUrl) {
    console.error('[推送] 缺少 --notify-url（或环境变量 NOTIFY_URL），本轮未推送');
    return { ok: false, error: 'missing-notify-url' };
  }

  const { notify } = require('./notify');
  const r = await notify(pushed.text, {
    channel: args.notify,
    url: args.notifyUrl,
    chatId: args.notifyChat,
    token: args.notifyToken,
  });

  if (r.ok) {
    log(args, `[推送] 已发送 ${args.notify}（${r.parts} 条）`);
  } else {
    console.error(`[推送] 失败：${r.error}`);
  }
  return r;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  log(args, `京东「今日抢购」采集 ${CRAWLER_VERSION}  活动 ${URLS.h5}`);
  log(args, `数据源：App SSR（活动清单） + H5 SSR（推荐位）${args.browser ? ' + 浏览器分页' : ''}`);

  // ── 1) 双 SSR 通道并行 ─────────────────────────────────────────────
  const [seckill, feed] = await Promise.all([
    fetchSeckillSsr({ cookie: args.cookie, timeout: args.timeout }),
    fetchFeedSsr({ cookie: args.cookie, timeout: args.timeout }),
  ]);

  log(args, `[1/3] App SSR  ：${seckill.ok ? `${seckill.products.length} 条活动商品 / ${(seckill.bytes / 1024).toFixed(0)} KB` : `失败：${seckill.error}`}`);
  log(args, `[2/3] H5 SSR   ：${feed.ok ? `${feed.products.length} 条推荐 / ${(feed.bytes / 1024).toFixed(0)} KB，hasNextPage=${feed.meta && feed.meta.feedHasNextPage}` : `失败：${feed.error}`}`);

  // ── 2) 浏览器通道（可选）──────────────────────────────────────────
  let browser = null;
  if (args.browser) {
    log(args, `[3/3] 浏览器通道：启动 ${args.sessions} 个会话 ...`);
    browser = await crawlWithBrowser({
      sessions: args.sessions,
      maxScroll: args.maxScroll,
      headless: args.headless,
      cookie: args.cookie,
      channel: args.channel,
      cdp: args.cdp,
      executablePath: process.env.CHROME_PATH || '',
      onLog: (m) => log(args, m),
    });
    if (browser.ok) {
      const bSec = (browser.sessions || []).reduce((n, s) => n + (s.seckill || []).length, 0);
      const bFeed = (browser.sessions || []).reduce((n, s) => n + (s.feed || []).length, 0);
      log(args, `[3/3] 浏览器通道：商品 ${browser.products.length} 条（活动 ${bSec} / 推荐 ${bFeed}），DOM 卡片 ${browser.domCount}，接口页 ${(browser.pages || []).length}，403=${browser.apiBlocked}`);
    } else {
      log(args, `[3/3] 浏览器通道：失败/无数据 ${browser.error || ''}`);
    }
  } else {
    log(args, '[3/3] 浏览器通道：跳过（加 --browser 启用，用于补齐推荐流分页）');
  }

  // ── 3) 合并 ───────────────────────────────────────────────────────
  const browserSeckill = browser ? (browser.sessions || []).flatMap((s) => s.seckill || []) : [];
  const browserFeed = browser ? (browser.sessions || []).flatMap((s) => s.feed || []) : [];

  const activity = dedupeBySku(
    [...seckill.products, ...browserSeckill],
    ['ssr_app', 'browser']
  );
  const activitySkus = new Set(activity.map((p) => p.sku));
  const recommendations = dedupeBySku(
    [...feed.products, ...browserFeed].filter((p) => !activitySkus.has(p.sku)),
    ['ssr_h5_feed', 'browser']
  );

  const activityName = feed.activityName || seckill.activityName || ACTIVITY_NAME;
  const summary = buildSummary(activity, recommendations);

  // ── 4) 校验（读上一轮快照做基线）──────────────────────────────────
  let previous = null;
  const latest = path.join(args.out, 'jd-today-latest.json');
  if (fs.existsSync(latest)) {
    try {
      const prev = JSON.parse(fs.readFileSync(latest, 'utf8'));
      previous = { total: Array.isArray(prev.products) ? prev.products.length : 0 };
    } catch (e) {}
  }
  const audit = buildAudit({
    products: activity, recommendations, seckill, feed, browser, previous, activityName,
    expectedTotal: args.expect,
    requiredSkus: args.requireSkus,
  });

  // 参考 SKU 核对：用户给出的商品如果不在结果里，至少把公开标题/店铺抓回来，方便确认抓的是同一个商品
  let referenceSkus = [];
  if (audit.counts.missingRequired.length) {
    referenceSkus = await Promise.all(
      audit.counts.missingRequired.map((sku) => probeSku(sku, { cookie: args.cookie, timeout: args.timeout }))
    );
  }

  // ── 5) 输出 ───────────────────────────────────────────────────────
  const payload = buildPayload({
    products: activity, recommendations, summary, audit, seckill, feed, browser, activityName, referenceSkus,
  });
  if (!args.trace) delete payload.trace;
  const files = writeOutputs(args.out, payload, { archive: !args.push });

  // ── 5.5) 播报（与上一轮快照对比）─────────────────────────────────
  let pushed = null;
  if (args.push) {
    const { runPush } = require('./report');
    pushed = runPush({
      outDir: args.out,
      payload,
      channel: args.cdp ? 'cdp' : (args.browser ? 'browser' : 'ssr'),
      intervalMin: args.interval,
      mode: args.notifyMode,
    });
  }

  // ── 6) 控制台报告 ─────────────────────────────────────────────────
  if (args.push) {
    if (files.warnings && files.warnings.length) {
      for (const w of files.warnings) console.error(`[warn] ${w}`);
    }
    console.log(pushed.text);
    if (args.notify) await deliver(args, pushed, args.out);
  } else if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    console.log(line('═'));
    console.log(`活动：${activityName || '(未取到标题)'}   ${ACTIVITY_ID}`);
    console.log(line());
    const expected = audit.counts.expectedTotal;
    console.log(`活动清单：${expected ? `${summary.activityTotal}/${expected}` : summary.activityTotal} 条  （今日抢购 ${summary.today} / 明日预告 ${summary.tomorrow}）`);
    if (expected && audit.counts.missing > 0) {
      console.log(`缺口：${audit.counts.missing} 个商品未抓到${audit.counts.missingRequired && audit.counts.missingRequired.length ? `；缺少参考 SKU ${audit.counts.missingRequired.join(', ')}` : ''}`);
    }
    for (const r of referenceSkus) {
      console.log(`参考 SKU ${r.sku}：${r.name || '(未取到标题)'}${r.shop ? ` / ${r.shop}` : ''}${r.found ? '（商品页可访问，但不在本次抓取结果中）' : `（商品页不可访问：${r.error || 'unknown'}）`}`);
    }
    console.log(`状态分布：抢购中 ${summary.onSale} | 即将开抢 ${summary.upcoming} | 已售罄 ${summary.soldOut} | 已结束 ${summary.ended} | 未知 ${summary.unknown}`);
    console.log(`推荐位  ：${summary.recommendationTotal} 条（单独统计，不计入活动清单）`);
    console.log(line());
    console.log('前 5 条：');
    for (const p of activity.slice(0, 5)) {
      const price = p.price !== null ? `¥${p.price}` : '¥?';
      const list = p.listPrice && p.listPrice !== p.price ? `（日常价 ¥${p.listPrice}）` : '';
      const stockText = p.stock && p.stock.statusText && p.stock.statusText !== p.saleStatusText
        ? ` / ${p.stock.statusText}` : '';
      console.log(`  · ${p.name}  ${price}${list}  ${p.saleStatusText}${stockText}  [${(p.tags || []).slice(0, 4).join('/')}]`);
    }
    if (activity.length > 5) console.log(`  ... 共 ${activity.length} 条，见 CSV`);
    console.log(line());
    console.log(`校验：${audit.complete ? '覆盖完整 ✅' : '覆盖不完整 ❌'}  ` +
      `（${audit.checks.filter((c) => c.ok).length}/${audit.checks.length} 项通过）`);
    if (audit.warnings.length) audit.warnings.forEach((w) => console.log(`  ⚠ ${w}`));
    if (audit.errors.length) audit.errors.forEach((e) => console.log(`  ✗ ${e}`));
    if (audit.counts.feedHasNextPage && !audit.counts.feedEnded) {
      console.log(`  · 推荐流 hasNextPage=true，已截获页码 [${audit.counts.apiPageNums.join(',') || '无'}]${audit.counts.feedBlocked ? '，接口 403/失败' : ''}`);
    }
    console.log(line());
    console.log(`JSON：${files.json}`);
    console.log(`CSV ：${files.csv}`);
    if (files.recommendationsCsv) console.log(`推荐位 CSV：${files.recommendationsCsv}`);
    if (files.trace) console.log(`接口明细：${files.trace}`);
    console.log(`耗时：${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(line('═'));
  }

  // ── 7) 退出码 ─────────────────────────────────────────────────────
  if (args.push) {
    // 定时任务不做“未满 29 条就失败”，否则每轮都红；只有完全没数据才算失败
    if (!activity.length) process.exitCode = 3;
  } else if (!audit.complete && args.strict) {
    process.exitCode = 3;
  }
}

main().catch((e) => {
  console.error('致命错误：', e && e.stack ? e.stack : e);
  process.exit(2);
});
