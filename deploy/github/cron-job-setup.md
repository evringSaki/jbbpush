# cron-job.org + GitHub Actions 组合方案

用 cron-job.org 精准定时，触发 GitHub Actions 抓取并推送。**免费、不用电脑、不用 Cookie、29 条**。

## 为什么这个组合好

| 单独用 | 问题 |
|---|---|
| GitHub 自带 schedule | 不准时（延迟几十分钟） |
| 云函数 + cron-job | 冷启动丢基线，"只推上新"失效 + 只有 16 条 |
| 云服务器 Docker | 要花钱 |

**组合后**：cron-job.org 提供精准定时，GitHub Actions 提供运行环境（Chromium → 29 条）+ 基线持久化（提交回 git）。三者短板互补。

## 但仍有两个硬限制（务必先看）

1. **GitHub 免费额度 2000 分钟/月**：5 分钟一次 × 每次约 60 秒 ≈ 8600 分钟/月，只能撑约 7 天。要么接受月底停，要么改成 10~15 分钟一次。
2. **海外 IP 风控风险**：GitHub 服务器在海外，京东风控对海外 IP 可能更严。本机（国内 IP）实测能 29 条，GitHub 不保证。若只有 16 条 + 降级提示，说明 IP 被拦。

---

## 部署步骤

### 1. 推项目到 GitHub

```bash
cd jd-today-crawler
git init
git add .
git commit -m "jd babel push"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

### 2. 放工作流

```bash
mkdir -p .github/workflows
cp deploy/github/jd-push.yml .github/workflows/jd-push.yml
git add .github && git commit -m "add workflow" && git push
```

### 3. 配置 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret 名 | 值 |
|---|---|
| `NOTIFY_CHANNEL` | `pushplus` |
| `NOTIFY_TOKEN` | `你的PUSHPLUS_TOKEN` |

### 4. 生成 GitHub PAT（Personal Access Token）

cron-job.org 触发 workflow 需要带凭证。

1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)**
2. 生成一个 classic token，权限勾选 **`workflow`**（细粒度 token 则勾 **Actions: Read and write**）
3. **复制保存**（只显示一次）

### 5. 配置 cron-job.org

1. 打开 <https://cron-job.org>，注册登录（免费）
2. 新建 Cron job：

| 字段 | 值 |
|---|---|
| Title | `jd-babel-push` |
| URL | `https://api.github.com/repos/<用户名>/<仓库名>/actions/workflows/jd-push.yml/dispatches` |
| 执行计划 | 每 5 分钟 |
| Request method | **POST** |

请求头（cron-job.org 里加自定义 header，**这几个都必需**）：

```
Accept: application/vnd.github+json
Authorization: Bearer <你的PAT>
X-GitHub-Api-Version: 2026-03-10
Content-Type: application/json
```

请求体（Body，选 raw JSON）：

```json
{"ref":"main"}
```

> 成功会返回 204（No Content），cron-job.org 把它当成功即可。

### 6. 验证

- cron-job.org 里点 "Run now" 立刻触发一次；
- 看 GitHub Actions 里是否出现一次 run；
- 微信收到 PushPlus 消息即成功。

---

## 为什么基线能持久化（关键）

GitHub Actions 每次运行是全新容器，但工作流最后把 `data/snapshots/baseline.json` **提交回 git**：

```yaml
git add data/snapshots/baseline.json
git commit -m "update baseline"
git push
```

这样下一轮 checkout 时，基线就是上一轮的在架列表，能正确 diff 出"新增"，只推真正新上的商品。

> 代价：仓库提交记录每 5 分钟一条，会很多。介意的话可接受，或改成 10 分钟一次。

---

## 额度不够怎么办（建议先这样）

先改成 **10 分钟一次**（cron-job.org 里选每 10 分钟）：

- 10 分钟 × 288 分钟/天 ≈ 1440 分钟/月，**免费额度内**；
- 上新延迟最多 10 分钟，对"加倍补上新"完全够用。

要精准卡点抢购的话，这个延迟可能不够，那得上云服务器 Docker。

---

## 常见问题

**Q：cron-job.org 触发后 GitHub 没反应？**
A：检查 ① PAT 有 `workflow` 权限；② URL 里工作流文件名对（`jd-push.yml`）；③ 请求头 `Authorization: Bearer <PAT>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2026-03-10` 一个都不能少；④ 成功返回 204 无内容属正常。

**Q：每次都推全部 29 条？**
A：基线没持久化。看仓库里 `data/snapshots/baseline.json` 是否在持续更新，以及 workflow 里 `permissions: contents: write` 是否生效。

**Q：只有 16 条？**
A：海外 IP 被风控。看 log 里 `CHROME_PATH` 是否找到浏览器；若浏览器正常但只有 16 条 + 降级提示，就是 IP 被拦，只能换国内云服务器。

**Q：cron-job.org 免费版够用吗？**
A：免费版有执行次数限制（通常够每 5 分钟跑一个月），但**不保证**。若触发不了，免费额度可能不够，换国内云服务器最稳。
