# GitHub Actions 部署说明

把「每 5 分钟检测新上商品、有就推」搬到 GitHub 免费托管，**不用自己的电脑、不用京东 Cookie**。

## 先说结论：能跑，但有两个硬限制

### 限制 1：做不到"准点每 5 分钟"

GitHub 的 `schedule` 用的是 cron，官方明确说明**不保证准点**，负载高时可能延迟几分钟到几十分钟。所以实际效果是"约 5 分钟一次，经常延迟"，不是精准 5 分钟。

如果你要的是**精准 5 分钟**（比如卡点抢购），GitHub 不合适，建议上云服务器 Docker（`deploy/README.md`）。

### 限制 2：免费额度

- 每 5 分钟 = 288 次/天
- 每次跑浏览器约 50~70 秒
- 约 288 分钟/天 × 30 天 ≈ **8600 分钟/月**
- 免费额度只有 **2000 分钟/月**，只能撑约 7 天

所以要么：
- 改成 **30 分钟一次**（`*/30 * * * *`），免费额度够用，但上新延迟最多 30 分钟；
- 或者接受月底额度耗尽、自动停。

---

## 部署步骤（5 分钟搞定）

### 1. 把项目推到 GitHub

```bash
cd jd-today-crawler
git init
git add .
git commit -m "jd babel push"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 配置 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，加这几个：

| Secret 名 | 值 |
|---|---|
| `NOTIFY_CHANNEL` | `pushplus` |
| `NOTIFY_TOKEN` | `你的PUSHPLUS_TOKEN` |

（如果用别的推送通道，改 `NOTIFY_CHANNEL` + 填 `NOTIFY_URL`）

### 3. 放工作流

把本目录的 `jd-push.yml` 复制到仓库的 `.github/workflows/jd-push.yml`：

```bash
mkdir -p .github/workflows
cp deploy/github/jd-push.yml .github/workflows/jd-push.yml
git add .github && git commit -m "add workflow" && git push
```

### 4. 触发

- 推上去后，`schedule` 会自动开始（首次可能要等下一个整 5 分钟）；
- 或者到 Actions 页手动 "Run workflow" 立刻测一次。

---

## 关键设计：基线持久化

GitHub Actions 每次运行是全新容器，`/tmp` 不保留。如果基线丢了，每轮都会当成"首轮"推全部 29 条（刷屏）。

所以工作流里做了**把基线提交回仓库**这一步：

```yaml
- name: Persist baseline
  run: |
    git add data/snapshots/baseline.json data/push/feed.jsonl
    git commit -m "update baseline" || echo "no change"
    git push
```

这样上一轮的"在架 29 条"存在 git 历史里，下一轮 checkout 出来就能 diff，只推真正的新上。

> 代价：仓库提交记录会很多（每 5 分钟一条）。介意的话可以只提交 `baseline.json`，或接受它。

---

## 关于"第二天再上算不算上新"

**算。** 逻辑是"对比上一轮在架列表"：

- 商品 A 昨天有 → 今天下架（从基线消失）→ 明早再上 → 判为**新增**，会推。
- 只要中间真的下过架，第二天再上一定推。
- 但如果某商品从头到尾一直挂在列表里没下过架，那它不是"新上"，不会推（这是对的）。

---

## 备选：30 分钟一次（省额度，推荐先用这个）

把 `jd-push.yml` 里的 cron 改成：

```yaml
- cron: "*/30 * * * *"
```

免费额度完全够用，上新延迟最多 30 分钟。先用这个跑通，确认没问题再决定要不要 5 分钟。

---

## 常见问题

**Q：每次运行都推 29 条？**
A：基线没持久化成功。检查仓库里是否有 `data/snapshots/baseline.json`，以及 workflow 里 `permissions: contents: write` 是否加上。

**Q：拿不到 29 条，只有 16？**
A：看 log 里 `CHROME_PATH` 是否生效。`ubuntu-latest` 自带 Chrome，路径通常是 `/usr/bin/google-chrome` 或 `/usr/bin/google-chrome-stable`。若报错找不到浏览器，在 workflow 里加一步：
```yaml
- name: Install Chromium
  run: npx playwright install chromium --with-deps
```
并把 `CHROME_PATH` 去掉（让代码自动探测 `channel: 'chrome'`）。

**Q：会被京东风控吗？**
A：GitHub 的服务器 IP 在海外，京东可能对海外 IP 有额外风控。实测本机能 29 条，GitHub 的 IP 不保证。如果被拦（只有 16 条 + 降级提示），说明 IP 被风控，建议回到云服务器 Docker（国内 IP）方案。

**Q：GitHub 是海外 IP，会不会比国内服务器更容易被拦？**
A：可能。这是 GitHub 方案最大的不确定性。要稳定，还是国内云服务器 + Docker 最稳。
