#!/usr/bin/env node
'use strict';

/**
 * 常驻守护：每 N 分钟跑一轮采集 + 播报
 *
 *   node src/watch.js                   # 默认 5 分钟
 *   node src/watch.js --interval 5 --cdp http://127.0.0.1:9222
 *   node src/watch.js --once            # 只跑一轮（调试/CI）
 *
 * 每轮输出会直接打印到当前终端；同时写入 data/push/latest.txt 与 dashboard.html。
 * Ctrl+C 结束。
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const args = {
    interval: Number(process.env.PUSH_INTERVAL || 5) || 5,
    cdp: process.env.CDP_URL || 'http://127.0.0.1:9222',
    once: false,
    browser: !!process.env.CHROME_PATH || process.env.PUSH_BROWSER === '1',
    maxScroll: Number(process.env.PUSH_MAX_SCROLL || 8) || 8,
    cookie: process.env.JD_COOKIE || '',
    notify: process.env.NOTIFY_CHANNEL || '',
    notifyUrl: process.env.NOTIFY_URL || '',
    notifyToken: process.env.NOTIFY_TOKEN || '',
    notifyMode: process.env.NOTIFY_MODE || 'new',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--interval') args.interval = Math.max(1, Number(next()) || 5);
    else if (a === '--cdp') args.cdp = next();
    else if (a === '--no-cdp') args.cdp = '';
    else if (a === '--once') args.once = true;
    else if (a === '--browser') args.browser = true;
    else if (a === '--max-scroll') args.maxScroll = Math.max(1, Number(next()) || 8);
    else if (a === '--cookie') args.cookie = next();
    else if (a === '--notify') args.notify = next();
    else if (a === '--notify-url') args.notifyUrl = next();
    else if (a === '--notify-token') args.notifyToken = next();
    else if (a === '--notify-mode') args.notifyMode = next();
    else if (a === '--help' || a === '-h') {
      console.log('用法: node src/watch.js [--interval 5] [--cdp http://127.0.0.1:9222] [--browser] [--notify pushplus --notify-token <t>] [--once]');
      process.exit(0);
    }
  }
  return args;
}

function bjTime() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function cdpAlive(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(false);
    let target;
    try {
      target = new URL('/json/version', url);
    } catch (e) {
      return resolve(false);
    }
    const req = http.get(target, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code === null ? -1 : code));
    child.on('error', () => resolve(-1));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const periodMs = args.interval * 60 * 1000;

  console.log(`\n[watch] 加倍补监控启动  周期 ${args.interval} 分钟  CDP=${args.cdp || '(不用)'}`);
  console.log(`[watch] 播报文件 ${path.join('data', 'push', 'latest.txt')}`);
  console.log(`[watch] 看板     ${path.join('data', 'push', 'dashboard.html')}`);
  console.log('[watch] Ctrl+C 结束\n');

  let round = 0;
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log('\n[watch] 收到停止信号，本轮结束后退出 ...');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    round++;
    const started = Date.now();
    const alive = await cdpAlive(args.cdp);

    const cliArgs = ['--push', '--max-scroll', String(args.maxScroll), '--sessions', '1'];
    if (alive) cliArgs.unshift('--cdp', args.cdp);
    else if (args.browser) cliArgs.push('--browser');
    if (args.cookie) cliArgs.push('--cookie', args.cookie);
    if (args.notify) cliArgs.push('--notify', args.notify);
    if (args.notifyUrl) cliArgs.push('--notify-url', args.notifyUrl);
    if (args.notifyToken) cliArgs.push('--notify-token', args.notifyToken);
    if (args.notifyMode) cliArgs.push('--notify-mode', args.notifyMode);

    const mode = alive ? '(登录态 CDP)' : (args.browser ? '(容器内 Chromium)' : '(仅 SSR · 可能只有 16 条)');
    console.log(`\n[watch] ── 第 ${round} 轮 ${bjTime()} ${mode} ──`);
    const code = await runCli(cliArgs);
    const cost = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[watch] 第 ${round} 轮结束 code=${code} 用时 ${cost}s`);

    if (args.once) break;

    const wait = Math.max(5000, periodMs - (Date.now() - started));
    const nextAt = new Date(Date.now() + wait + 8 * 3600e3).toISOString().slice(11, 16);
    console.log(`[watch] 下一轮 ${nextAt}（${Math.round(wait / 1000)}s 后）`);
    await sleep(wait);
  }

  console.log('[watch] 已退出');
}

main().catch((e) => {
  console.error('[watch] 致命错误', e);
  process.exit(2);
});
