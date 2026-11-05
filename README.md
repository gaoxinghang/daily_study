# 拾光 · 每日学习

原生 HTML/CSS/JavaScript 前端、Node.js API 和 PostgreSQL 账号数据库。

## 在线使用

**https://1.12.67.229/**

HTTP 首页会跳转至 HTTPS。注册账号后即可使用：

- 用户名和密码注册、登录、退出。
- 昵称、个人简介、主题和提示音偏好随账号保存。
- 任务、计时状态、最近 30 个记录日的学习足迹云端同步。
- 一个账号只有一个有效登录会话；在新设备或浏览器登录会替换旧会话。
- 旧会话的 API 访问立即失效；前台页面每 5 秒检查一次，
  后台标签恢复可见时也会检查。后台浏览器可能限制定时器运行频率。
- 同一浏览器的多个标签可以共享会话，使用数据版本号避免覆盖。
  冲突时会明确提示并加载云端版本，需重新进行未保存的编辑。
- 会话有效期为 7 天；目前没有邮件验证或自助找回密码功能。

用户名为 3～32 位英文字母、数字或下划线，不区分大小写。
密码长度为 10～128 位，不会以明文形式保存。

## 数据与同步

账号资料及学习状态保存在 PostgreSQL 的 `study_users` 表中。
任务和偏好使用 JSONB，密码使用独立随机盐的 scrypt 哈希。
浏览器仅用 HttpOnly cookie 保存会话令牌，数据库只保存令牌摘要。

每次操作后会自动同步，页面底部显示同步结果。
**看到“尚未同步”时不要关闭或刷新页面**；
网络恢复后会重试。未保存变更只暂存在当前页面内存中，
不会写入共享的浏览器 localStorage，避免退出后串号。

只有倒计时结束才完成任务；刷新页面不会停止计时。
跨午夜的计时只归入前一天午夜以前的部分，次日不会自动开始。
删除或重置任务会清除该任务当天的计入时长。
每天重复任务，最多 300 项；历史最多保存 29 条归档及今天。

### 导入旧版记录

旧版 localStorage 不会被自动覆盖或删除。

登录后打开右上角“个人资料与账号”，选择“导入此浏览器的旧记录”。
导入需明确确认，**会替换当前账号的云端计划**，而不是合并。
请先确认登录的是自己的账号。

HTTP 与 HTTPS 的浏览器存储相互隔离。HTTPS 页面找不到记录时，
会打开专用 HTTP 迁移页；该页面不要求密码，只读取旧记录，
通过来源、窗口及随机标识校验后发送回账号页面。
若浏览器强制升级为 HTTPS，迁移页会说明无法读取；
此时原始记录仍在，需协助导出，不能把“读取不到”当成记录已丢失。
同一浏览器的旧 HTTPS 记录可直接导入。

## 本地开发

需要 Node.js 22+ 和 PostgreSQL。

先准备 `daily_study` 数据库及具有该库建表权限的应用账号，
再执行：

```bash
npm ci
cp .env.example .env
# 按本机数据库配置编辑 .env。
npm run migrate
npm start
```

打开 http://localhost:3000/。
`PUBLIC_ORIGIN` 必须与浏览器地址一致，不能混用 localhost 与 127.0.0.1。
环境文件不会提交到 Git；示例密码不能用于真实部署。

PostgreSQL 连接支持标准 `PGHOST`、`PGPORT`、`PGDATABASE`、
`PGUSER`、`PGPASSWORD`，也支持 `DATABASE_URL`。

## 测试

```bash
npm test
```

默认执行模型、密码与静态服务器测试，数据库集成测试跳过。
运行完整集成测试时，必须显式指定名称包含 `test` 的隔离数据库：

```bash
PGHOST=/var/run/postgresql \
PGUSER=daily_study_app \
PGDATABASE=daily_study_test \
TEST_DATABASE=1 npm test
```

集成测试包含注册、错误密码、CSRF、资料更新、版本冲突、账号隔离、
新设备踢出旧设备、并发登录、会话过期、退出及跨进程持久化。
测试会清理其创建的账号，不要对生产数据库运行。

## 项目结构

| 文件 | 职责 |
| --- | --- |
| `app.js`、`model.js` | 学习界面与计时模型 |
| `cloud.js` | 登录界面、云端保存、冲突与会话失效处理 |
| `server.js` | HTTP 服务和静态资源白名单 |
| `api.js`、`auth.js` | 账号 API、会话、密码哈希及输入校验 |
| `database.js`、`migrate.js` | PostgreSQL 连接与幂等建表 |
| `account.css` | 注册、登录和个人资料样式 |
| `legacy-import.*` | 旧 HTTP 来源的浏览器记录迁移页 |
| `deploy/` | Nginx、systemd、续期和备份配置 |

## 当前生产部署

- 应用目录：`/opt/daily-study/current`，指向版本目录。
- 旧静态站点：`/home/workspace/daily_study`，保留但不再公开提供文件。
- 应用服务：`daily-study.service`，仅监听 `127.0.0.1:3000`。
- 应用环境：`/etc/daily-study.env`，仅 root 可读。
- 运行用户：`daily_study_app`，不是 root。
- 数据库：`daily_study`，应用通过 Unix socket 和 peer 认证连接，
  不需要在应用环境中保存数据库密码；5432 不监听公网。
- Nginx：`/etc/nginx/conf.d/daily_study.conf`，反向代理 Node.js，
  禁止隐藏路径访问；其他非公开文件由静态白名单阻止。
- HTTPS：Let's Encrypt 的 IP 短期证书，约 6 天有效。
  `daily-study-cert-renew.timer` 每天检查两次，
  续期成功后自动检查并重载 Nginx。
- 数据库备份：`daily-study-backup.timer` 每天 03:00 执行，
  保存于 `/var/backups/daily-study-db`，保留约 14 天。
  这些是同机备份，不能替代异地备份。

```bash
systemctl status daily-study
journalctl -u daily-study -n 50 --no-pager
nginx -t
systemctl list-timers 'daily-study-*'
```

部署配置见 `deploy/`。公网必须启用 HTTPS、`COOKIE_SECURE=true`，
并设置准确的 `PUBLIC_ORIGIN`。只在 Node.js 不对公网监听且前面有
可信反向代理时启用 `TRUST_PROXY=true`。
不要把整个代码仓库作为可公开读取的静态目录。
