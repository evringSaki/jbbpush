# 云端常驻版：容器内自带 Chromium，无需本机 Edge、无需登录 Cookie
#
# 2026-11-06 更新：桌面 UA + 无头 Chromium 即可拿到全部 29 条（无需 JD_COOKIE）
#
# 构建（在项目根目录执行）：
#   docker build -f deploy/Dockerfile -t jd-babel-push .
#
# 运行：
#   docker run -d --name jd-babel-push --restart always \
#     -e NOTIFY_CHANNEL=pushplus \
#     -e NOTIFY_TOKEN="你的PUSHPLUS_TOKEN" \
#     -e PUSH_INTERVAL=5 \
#     -v "$PWD/data:/app/data" \
#     jd-babel-push

FROM node:20-bookworm-slim

ENV TZ=Asia/Shanghai \
    CHROME_PATH=/usr/bin/chromium \
    PUSH_INTERVAL=5 \
    NODE_ENV=production \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      ca-certificates \
      tzdata \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p data/push data/snapshots

# watch.js 检测到 CHROME_PATH 就走 --browser（无头 chromium，桌面 UA）
# 周期由 PUSH_INTERVAL 控制（默认 5 分钟）
CMD ["node", "src/watch.js", "--browser"]
