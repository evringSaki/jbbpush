# 京东「加倍补 / 今日抢购」采集与播报

## 怎么跑（先选一个）

| 场景 | 怎么用 | 商品数 | 依赖 |
|---|---|---|---|
| 本机看一次结果 | `node src/cli.js` | 16 | 无 |
| 本机每 5 分钟播报 | `node src/cli.js --cdp http://127.0.0.1:9222 --push` | **29** | Edge 已登录 + 电脑常开 |
| **不用电脑、不用 Cookie** | 容器 + Chromium（`deploy/Dockerfile`）| **29** | 云服务器，一次性部署 |
| 云函数（纯 HTTP，最轻）| 上传 `deploy/scf/jd-babel-scf.zip` | 16 | 无浏览器，只能 SSR |
| 推到手机（PushPlus） | 加 `--notify pushplus --notify-token <token>` | 同上 | 微信关注公众号 |

- 云端方案见 [`deploy/scf/README.md`](deploy/scf/README.md)
- 云服务器 / Docker 见 [`deploy/README.md`](deploy/README.md)
- **已破解**：29 条无需登录态。关键是**桌面 UA + 无头 Chromium**（App UA 会走 JSBridge 空壳分支 + 接口 403）；纯 HTTP 云函数没有浏览器生成 h5st，仍只能拿 SSR 16 条。

---

京东「今日抢购」全量采集器

目标活动：`https://pro.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html`

采集「今日抢购」板块下的**全部商品**：商品名称、抢购价/日常价、抢购时间、库存状态、活动标签，并输出统一字段的 JSON + CSV。

---

## 0. 结果：29/29 已抓全（2026-11-06 02:51）

用**已登录的 Edge + CDP** 抓到 **29/29**：`audit.complete=true`，17/17 项检查通过，退出码 `0`。

| 来源 | 数量 | 说明 |
|---|---|---|
| `h5static` App SSR | 16 | 首屏直出：10 条抢购中 + 6 条 10:00/20:00 场 |
| `queryBabelFeeds`（pageNum 2/3，**无需登录**）| 13 | 滚动后追加的 20:00 场，含古井、茅台、膳魔师等 |
| **合计** | **29** | 推荐位 19 条另算，不计入活动清单 |

古井贡酒 年份原浆古20（SKU `100238264645`）：**¥0.01**，日常价 ¥199，限量 400 件，2791 人已解锁，**20:00 开抢**。

> 为什么之前只有 16：早期用 App UA，页面走 JSBridge 分支导致 `queryBabelFeeds` 403。换成**桌面 UA + 桌面视口**后，接口返回 `code=0`，pageNum 2/3 追加 13 条，DOM 29/29，**无需登录**。

---

## 1. 快速开始

```bash
npm install
node src/cli.js                      # 仅 SSR：16/29，会报不完整（退出码 3）
node src/cli.js --cdp http://127.0.0.1:9222   # 复用已登录 Edge：29/29
```

**Edge 156 不允许对默认 `User Data` 开远程调试**，会提示 `DevTools remote debugging requires a non-default data directory`。做法是给默认配置做一个目录联接（登录态保留，不复制 Cookie）：

```powershell
# 1) 关闭所有 Edge 窗口
# 2) 建联接（路径可换成你的工作区）
New-Item -ItemType Junction `
  -Path "C:\你的工作区\edge-profile-link" `
  -Target "$env:LOCALAPPDATA\Microsoft\Edge\User Data"

# 3) 用联接路径启动 Edge，带 9222 调试端口
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\你的工作区\edge-profile-link" `
  --profile-directory=Default --restore-last-session

# 4) 在打开的 Edge 里确认已登录京东，然后运行
node src/cli.js --cdp http://127.0.0.1:9222
```

> 目录联接里是你的真实 Edge 配置（含 Cookie），不要提交到 Git；`.gitignore` 已忽略 `edge-profile-link/`。

输出：

```
data/jd-today-latest.json          统一字段全量数据（含 audit 校验块）
data/jd-today-latest.csv           表格（UTF-8 BOM，Excel 直接打开）
data/jd-today-recommendations-*.csv 推荐位单独一张表
data/trace-*.json                  浏览器通道接口明细（加 --trace 时）
```

常用参数：

```bash
# 用完整活动 URL 覆盖默认活动：自动解析活动 ID，并把 ? 后面的参数原样带到两个构建
ACTIVITY_URL="https://pro.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html?babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1" node src/cli.js

# 追加浏览器通道：滚动加载 + 截获 queryBabelFeeds 分页
node src/cli.js --browser --sessions 2 --max-scroll 30

# 无需 Cookie：桌面 UA 即可抓全 29 条（2026-11-06 起）
node src/cli.js --browser --cookie "pt_key=...; pt_pin=..."

# 连接已登录 Edge/Chrome（旧的 CDP 方式，现在非必需）
# 先关闭现有浏览器，再启动调试端口：
#   msedge.exe --remote-debugging-port=9222 --user-data-dir="C:\temp\edge-jd"
#   （Edge 路径：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe）
# 在打开的浏览器里登录京东，然后：
node src/cli.js --cdp http://127.0.0.1:9222

# 排查风控：有头浏览器 + 接口明细
node src/cli.js --browser --headed --trace

# 校验不通过也返回 0（默认返回 3，方便 CI 拦截“不完整数据”）
node src/cli.js --no-strict
```

环境要求：Node.js ≥ 18；浏览器通道需要本机安装 Chrome 或 Edge（`playwright-core` 直接复用，不额外下载 Chromium）。

---

## 1.5 每 5 分钟播报

### 用法

```bash
# 前台常驻：每 5 分钟一轮，Ctrl+C 结束（会打印每轮播报）
node src/watch.js --interval 5 --cdp http://127.0.0.1:9222

# 只跑一轮并输出播报
node src/cli.js --cdp http://127.0.0.1:9222 --push

# 纯 SSR（无浏览器时只有 16 条，播报会标注降级）
node src/cli.js --push
```

### 播报格式（默认只推上新）

默认 `NOTIFY_MODE=new`：**只有新商品上架才推送**。预约人数、剩余件数、总量、售罄、价格微调都只记录、不打扰。

有上新时：

```
加倍补 商品上新
- 时间：2026-11-06 3:25
- 当前商品数：16（上轮 16）
- 本次上新：1 件（💡 抢购中 0 · ⏰ 预告 1）

🆕 上新 · 1 件
- 100238264645 古井贡酒 年份原浆古20 浓香型白酒 52度 100ml*1瓶 单瓶装 积分兑换 ¥0.01（原价 ¥199） · ⏰ 预告（今天 20:00 开抢）2791/400
```

首次部署只确认通道：

```
加倍补 监控已启动
- 时间：2026-11-06 3:25
- 当前商品数：16（首轮基线）
- 规则：已建立基线，之后只在有新商品上架时推送
```

想看全套（新增 + 下架 + 变动）就加 `--notify-mode change`：

```
加倍补 商品更新
- 时间：2026-11-06 3:11
- 当前商品数：29（上轮 29）
- 变更：新增 0 / 下架 0 / 变动 1

🔄 变动 · 1 件
- 100030561995 北京稻香村四季平安糕点礼盒530g · 价格 ¥64→¥59
```

单条商品格式：

```
- {sku} {名称} ¥{抢购价}（原价 ¥{日常价}） · 💡 抢购中 {剩余}/{总量}
- {sku} {名称} ¥{抢购价}（原价 ¥{日常价}） · ⏰ 预告（今天 20:00 开抢）{预约人数}/{总量}
```

### 输出文件

| 文件 | 说明 |
|---|---|
| `data/push/latest.txt` | 最新一轮播报（纯文本） |
| `data/push/latest.md` | 同上，包在代码块里，便于贴到文档 |
| `data/push/history/<日期>/<HHmm>.txt` | 每轮归档，保留 3 天 |
| `data/push/feed.jsonl` | 每轮一行摘要，可画趋势 |
| `data/push/dashboard.html` | 自动刷新看板（页面 30 秒刷新，含最近 24 轮） |
| `data/push/run.log` | 计划任务运行日志 |
| `data/snapshots/baseline.json` | 对比基线（上一轮） |
| `data/snapshots/history/...` | 快照历史，保留 7 天 |

### 常驻 / 开机自启

```bat
scripts\install-task.bat          :: 双击注册 Windows 计划任务，每 5 分钟运行
scripts\install-task.bat remove   :: 卸载
scripts\install-task.bat status   :: 查看状态
```

> 计划任务由 Windows 调度，关掉终端也继续跑；若提示权限不足，右键「以管理员身份运行」。
> 提示：WorkBuddy 内置自动化的最小间隔是 1 小时，分钟级只能走本机计划任务或 `watch.js`。

### 推送到手机（PushPlus）

```bash
node src/cli.js --push --notify pushplus --notify-token 你的PUSHPLUS_TOKEN
```

- `--notify-mode new`（默认）：**只推新上架**，一天通常 0~3 条
- `--notify-mode change`：新增 + 下架 + 价格/状态变动
- `--notify-mode always`：每轮都推（288 条/天，会超 PushPlus 免费额度 200）
- 微信需关注「pushplus 推送加」公众号，否则收不到
- 想换通道：`wecom` / `feishu` / `dingtalk` / `bark` / `serverchan` / `telegram` / `generic`，配 `--notify-url`

### 降级保护（重要）

无浏览器（纯 HTTP 云函数）时本轮只有 16 条（另外 13 条走 `queryBabelFeeds`，需要浏览器生成 h5st）：

- 播报会写 `⚠ 本轮未取得登录态 … 已跳过「下架」判定`
- **不更新基线**，避免下一轮把 13 条误报成「下架」
- `feed.jsonl` 记 `degraded: true`

判定条件：上一轮 `complete=true` 且本轮 `complete=false`。

---

## 2. 如何定位并追溯数据源（可复现步骤）

### 2.1 先确认「商品到底在不在 HTML 里」

```bash
curl -sSL -A "Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) ... jdapp;JDAndroid;14.0.0;" \
  "https://h5static.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html?babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1" \
  -o app.html

grep -o '"itemIdentityId"' app.html | wc -l     # => 16
grep -o '"goodsList"' app.html | wc -l          # => 0
```

同样的请求换成 `pro.m.jd.com`：

```bash
curl -sSL -A "... jdapp;JDAndroid;14.0.0;" \
  "https://pro.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html?babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1" \
  -o h5.html

grep -o '"itemIdentityId"' h5.html | wc -l      # => 0
grep -o '"wareId"' h5.html | wc -l              # => 19
grep -o '"hasNextPage":true' h5.html | wc -l    # => 1
```

> 结论：**同一个活动 ID，两个域名返回两套不同构建**。只看 `pro.m` 会得出“商品不在 HTML 里”的错误结论。

### 2.2 在浏览器里追溯（DevTools）

1. 打开活动页，`View Source` 搜索 `__react_data__`，复制 `window.__react_data__ = {...}` 到 JSON 工具里。
2. 展开路径：
   - App 构建：`activityData → floorList[] → tabList[] → secondTabList[] → floorList[] → providerData[0]`
   - 每个 `providerData[0]` 就是一个 SKU：`itemIdentityId` + `productResult`
   - `tabList[i].name` 就是板块名：`今日抢购` / `明日预告`
3. H5 构建：`activityData → floorList[] → providerData.feeds.goodsList[]`，字段是 `wareId / wname / displayPrice / jdPrice`。
4. Network 面板过滤 `api.m.jd.com`，滚动到底部会看到：
   ```
   POST https://api.m.jd.com/client.action?functionId=queryBabelFeeds
   ```
   它的响应里 `floorList[].providerData[]` 是下一页商品；`pageNum` 递增，`queryCode=1` 表示没有下一页。

### 2.3 字段映射（App 构建，`productResult`）

| 统一字段 | 页面字段 | 说明 |
|---|---|---|
| `sku` | `productResult.skuId` / `itemIdentityId` | 商品 SKU |
| `name` | `productResult.name` | 商品名 |
| `price` | `productExtInfo.skuPriceInfo.price` | 抢购价（实测 64） |
| `listPrice` | `productExtInfo.skuPriceInfo.basePrice` | 页面展示的「日常价」（实测 99） |
| `jdPrice` | `productExtInfo.skuPriceInfo.jdPrice` | 京东价（实测 108.9） |
| `origPrice` | `skuPriceInfo.originalPrice` / `regularPrice` | 划线价/常规价 |
| `saleTime.start` | `productExtInfo.stageStartTime`，回退 `productResult.timeBegin` | 开抢时间（毫秒时间戳） |
| `saleTime.end` | `productResult.timeEnd` | 结束时间 |
| `saleTime.label` | 由开抢时间推导 | `10:00场` / `20:00场`（仅未开抢时） |
| `saleStatus` | `promotionStatus` + 时间窗 + `canSell` | `on_sale/upcoming/sold_out/ended` |
| `stock.remainNum` | `productExtInfo.skuStockInfo.remainNum` | 剩余件数 |
| `stock.soldPercent` | `skuStockInfo.soldRate` / `productResult.productProcess` | 已售比例 |
| `stock.totalStock` | `productResult.pomotionStock` | 总量/限量 |
| `stock.limitCount` | `skuStockInfo.limitCount` | 限购/投放量 |
| `stock.bookingCount` | `productExtInfo.taskInfo.bookingCount` | 预约/解锁人数（未开抢商品） |
| `tags` | `productExtInfo.tags` + `jdSelf` + 时间/库存派生 | 如 `百亿补贴`、`京东自营`、`10:00场`、`仅剩8件` |

> 注意：`canSell` 在未登录时恒为 `N`，**不能**用它判断是否开抢；要看 `promotionStatus`（1=在售，2=预告）+ `timeBegin/timeEnd` + `skuStockInfo.soldOut`。本程序已按这个优先级处理。

---

## 3. 分页与动态加载怎么处理

### 3.1 活动清单：一次 SSR 直出，不需要翻页

App 构建的 16 条商品是**独立的 `SsrCodeTemplate` 楼层**（`floorList[4].tabList[].secondTabList[0].floorList`），不是虚拟列表：

- `activityData.pagination = false`
- `activityData.paginationParams = ["1"]`
- 16 个商品楼层一次返回，滚动不会“加载更多活动商品”；页面底部的「上滑更多加载」属于最后一个 `template: "feeds"` 楼层，是推荐流，不是活动清单。
- 换句话说：只抓 DOM 首屏会漏，但只要解析 `SsrCodeTemplate` 楼层的 `tabList → secondTabList → floorList`，16 条一次拿全。

所以「活动清单」的完整性 = SSR 楼层数 = 16，程序不会因为没滚动而漏商品。

### 3.2 推荐流：`queryBabelFeeds` 的翻页协议

H5 构建的 `feeds.goodsList` 只是第一页（19 条），`feeds.hasNextPage=true`。下一页由页面 JS 发起：

```
POST https://api.m.jd.com/client.action?functionId=queryBabelFeeds
Content-Type: application/x-www-form-urlencoded

body={
  "transParam": "<activityData.transParam 原样回传>",
  "pageNum": 2,
  "activityId": "USFY4Q1KPsHd54cN8AVUPHZdHpT",
  "hasTopFloor": "0",
  "feedTransParam": "<第 1 页响应里的 feedTransParam>",
  "feedParam": "{\"id\":121269944,\"tabId\":1,\"subTabId\":1,...}",
  "prePageSkus": ["<第 1 页 SKU>"],
  "prePageItems": ["<第 1 页 itemIdentityId>"],
  "feedSessionId": "<第 1 页 feedSessionId>",
  "position": 0,
  "criteriaParam": {"stageStatus":1,"round":"1","bybtSceneId":"2","startDate":1793894400000},
  "bizParam": {},
  "fullUrl": "<页面完整 URL>",
  "siteInfo": {"isLikeJDMain":true,"siteName":"jdmall","siteClient":"m","x_app_key":"vygmwcxg14ui3jxw"}
}
&h5st=<签名>&eid=<设备ID>&uuid=<uuid>&screen=390*844&client=wh5&appid=wh5
```

关键请求头：

```
User-Agent: ... jdapp;JDAndroid;14.0.0;
x-rp-client: h5_2.4.0
x-babel-actid: USFY4Q1KPsHd54cN8AVUPHZdHpT
x-referer-page: https://pro.m.jd.com/mall/active/USFY4Q1KPsHd54cN8AVUPHZdHpT/index.html
Referer: 同上
```

翻页终止条件（页面源码里的判断）：

```js
hasMore = !(floorList.length === 0 || queryCode === '1')
```

所以 `code=0 && queryCode=1` 或 `code=0 && floorList=[]` 才是“到底”；**接口报错（403/限流）不能当结束**。

### 3.3 程序怎么做：让页面自己翻页，我们只截获

`src/channels/browser.js`：

1. 多会话打开页面（不同 UA/指纹），商品取并集，抵抗会话级个性化。
2. 每轮：等 `queryBabelFeeds` 在途请求归零 → 滚动窗口 + 所有内部滚动容器 → 点击「上滑更多加载/加载更多」→ 等待 → 再等请求归零。
3. `page.on('response')` 截获每一页，记录 `pageNum / code / queryCode / floorList.length / feedTransParam`，并递归提取商品。
4. 停止条件：
   - 接口明确 `queryCode=1` 或空 `floorList`，且页面高度连续 3 轮不变；
   - 或连续 8 轮无新增商品且高度不变（防止接口一直报错导致死循环）。
5. 同时从页面 `window.__react_data__` 取一份商品，作为接口被 403 时的兜底。
6. 用 DOM 里「抢购价」卡片数做独立计数（本次 16），与解析数量交叉校验。

实测：用 App UA 时 `queryBabelFeeds` 返回 403；**换桌面 UA 后返回 200**，滚动拿到全部 29 条。纯 HTTP（curl/fetch）直连仍 403（缺 h5st）。

### 3.4 本次额外尝试过的路径（避免重复踩坑）

| 思路 | 结果 |
|---|---|
| 换 `babelChannel`（ttt1/2/3/7/10/42/52） | 始终 19 条，无变化 |
| 换 UA（App / iPhone / 微信 / 桌面 Chrome） | h5static 始终 16，pro.m 始终 19 |
| 换地区 Cookie（`un_area`/`area`） | 服务端忽略，`resolvedArea` 仍按出口 IP |
| 换 CDN 边缘 IP | 默认 DNS 可能解析到“京东验证”页；换到 `111.202.57.21` / `111.13.149.247` 可恢复 SSR，但商品数仍 19（程序已内置边缘回退） |
| `queryPreviewBabelFeeds` / `queryBabelSingleFloor` / `queryMultiTabFloors` / `qryH5BabelFloors` | 全部 403（h5st/登录态网关） |
| `queryStaggeredFlow` / `getBabelProductPaged` | 可达，但返回“传参异常”，非本活动 feed 的参数模型 |
| 短链 `3.cn/3-aCItV9` + 分享参数 | 仍 19；`gx/gxd` 不改变商品池 |
| 商品页 `100238264645` / `cd.jd.com/promotion` | 商品页可访问；促销接口 404/302，拿不到同活动 SKU 列表 |

结论：**29 条无需登录态就能拿全**，前提是「桌面 UA + 无头 Chromium」。之前「必须登录态」是 App UA 导致的误判。纯 HTTP 云函数仍只能 16 条。

---

## 4. 反爬应对思路

| 问题 | 现象 | 处理 |
|---|---|---|
| `h5st` 签名 | 抓包重放 403 | 不重放。让页面自己生成签名，浏览器通道只截获响应 |
| 设备指纹 | `eid`/`uuid` 与签名绑定 | 使用真实 Chrome/Edge（`playwright-core` channel），每会话独立 context |
| 入口参数 | 不带参数时 feed 少十几条 | URL 固定带 `babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1` |
| UA | 普通浏览器 UA 拿到 CSR 空壳 | SSR 请求固定用 `jdapp;JDAndroid;14.0.0;` WebView UA |
| 登录态 | 匿名 `queryBabelFeeds` 403；登录后商品更多 | 支持 `--cookie "pt_key=...; pt_pin=..."`（用户自己的账号） |
| 请求过快 | 分页少返回/请求重叠 | 每轮 1.1~1.8s 随机等待；`inflight=0` 才滚；每会话最多 30 轮 |
| 验证页 | HTML 含「京东验证/访问频次」 | `http.js` 识别后重试（换 UA/退避），不把验证页当数据 |
| 降级页 | 页面正常但商品数骤降 | `audit.baseline_drop` 与 `ssr_vs_dom` 双校验；strict 模式返回 3 |
| 风控 403 | 接口 0 字节 | 记录 `apiBlocked`，回退到 SSR + 页面 `__react_data__`，并在报告里明确“推荐流未抓全” |

合规提示：只采集公开页面数据，控制频率；`Cookie` 只发送给 `.jd.com`，不要提交到第三方；不要用本程序绕过登录/付费/风控。

---

## 5. 输出字段（JSON）

```json
{
  "sku": "100030561995",
  "name": "北京稻香村四季平安糕点礼盒530g",
  "url": "https://item.m.jd.com/product/100030561995.html",
  "price": 64,
  "priceText": "¥64",
  "listPrice": 99,
  "jdPrice": 108.9,
  "origPrice": 119,
  "discount": "6.5折",
  "saleTime": {
    "start": "2026-10-20 16:30",
    "startTs": 1792485040000,
    "end": "2026-11-19 16:30",
    "endTs": 1795077040000,
    "activityDate": "2026-11-06 00:00",
    "round": "1",
    "label": "",
    "source": "productExtInfo.stageStartTime"
  },
  "saleStatus": "on_sale",
  "saleStatusText": "仅剩8件",
  "stock": {
    "status": "on_sale",
    "statusText": "仅剩8件",
    "remainNum": 8,
    "soldPercent": 60,
    "limitCount": 20,
    "totalStock": 20,
    "soldOut": false,
    "canSell": "N",
    "bookingCount": 0
  },
  "tags": ["今日抢购", "百亿补贴", "京东自营", "已售60%", "仅剩8件", "限量20件", "补贴价"],
  "activityTab": "今日抢购",
  "listType": "activity",
  "source": "ssr_app",
  "sources": ["ssr_app"],
  "capturedAt": "2026-11-06T01:22:13.000Z",
  "raw": { "promotionStatus": "1", "canSell": "N", "rawTags": ["BILLION_ZXJ"] }
}
```

CSV 列：`SKU, 商品名称, 抢购价, 日常价, 京东价, 折扣, 抢购开始时间, 抢购结束时间, 活动日期, 场次, 销售状态, 库存状态, 剩余件数, 已售比例(%), 总量, 预约人数, 活动标签, 所属板块, 数据来源, 商品链接, 采集时间`

---

## 6. 数据完整性校验（`audit`）

程序每次输出都带 `audit` 块，默认 14 项检查（启用浏览器且截获页码时多 1 项页码序列），覆盖：

- **数量**：活动清单非空；SKU 去重后数量 = 总数，且格式合法。
- **预期总数 / 参考 SKU**：默认按用户提供的 `29` 校验，少于 29 直接判不完整；`100238264645` 不在结果里也会报错。可用 `--expect N` / `--require-sku` 调整。
- **字段**：名称/价格/抢购时间完整率必须 100%；销售状态/库存状态缺失会告警。
- **来源结构**：`pagination=false` 且 `paginationParams<=1`，证明 16 条是一次直出，不存在“还有下一页活动商品”。
- **原始计数**：不依赖解析器，直接统计 HTML 里 `"itemIdentityId":`（本次 16）与 `"wareId":`（本次 19）的出现次数，和解析数对比。
- **DOM 交叉**：浏览器通道下统计 `document.body.innerText` 中「抢购价」出现次数（本次 29），与解析数对比，容差 ±max(2,10%)。
- **分页**：`hasNextPage` + 已截获 `pageNum` 序列 + `queryCode` + 是否 403；页码必须连续。
- **来源区分**：活动清单 vs 推荐流交集，交集 0 时明确提示“推荐流不计入活动清单”。
- **基线**：与上一轮快照对比，商品数跌破 70% 告警（防风控降级页写入基线）。

本次实测 `audit.complete=true`（**29/29**，17/17 项通过）。关键变化：`--cdp` 复用登录态后，`queryBabelFeeds` 返回 `code=0`，pageNum 2/3 追加 13 条，DOM 卡片数 29 与解析数一致。

---

## 7. 实测结果（2026-11-06 02:51）

```
[1/3] App SSR  ：16 条 / 352 KB
[2/3] H5 SSR   ：19 条推荐 / 267 KB，hasNextPage=true
[3/3] 浏览器   ：29 条（16 SSR + 13 queryBabelFeeds pageNum 2/3），DOM 卡片 29，403=false

活动清单：29/29 条
状态分布：抢购中 10 | 即将开抢 19
校验：覆盖完整 ✅（17/17 项通过）
进程退出码：0
```

截获到的分页：`pageNum=2`、`pageNum=3`，`code=0`，共追加 13 条 20:00 场，含：

- 古井贡酒 年份原浆古20：¥0.01，限量 400，2791 人已解锁
- 茅台 2026 年飞天：¥1639，限量 5，146 人
- 膳魔师便携榨汁杯：¥99.5，限量 10，31 人
- 斑马 Polo：¥199，限量 6，112 人
- 心相印洗脸巾、YSL、颐莲、润百颜、SEVERIN、OLAY、bodyluv 花洒、运动水杯、乔迁礼盒

---

## 8. 目录结构

```
src/
  cli.js               入口 / 参数 / 合并 / 报告 / 退出码
  config.js            活动 ID、URL、UA、验证词、标签映射
  http.js              带重试/超时/验证页识别的 HTTP 客户端
  parse.js             __react_data__ 提取、递归收集商品与 feed 楼层
  normalize.js         统一字段：价格/时间/库存/标签
  validate.js          完整性审计（11 项）
  output.js            JSON / CSV（UTF-8 BOM）/ trace
  channels/
    ssr.js             App SSR（活动清单）+ H5 SSR（推荐流）
    browser.js         Playwright：多会话 + 滚动 + queryBabelFeeds 截获 + DOM 计数
data/                  输出
```

---

## 9. 已知限制

- 那 13 条 20:00 场商品走 `queryBabelFeeds`，需要浏览器（Chromium）生成 h5st；纯 HTTP 云函数只能拿到 16 条，会报 `16/29` 并标注降级，这是预期行为。
- Edge 156 不能对默认 `User Data` 开远程调试，必须用目录联接或独立配置；联接里含真实 Cookie，不要提交/分享。
- `queryBabelFeeds` 的 `pageNum` 2/3 已截获，但 `hasNextPage` 仍可能为 true（服务端没给明确末页）；程序以 `code=0`、页码连续、DOM 卡片数三重校验，不把 403 当结束。
- 「今日抢购」每日轮换，商品数和集合会变；用 `--expect N` / `EXPECTED_TOTAL` 调整预期，不要把 29 写死。
- `pomotionStock`/`limitCount` 在不同商品上语义略有差异（总投放量/限购量），CSV 同时保留两列，分析时以页面「限量 N 件」文案为准。
- 活动页改版时，`parse.js` 路径与 `normalize.js` 字段映射需同步调整；解析数为 0 时 `audit` 会直接报错。

