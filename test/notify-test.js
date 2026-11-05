'use strict';

/**
 * 推送通道测试（本地起一个假 webhook，不联网）
 *   node test/notify-test.js
 */

const http = require('http');
const assert = require('assert');
const { notify, chunkText, LIMITS } = require('../src/notify');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; });
}

const received = [];

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ errcode: 0, code: 0 }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.address().port}`;

  await test('chunkText：短文本不切', () => {
    assert.deepStrictEqual(chunkText('a\nb', 100), ['a\nb']);
  });

  await test('chunkText：按行切块且不丢内容', () => {
    const text = Array.from({ length: 100 }, (_, i) => `- 商品 ${i} 名称`).join('\n');
    const parts = chunkText(text, 200);
    assert.ok(parts.length > 1, '应被切成多块');
    assert.ok(parts.every((p) => p.length <= 200), '每块都不超限');
    assert.strictEqual(parts.join('\n'), text, '拼回后内容一致');
  });

  await test('企业微信：msgtype=text + content', async () => {
    received.length = 0;
    const r = await notify('加倍补 商品更新\n- 测试', { channel: 'wecom', url: `${base}/cgi-bin/webhook/send?key=x` });
    assert.ok(r.ok, `发送失败：${r.error}`);
    const body = JSON.parse(received[0].body);
    assert.strictEqual(body.msgtype, 'text');
    assert.ok(body.text.content.includes('加倍补 商品更新'));
  });

  await test('飞书：msg_type=text + content.text', async () => {
    received.length = 0;
    const r = await notify('加倍补 商品更新', { channel: 'feishu', url: `${base}/open-apis/bot/v2/hook/x` });
    assert.ok(r.ok);
    const body = JSON.parse(received[0].body);
    assert.strictEqual(body.msg_type, 'text');
    assert.ok(body.content.text.includes('加倍补'));
  });

  await test('钉钉：msgtype=text', async () => {
    received.length = 0;
    const r = await notify('加倍补 商品更新', { channel: 'dingtalk', url: `${base}/robot/send?access_token=x` });
    assert.ok(r.ok);
    assert.strictEqual(JSON.parse(received[0].body).msgtype, 'text');
  });

  await test('Bark：title + body', async () => {
    received.length = 0;
    const r = await notify('加倍补 商品更新', { channel: 'bark', url: `${base}/abc123`, title: '播报' });
    assert.ok(r.ok);
    const body = JSON.parse(received[0].body);
    assert.strictEqual(body.title, '播报');
    assert.ok(body.body.includes('加倍补'));
  });

  await test('Server酱：自动补 .send 后缀', async () => {
    received.length = 0;
    const r = await notify('加倍补 商品更新', { channel: 'serverchan', url: `${base}/SCT123` });
    assert.ok(r.ok);
    assert.ok(received[0].url.endsWith('.send'), `实际 URL：${received[0].url}`);
    const body = JSON.parse(received[0].body);
    assert.ok(body.title && body.desp);
  });

  await test('Telegram：自动补 /sendMessage + chat_id', async () => {
    received.length = 0;
    const r = await notify('加倍补', { channel: 'telegram', url: `${base}/botTOKEN`, chatId: '42' });
    assert.ok(r.ok);
    assert.ok(received[0].url.endsWith('/sendMessage'));
    assert.strictEqual(JSON.parse(received[0].body).chat_id, '42');
  });

  await test('超长播报按通道上限分多条', async () => {
    received.length = 0;
    const long = Array.from({ length: 120 }, (_, i) => `- 10000000${i} 某某商品名称测试 ${i} ¥1（原价 ¥9.9） · ⏰ 预告（今天 20:00 开抢）2791/100`).join('\n');
    const r = await notify(long, { channel: 'wecom', url: `${base}/hook` });
    assert.ok(r.ok);
    assert.ok(received.length > 1, `应分多条发送，实际 ${received.length}`);
    assert.ok(received.every((x) => JSON.parse(x.body).text.content.length <= LIMITS.wecom + 100));
    assert.strictEqual(received.length, r.parts);
  });

  await test('缺少 URL 时明确报错', async () => {
    const r = await notify('x', { channel: 'wecom' });
    assert.strictEqual(r.ok, false);
    assert.ok(/notify-url/i.test(r.error));
  });

  await test('URL 非法时不抛异常', async () => {
    const r = await notify('x', { channel: 'generic', url: 'not a url' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error);
  });

  srv.close();
  console.log(`\n${passed} 项通过`);
})();
