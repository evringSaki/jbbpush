# 不用开电脑的部署方案

本目录是把「采集 + 播报」搬到**云端常驻**的配置：电脑关机也能每 5 分钟跑一轮，并把结果推到手机。

## 先看清一件事（2026-11-06 已更新）

**29 条无需登录态就能拿全**，前提是「桌面 UA + 无头 Chromium」。之前「必须注入京东 Cookie」是早期用 App UA 导致的误判——App UA 会让页面走 JSBridge 分支、`queryBabelFeeds` 全部 403；换成桌面 UA 后接口返回 200，滚动即可拿到 29 条。

| 档位 | 能拿到 | 需要的条件 |
|---|---|---|
| **完整 29 条** | 16 SSR + 13 滚动分页 | 容器内有 Chromium，**无需 Cookie** |
| 基础 16 条 | 只有 SSR | 纯 HTTP（云函数），无浏览器生成 h5st |

`queryBabelFeeds` 的请求签名 `h5st` 由浏览器 JS 生成，所以纯 HTTP（curl/fetch）直连仍 403，必须让页面自己在浏览器里发请求、我们只截获响应。

## 方案对比

| 方案 | 成本 | 能拿 29 条 | 上手难度 | 说明 |
|---|---|---|---|---|
| **云服务器 + Docker**（推荐） | ¥24~40/月 | ✅ | 中 | 一条 `docker compose up -d`，重启自恢复，无需 Cookie |
| 家里 NAS / 树莓派 | 已有设备 | ✅ | 中 | 同一个镜像，局域网也能跑 |
| Android 手机 Termux | 免费 | ❌ 只有 16 条 | 低 | 手机必须常开、常联网 |
| GitHub Actions | 免费 | ⚠ 频率只能 ~30 分钟 | 中 | 免费额度撑不住 5 分钟一次 |
| 京东 App「开抢提醒」 | 免费 | ❌ 没有清单 | 极低 | 只想抢某件商品时够用 |

> WorkBuddy 内置自动化的最小间隔是 **1 小时**，分钟级推送只能靠本机计划任务或云端容器。

---

## 方案 A：云服务器 + Docker（推荐）

### 1. 买机器

任意 1 核 1G 的 Linux（Debian 12 / Ubuntu 22.04 都行），装好 Docker：

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. 上传代码

```bash
# 本地执行（把整个项目传上去，data/ 可以不带）
scp -r jd-today-crawler root@<你的服务器IP>:/opt/
```

### 3. 配置

```bash
cd /opt/jd-today-crawler/deploy
cp .env.example .env
vi .env      # 只需填 NOTIFY_TOKEN（PushPlus）和 NOTIFY_CHANNEL
```

**不再需要 `JD_COOKIE`**：桌面 UA + 无头 Chromium 即可抓全 29 条。`.env` 里只需要：

```
NOTIFY_CHANNEL=pushplus
NOTIFY_TOKEN=你的PUSHPLUS_TOKEN
NOTIFY_MODE=new        # 只推上新
PUSH_INTERVAL=5
```

### 4. 启动

```bash
cd /opt/jd-today-crawler/deploy
docker compose up -d --build
docker compose logs -f          # 看每轮播报
```

### 5. 验证

```bash
docker compose exec jd-babel-push cat /app/data/push/latest.txt
```

看到 29 条、`新增/下架/变动` 的数字，并且手机收到消息，就成功了。

---

## 方案 B：Android 手机（Termux，零成本）

只能拿 16 条（无 Chromium 生成 h5st），但完全不用电脑。

```bash
# Termux 里执行
pkg update && pkg install nodejs git -y
cd ~/jd-today-crawler
node src/cli.js --push --notify pushplus --notify-token 你的PUSHPLUS_TOKEN
node src/watch.js --interval 5 --notify pushplus --notify-token <t>   # 常驻
```

> Termux 没有 Chromium，`queryBabelFeeds` 拿不到（缺 h5st），播报固定 16 条并标注降级。适合只关心日用品那 16 件。

---

## 方案 C：GitHub Actions（免费兜底）

免费额度 2000 分钟/月，5 分钟一次跑不满一个月（288 次/天 × 30 天），**建议 30 分钟一次**：

```yaml
# .github/workflows/jd-push.yml
name: jd-babel-push
on:
  schedule:
    - cron: "*/30 * * * *"
  workflow_dispatch:
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci || npm install
      - run: node src/cli.js --push --notify ${{ secrets.NOTIFY_CHANNEL }}
        env:
          NOTIFY_URL: ${{ secrets.NOTIFY_URL }}
          JD_COOKIE: ${{ secrets.JD_COOKIE }}
      - uses: actions/upload-artifact@v4
        with:
          name: push-output
          path: data/push/latest.txt
```

跑完可以在 Actions 页面下载 `latest.txt`，或直接看 job 日志。

> Actions 默认无浏览器，只能 16 条。若要 29 条，需在 runner 里装 Chromium（`ubuntu-latest` 自带 `google-chrome`，设 `CHROME_PATH` 即可），但免费额度撑不住 5 分钟一次，建议 30 分钟一次 + 16 条。

---

## 推送渠道配置

都在 `deploy/.env` 里填两行：`NOTIFY_CHANNEL` + `NOTIFY_URL`。

### Bark（iPhone，最省事）

1. App Store 搜 **Bark** 安装，打开拿到一个 URL，形如 `https://api.day.app/AbCdEf123`
2. 填：
   ```
   NOTIFY_CHANNEL=bark
   NOTIFY_URL=https://api.day.app/AbCdEf123
   ```
3. 手机直接收通知，点开就是播报全文。

### 企业微信群机器人（安卓/iPhone 都行）

1. 企业微信建一个群（可以只有自己）→ 群设置 → 群机器人 → 添加
2. 复制 Webhook，填：
   ```
   NOTIFY_CHANNEL=wecom
   NOTIFY_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
   ```

### 飞书 / 钉钉

群设置 → 群机器人 → 自定义机器人 → 复制 webhook：

```
NOTIFY_CHANNEL=feishu    # 或 dingtalk
NOTIFY_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
```

### Telegram

```
NOTIFY_CHANNEL=telegram
NOTIFY_URL=https://api.telegram.org/bot<token>
NOTIFY_CHAT=<你的 chat_id>
```

### 自定义 / 自建服务

```
NOTIFY_CHANNEL=generic
NOTIFY_URL=https://your-server/hook     # 收到 POST {"text": "...", "title": "..."}
```

---

## 推送策略

| `NOTIFY_MODE` | 行为 |
|---|---|
| `change`（默认） | 只在有新增/下架/变动时推；降级状态最多 30 分钟提醒一次 |
| `always` | 每 5 分钟都推（含「本轮无变化」），共 288 条/天 |

商品多时单条消息会超长，程序按通道上限自动切分成多条发送（企业微信 1800 字符/条）。

---

## 常见问题

**Q：容器起来了，但只有 16 条？**
A：确认容器用的是桌面 UA + Chromium（`deploy/Dockerfile` 已内置）。纯 HTTP 云函数只有 16 条是正常的，要用 Docker 版才有 29 条。

**Q：Chromium 起不来，报 `libnss3` 之类？**
A：镜像里已用 `apt install chromium` 装了完整运行库；如果是自己改的基础镜像，补 `chromium fonts-noto-cjk`。

**Q：内存不够（1G 机器）？**
A：Chromium 单页约 300~500MB，1G 能跑但建议加 512MB swap：
```bash
fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

**Q：会不会被风控？**
A：5 分钟一次、单会话、不开并发，属于正常浏览频率。真被拦时播报会显示 16 条 + 降级提示，不会写坏基线。建议 `PUSH_INTERVAL` 不要低于 5。

**Q：数据存哪？**
A：全部在 `data/`（挂载到宿主机）：`push/latest.txt` 最新播报、`snapshots/baseline.json` 对比基线、`push/feed.jsonl` 每轮摘要。
