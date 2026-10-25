# Mac mini 部署手册

目标：办公室 Mac mini 运行浴族服务，门店电脑和平板在同一局域网内用浏览器访问；断电重启后自动恢复；每天自动备份到独立磁盘。

## 1. 准备 Mac mini

1. **系统设置 → 通用 → 共享**：记下电脑名称；**网络** 中记下局域网 IP（如 `192.168.1.20`）。
2. 在路由器后台为 Mac mini 的网卡**绑定固定 IP**（DHCP 保留），避免重启后 IP 变化。
3. **系统设置 → 能源**：开启「停电后自动启动」，关闭「自动进入睡眠」。
4. **系统设置 → 用户与群组**：为运行服务的账户开启**自动登录**（Docker Desktop 需要登录后才启动）。
5. 安装 **Docker Desktop for Mac（Apple 芯片版）** 或 **OrbStack**，并在设置中勾选「登录时启动」。
6. 安装 Git（首次执行 `git` 时系统会提示安装命令行工具）。
7. 接上备份用的外置硬盘，例如挂载在 `/Volumes/YuzuBackup`，新建目录 `/Volumes/YuzuBackup/yuzu`。

> 国内网络拉取 Docker 镜像较慢时：在 Docker Desktop → Settings → Docker Engine 配置镜像加速，或在 `.env` 中设置 `NODE_IMAGE` / `POSTGRES_IMAGE` / `NPM_REGISTRY` 使用国内镜像源（见 `.env.example`）。

## 2. 获取代码并配置

```bash
cd ~
git clone https://github.com/Venture-VV/yuzu.git
cd yuzu
git checkout v0.1.0          # 只部署经过验证的版本标签
cp .env.example .env
open -e .env                 # 用文本编辑器修改
```

`.env` 至少修改：

| 变量 | 说明 |
| --- | --- |
| `APP_ENV` | 试用填 `trial`，正式填 `production`（正式环境禁止写入演示数据） |
| `POSTGRES_PASSWORD` | 数据库密码，建议用 `openssl rand -hex 24` 生成（只含字母数字，避免连接串转义问题） |
| `INIT_OWNER_USERNAME` / `INIT_OWNER_PASSWORD` | 第一位店主账号，首次登录后必须改密 |
| `BACKUP_DIR` | `/Volumes/YuzuBackup/yuzu` |
| `APP_PORT` | 默认 8080 |

`.env` 含密码，不会也不应提交到 GitHub。

## 3. 启动

```bash
docker compose up -d --build
docker compose ps            # app、db 显示 (healthy)，backup 显示 Up
docker compose logs app      # 应看到「已应用迁移」「已创建初始店主账号」「浴族 yuzu 已启动」
```

在门店电脑浏览器访问 `http://192.168.1.20:8080`（换成 Mac mini 的 IP），用初始店主登录并修改密码，然后在「管理」中：

1. 添加店员账号（系统生成临时密码，当面告知）；
2. 录入实际的充值套餐与消费项目；
3. 按确认结果设置扣款顺序和营业日切换时间。

试用阶段如需演示数据：`docker compose exec app node dist/server/cli.js seed-demo`（正式环境会拒绝）。

## 4. 上线前验证清单

- [ ] 门店电脑、平板都能打开并登录；平板横竖屏布局正常
- [ ] 用合成会员走一遍：充值 100 → 消费 30 → 余额 70 → 店主撤销 → 恢复 100；日结显示「核对一致」
- [ ] `docker compose restart` 后数据仍在；**拔电重启 Mac mini** 后服务自动恢复（等 Docker 启动约 1–2 分钟）
- [ ] 断开门店外网（拔掉光猫上行），局域网内仍可正常登录、充值、消费
- [ ] `./scripts/backup.sh` 成功，备份文件出现在外置盘
- [ ] 做一次恢复演练：`./scripts/restore.sh <备份文件>`，结束时显示 4 项核对 ✓
- [ ] 清理演示数据：试用结束转正式时，建议使用全新的数据库卷（见下文「环境隔离」）

## 5. 日常运维

| 场景 | 命令 |
| --- | --- |
| 查看状态 | `docker compose ps` |
| 查看日志 | `docker compose logs -f app`、`docker compose logs backup` |
| 重启服务 | `docker compose restart app` |
| 立即备份 | `./scripts/backup.sh` |
| 核对余额与流水 | `docker compose exec app node dist/server/cli.js check` |
| 店主忘记密码 | `docker compose exec app node dist/server/cli.js reset-password <账号>` |
| 更新版本 | `./scripts/update.sh v0.2.0` |
| 恢复备份 | `./scripts/restore.sh <备份文件>` |

## 6. 环境隔离

- 开发：MacBook Air 上 `compose.dev.yaml` 只跑数据库，应用用 `npm run dev`，数据库为 `yuzu-dev_dev-pgdata` 卷。
- 试用 / 正式：Mac mini 上用 `compose.yaml`，数据保存在 Docker 卷 `yuzu_pgdata` 中。
- 同一台机器同时保留试用和正式环境：

  ```bash
  cp .env .env.trial            # 修改 APP_ENV=trial、APP_PORT=8081、BACKUP_DIR 等
  docker compose --env-file .env.trial -p yuzu-trial up -d --build
  ```

  不同项目名（`-p`）对应不同的数据卷，互不影响。

- **不要**执行 `docker compose down -v`，`-v` 会删除数据库卷。

## 7. 备份策略建议

- 自动：每天凌晨备份到外置盘，保留 30 天。
- 每周：把外置盘中最新的备份复制到店外（加密 U 盘或可信网盘）。
- 每月：在另一台电脑上做一次恢复演练，确认备份可用。
- 更新版本前：`update.sh` 会自动先备份一次。
