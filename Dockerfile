# 星课云·作品互评 — 一体化镜像（前端静态页 + Node 后端 + 文件存储）
FROM node:20-alpine

WORKDIR /app

# 仅安装生产依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 应用代码
COPY server.js index.html ./

# 持久化目录（uploads/ 与 data.json 都在此目录下，运行时挂载卷）
ENV DATA_DIR=/data
RUN mkdir -p /data/uploads
VOLUME ["/data"]

# Render 会注入 PORT 环境变量；本地默认 8899
ENV PORT=8899
EXPOSE 8899

CMD ["node", "server.js"]
