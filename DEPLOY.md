# 部署指南（Sealos + 阿里云 ACR）

> 代码仓库只是存档，部署走的是镜像：本地构建 → push 到 ACR → Sealos 拉镜像运行。`data/` 与 `.env` 不会随镜像打包，也不应提交到仓库。

## 示例环境配置

| 项 | 值 |
| --- | --- |
| 线上地址 | `https://你的域名/`（务必用 https，不要用 http） |
| 镜像仓库（公网） | `registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名` |
| 当前镜像 tag | `2.2` |
| 容器端口 | `8787` |
| 数据目录 | `/app/data`（必须挂持久卷） |

## 一、本地构建镜像

在包含 `Dockerfile` 的项目根目录执行：

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名:2.2 .
```

以后发新版本就把 `2.2` 换成新 tag（如 `2.3`），不要覆盖旧 tag，方便回滚。

## 二、登录并推送

```bash
docker login --username=你的阿里云账号 registry.cn-hangzhou.aliyuncs.com
# 密码填 ACR「访问凭证 → 固定密码」，不是阿里云账号密码

docker push registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名:2.2
```

如果你的镜像仓库是**私有**的，注意要用**公网**地址 `registry.cn-hangzhou.aliyuncs.com`；`registry-vpc...` 只有阿里云内网能拉。

## 三、Sealos 创建应用（镜像部署）

1. 桌面 →「应用管理」→「新建应用」→ 选 **镜像部署**。
2. 镜像地址填 `registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名:2.2`。
3. 私有镜像仓要先在 Sealos 添加镜像仓库凭据（用户名＝阿里云账号，密码＝ACR 固定密码）。
4. 容器端口填 `8787`（与 `Dockerfile` 的 `EXPOSE` 一致）。
5. 填环境变量：

   | 变量 | 必填 | 说明 |
   | --- | --- | --- |
   | `SITE_PASS` | 必填 | 站点访问密码；不填门禁关闭，日记对公网可见 |
   | `SITE_USER` | 可选 | 访问用户名，默认 `admin` |
   | `LLM_API_KEY` | AI 日记必填 | 大模型 Key，只注入环境变量，不写进代码/仓库 |
   | `DATA_DIR` | 建议填 | 固定为 `/app/data` |
   | `PORT` | 可选 | 默认 8787，平台一般会自动注入 |
   | `LLM_API_URL` / `LLM_MODEL` | 可选 | 默认 DeepSeek |
   | `WRITE_TOKEN` | 可选 | 写入令牌，开启后 `PUT`/`DELETE` 及日记备份需带 `x-write-token` |

6. **存储卷（关键）**：新建 PVC（1–5 GiB 即可），挂载路径填 **`/app/data`**。
   - 挂载路径必须与 `DATA_DIR` 一致。
   - 不挂载也能启动，但应用重启/重新部署后 `graph.json`、`diary_log.md` 会全部丢失。
7. 点击「部署」，等镜像拉取完成、状态变绿。

## 四、上线后验证

1. **门禁**：无痕窗口打开域名，应弹出登录框；直接进去说明 `SITE_PASS` 没生效，检查环境变量后重启。
2. **数据隔离**：登录后访问 `https://你的域名/data/diary_log.md`，必须是 **404**。
3. **持久化**：写一篇日记 → 刷新确认在 → 在 Sealos 里重启/重新部署 → 仍在，说明 PVC 挂载正确。
4. **AI**：点右下角 📝 写一篇发射，若提示未配置 Key，检查 `LLM_API_KEY` 是否注入。

> ⚠️ 始终用 `https://` 访问。Basic Auth 在 `http://` 下是明文传输账号密码，可能被中间人截获；该域名已支持 HTTPS，不要再用 http 地址。

## 五、后续更新

```bash
docker build -t registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名:2.2 .
docker push registry.cn-hangzhou.aliyuncs.com/你的命名空间/你的镜像名:2.2
```

然后在 Sealos 应用里把镜像 tag 改成 `2.2` 重新部署即可，PVC 数据不受影响。

## 六、数据备份

- 页面左侧「数据」区的「导出 JSON」：随时导出一份图谱快照到本机。
- 从 PVC 定期导出 `data/graph.json` 与 `data/diary_log.md`（这是日记原文备份）。
- `.env` 只留在本机，不要提交、不要放进镜像。

## 本地直接运行（可选）

```bash
docker build -t memory-mirror .
docker run -d -p 8787:8787 -e SITE_PASS=你的密码 -v memory-data:/app/data memory-mirror
```
