'use strict';

/**
 * 播报与差异的回归测试（不联网、不写真实基线）
 *   node test/report-test.js
 *
 * 核心约定：
 *   - 默认 mode=new：只有「新商品上架」才算需要推送
 *   - 剩余件数 / 总量 / 预约人数 变化一律不算变动（避免每 5 分钟刷屏）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { snapshotOf, diffSnapshot, readBaseline, writeSnapshot } = require('../src/snapshot');
const { buildReportText, runPush } = require('../src/report');

const latest = path.join(__dirname, '..', 'data', 'jd-today-latest.json');
const real = JSON.parse(fs.readFileSync(latest, 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

const base = clone(real);
const baseSnap = snapshotOf(base);

function single(product) {
  return snapshotOf({ products: [product], audit: { complete: true } });
}

const EMPTY_SNAP = snapshotOf({ products: [], audit: { complete: true } });

const GRAIN = {
  sku: '100238264645',
  name: '古井贡酒 年份原浆古20 浓香型白酒 52度 100ml*1瓶 单瓶装 积分兑换',
  price: 0.01,
  listPrice: 199,
  saleStatus: 'upcoming',
  saleStatusText: '20:00开抢',
  saleTime: { start: '2026-11-06 20:00', startTs: null },
  stock: { status: 'upcoming', statusText: '未开抢', remainNum: null, totalStock: 400, bookingCount: 2791 },
};

const FOOD = {
  sku: '100030561995',
  name: '北京稻香村四季平安糕点礼盒530g',
  price: 64,
  listPrice: 99,
  saleStatus: 'on_sale',
  saleStatusText: '抢购中',
  saleTime: { start: '2026-10-20 16:30', startTs: null },
  stock: { status: 'on_sale', statusText: '仅剩8件', remainNum: 8, totalStock: 20, bookingCount: 356 },
};

test('snapshot 条目数 = 商品数，字段齐全', () => {
  assert.strictEqual(baseSnap.count, base.products.length);
  const it = baseSnap.items[base.products[0].sku];
  for (const k of ['sku', 'name', 'price', 'status', 'start', 'remainNum', 'totalStock', 'bookingCount']) {
    assert.ok(k in it, `缺少字段 ${k}`);
  }
});

test('首轮：全部计为新增，标记 first', () => {
  const d = diffSnapshot(null, baseSnap);
  assert.strictEqual(d.first, true);
  assert.strictEqual(d.added.length, base.products.length);
});

test('无变化：三个集合都为空，不推送', () => {
  const d = diffSnapshot(baseSnap, snapshotOf(clone(base)));
  assert.strictEqual(d.added.length + d.removed.length + d.changed.length, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });   // 必须先有基线，否则算首轮
  const r = runPush({ outDir: dir, payload: clone(base) });
  assert.strictEqual(r.diff.first, false);
  assert.strictEqual(r.shouldNotify, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('预约人数 / 剩余件数 / 总量变化：不算变动、不推送', () => {
  const next = clone(base);
  next.products[0].stock.bookingCount += 58;      // 预约涨了
  next.products[0].stock.remainNum -= 3;          // 剩的少了
  next.products[0].stock.totalStock += 0;
  const d = diffSnapshot(baseSnap, snapshotOf(next));
  assert.strictEqual(d.changed.length, 0, `不该有变动，实际 ${d.changed.length}`);
  assert.strictEqual(d.added.length, 0);
  assert.strictEqual(d.removed.length, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });
  const r = runPush({ outDir: dir, payload: next });
  assert.strictEqual(r.shouldNotify, false, '库存/预约变化不应触发推送');
  assert.ok(r.text.includes('（本轮无上新）'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('价格变化：算变动，但 new 模式不推送；change 模式推送', () => {
  const next = clone(base);
  next.products[0].price = Number(next.products[0].price) - 5;
  const curr = snapshotOf(next);
  const d = diffSnapshot(baseSnap, curr);
  assert.strictEqual(d.changed.length, 1);
  assert.ok(d.changed[0].fields.some((f) => f.key === 'price'));

  // 每次都要用干净基线，因为 runPush 会更新基线
  const dirNew = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dirNew, baseSnap, { updateBaseline: true });
  assert.strictEqual(runPush({ outDir: dirNew, payload: next, mode: 'new' }).shouldNotify, false);

  const dirChange = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dirChange, baseSnap, { updateBaseline: true });
  assert.strictEqual(runPush({ outDir: dirChange, payload: next, mode: 'change' }).shouldNotify, true);

  fs.rmSync(dirNew, { recursive: true, force: true });
  fs.rmSync(dirChange, { recursive: true, force: true });
});

test('新增 1 条：new 模式推送，播报出现「🆕 上新」', () => {
  const next = clone(base);
  next.products.push(clone(FOOD));
  next.products[next.products.length - 1].sku = '100000000001';
  next.products[next.products.length - 1].name = '测试新上架商品';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });
  const r = runPush({ outDir: dir, payload: next });
  assert.strictEqual(r.diff.added.length, 1);
  assert.strictEqual(r.shouldNotify, true);
  assert.ok(r.text.startsWith('加倍补 商品上新'), `标题不对：${r.text.split('\n')[0]}`);
  assert.ok(r.text.includes('本次上新：1 件'));
  assert.ok(r.text.includes('🆕 上新 · 1 件'));
  assert.ok(r.text.includes('100000000001 测试新上架商品'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('下架 1 条：new 模式不推送、不列下架段', () => {
  const next = clone(base);
  const gone = next.products.pop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });
  const r = runPush({ outDir: dir, payload: next });
  assert.strictEqual(r.diff.removed.length, 1);
  assert.strictEqual(r.shouldNotify, false);
  assert.ok(!r.text.includes('🚫 下架'), 'new 模式不该出现下架段');
  assert.ok(r.diff.removed[0].sku === gone.sku);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('首轮播报：只确认通道，不刷屏列商品', () => {
  const curr = single(GRAIN);
  const text = buildReportText({ prev: null, curr, diff: diffSnapshot(null, curr) });
  assert.ok(text.includes('加倍补 监控已启动'), text);
  assert.ok(text.includes('当前商品数：1'));
  assert.ok(text.includes('只在新商品上架时推送') || text.includes('之后只在有新商品上架时推送'), text);
  assert.ok(!text.includes('¥'), '首轮不该列商品行');
});

test('预告行格式：今天 HH:MM 开抢 + 预约/总量', () => {
  const curr = single(GRAIN);
  const text = buildReportText({
    prev: EMPTY_SNAP,
    curr,
    diff: diffSnapshot(EMPTY_SNAP, curr),
    mode: 'new',
  });
  assert.ok(
    text.includes('- 100238264645 古井贡酒 年份原浆古20 浓香型白酒 52度 100ml*1瓶 单瓶装 积分兑换 ¥0.01（原价 ¥199） · ⏰ 预告（今天 20:00 开抢）2791/400'),
    `预告行不匹配：\n${text}`
  );
});

test('抢购中行格式：剩余/总量', () => {
  const curr = single(FOOD);
  const text = buildReportText({
    prev: EMPTY_SNAP,
    curr,
    diff: diffSnapshot(EMPTY_SNAP, curr),
    mode: 'new',
  });
  assert.ok(
    text.includes('- 100030561995 北京稻香村四季平安糕点礼盒530g ¥64（原价 ¥99） · 💡 抢购中 8/20'),
    `抢购行不匹配：\n${text}`
  );
});

test('降级采样：不更新基线、不判下架', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });

  const partial = clone(base);
  partial.products = partial.products.slice(0, 16);
  partial.audit = { complete: false };
  const r = runPush({ outDir: dir, payload: partial });

  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.diff.removed.length, 13);
  assert.strictEqual(readBaseline(dir).count, baseSnap.count, '降级轮不应覆盖基线');
  assert.ok(r.text.includes('已跳过「下架」判定'));
  assert.strictEqual(r.shouldNotify, false, '降级但无上新时不该推送');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('完整轮：更新基线并落盘 latest.txt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });
  const next = clone(base);
  next.products.push(clone(FOOD));
  next.products[next.products.length - 1].sku = '100000000002';
  next.products[next.products.length - 1].name = '新上架二号';

  const r = runPush({ outDir: dir, payload: next });
  assert.strictEqual(r.degraded, false);
  assert.strictEqual(readBaseline(dir).count, baseSnap.count + 1);
  const txt = fs.readFileSync(path.join(dir, 'push', 'latest.txt'), 'utf8');
  assert.ok(txt.includes('🆕 上新 · 1 件'), txt);
  assert.ok(txt.includes('新上架二号'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('feed.jsonl 记录 mode / notify，便于回溯', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jd-x-'));
  writeSnapshot(dir, baseSnap, { updateBaseline: true });
  const next = clone(base);
  next.products.push(clone(GRAIN));
  next.products[next.products.length - 1].sku = '100000000003';
  runPush({ outDir: dir, payload: next });
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'push', 'feed.jsonl'), 'utf8').trim().split('\n').pop());
  assert.strictEqual(line.mode, 'new');
  assert.strictEqual(line.notify, true);
  assert.strictEqual(line.added, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${passed} 项通过`);
