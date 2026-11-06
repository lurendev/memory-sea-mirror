FROM node:18-alpine

# 时区设为上海，保证日记时间正确（Alpine 需要先装 tzdata）
ENV TZ=Asia/Shanghai
RUN apk add --no-cache tzdata \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone

WORKDIR /app

# 先装依赖，利用镜像层缓存（本项目零依赖，npm install 只做占位）
COPY package*.json ./
RUN npm install --production

# 复制源码（.env、data 等敏感/临时文件已被 .dockerignore 排除）
COPY . .

# 默认数据目录；Sealos 挂载持久卷后该目录会被卷覆盖
RUN mkdir -p /app/data

ENV PORT=8787
ENV DATA_DIR=/app/data

EXPOSE 8787

CMD ["node", "server.js"]
