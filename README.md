# dsh-kisssub

给 **DeepSeek Harness** 用的 [爱恋动漫 kisssub.org](https://kisssub.org)（站点自研程序 **MioBT**）下载插件。

它给 agent 6 个工具：搜索资源、拿最新发布、解析磁链、**投递到无 GUI 的下载器**（aria2 JSON-RPC / qBittorrent-nox WebUI）、写配置、排查。

```
kisssub_search     关键词搜索（走站点 search.php，自动过人机验证门；失败自动退回免 Cookie 的 RSS）
kisssub_latest     全站最新发布（RSS，免 Cookie）
kisssub_magnet     由 magnet / BTIH / 详情页链接 / 种子直链 解析出规范条目（标题、发布组、大小、磁链…）
kisssub_download   投递到下载器（默认顺便抓详情页补全标题），返回 ok / 任务 id / 实际保存目录
kisssub_configure  把设置写进配置文件（默认保存目录、下载器、账号）
kisssub_status     回显生效配置（密钥脱敏）+ 下载器连通性 + 首次使用引导
```

## 首次使用：配置文件与默认下载目录

**配置文件会在第一次使用时自动创建**，不需要手动准备：

- 默认路径 `~/.dsh/dsh-kisssub.json`，可以用 `configFile` 或 `KISSSUB_CONFIG_FILE` 改到别处。
- 插件装载（第一次使用）时创建，之后每次调用工具发现文件没了也会补建；父目录不存在会一起建。
- 自动创建的只写最小字段集 `savePath` / `defaultSavePath` / `savePathConfirmed`，
  **不会**把 `downloader`、密码这些默认值写进去——否则文件层会反过来把 profile 插件 config 和内置默认值遮住。

**下载保存目录**：

- 用户指定过 → 用 `savePath`；
- 没指定 → 落到 `defaultSavePath`，默认 **`~/Downloads/kisssub`**；
- 单次调用还可以用 `kisssub_download` 的 `savePath` 参数临时覆盖。

**谁去问用户**：插件装载时会往系统提示里插一段（仅在"未确认"时出现），让 agent 主动问一句
「下载的资源默认保存到哪个目录？」，拿到答复后用 `kisssub_configure` 写进配置文件；
用户回答"就用默认"时也会写一次标记，避免反复追问。

```
agent:  下载的资源默认保存到哪个目录？（不指定就用 ~/Downloads/kisssub）
用户:   /data/downloads/anime
agent → kisssub_configure { savePath: "/data/downloads/anime" }
       ✅ 配置已保存 — 本次写入: savePath, savePathConfirmed
```

`kisssub_configure` 的 `savePath` 只接受**绝对路径**（`~` 开头会展开）；传相对路径会明确报错，
不会静默按 cwd 解析。写入是合并语义，只改传入的字段，`_createdAt` 之类的原有内容都保留。

## 安装

### 方式 A：正式装进 profile（推荐）

```sh
cd /home/sakana/workspace/dsh
dsh plugin --profile web add ./dsh-kisssub
```

`dsh plugin` 会转发给 profile 目录里的 pnpm，并把本包追加进 profile 的 `dsh.profile.bundles`。
之后**重启承载该 profile 的进程**（当前那个 `dsh web`）才会加载插件；重启后在会话里直接说
「用 kisssub 搜一下葬送的芙莉莲」「把 <磁链> 丢进下载器」即可，agent 会自动选工具。

> 插件是纯 ESM JavaScript，没有构建步骤，不需要 pnpm 的 build 许可。
> 依赖的 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 由 DSH 自身提供（peerDependencies）。

### 方式 B：不安装，`--patch` 临时加载

仓库里的 `cordis.patch.yml` 是按包名引用的（安装后才生效）。想零安装试一次，用绝对路径覆盖：

```yaml
# /tmp/kisssub-dev.yml
- insert:
    - id: kisssub
      name: '/home/sakana/workspace/dsh/dsh-kisssub/lib/index.js'
```

```sh
dsh web --patch /tmp/kisssub-dev.yml
```

这条路径要求插件目录下能解析到 `@deepseek-ai/*`，本目录已经放好了软链
（`node_modules/@deepseek-ai -> /home/sakana/.dsh/profiles/node_modules/@deepseek-ai`），
它只是本机的开发便利，不在 `package.json.files` 里，不会被当作包内容分发。

## 配置

三层来源，**后者覆盖前者**：

1. 内置默认值
2. 插件 config —— 在 profile 的 `cordis.patch.yml` 里按 `id: kisssub` 覆盖这一行
3. `~/.dsh/dsh-kisssub.json`（把 `dsh-kisssub.example.json` 复制过去改）
4. 环境变量 `KISSSUB_*`

**密码只放第 3/4 层**，不要写进 profile 配置。全部字段：

| 字段 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `configFile` | `KISSSUB_CONFIG_FILE` | `~/.dsh/dsh-kisssub.json` | 配置文件位置，首次使用时自动创建 |
| `baseUrl` | `KISSSUB_BASE_URL` | `https://kisssub.org` | 站点地址 |
| `cookie` | `KISSSUB_COOKIE` | 空 | 手动补的 Cookie；留空则自动过访客门 |
| `autoVisitorTest` | `KISSSUB_AUTO_VISITOR_TEST` | `true` | 自动完成 `visitor_test=human` 人机验证 |
| `timeoutMs` | `KISSSUB_TIMEOUT_MS` | `15000` | 单请求超时 |
| `trackers` | `KISSSUB_TRACKERS`（逗号分隔） | 内置 5 个 | 合成磁链时的 tracker；站点种子里首个是 `open.acgtracker.com` |
| `downloader` | `KISSSUB_DOWNLOADER` | `none` | `none` / `aria2` / `qbittorrent` |
| `aria2Rpc` | `KISSSUB_ARIA2_RPC` | `http://127.0.0.1:6800/jsonrpc` | aria2 RPC 地址 |
| `aria2Secret` | `KISSSUB_ARIA2_SECRET` | 空 | aria2 `--rpc-secret` |
| `qbUrl` | `KISSSUB_QB_URL` | `http://127.0.0.1:8080` | qBittorrent WebUI 地址 |
| `qbUsername` / `qbPassword` | `KISSSUB_QB_USERNAME` / `KISSSUB_QB_PASSWORD` | `admin` / 空 | WebUI 账号 |
| `savePath` | `KISSSUB_SAVE_PATH` | 空 | 用户指定的下载目录；空则用 `defaultSavePath` |
| `defaultSavePath` | `KISSSUB_DEFAULT_SAVE_PATH` | `~/Downloads/kisssub` | 用户没指定时下载到这里 |
| `savePathConfirmed` | `KISSSUB_SAVE_PATH_CONFIRMED` | `false` | 是否已就默认目录问过用户（决定系统提示是否提醒） |
| `category` / `tags` | `KISSSUB_CATEGORY` / `KISSSUB_TAGS` | `kisssub` | 仅 qBittorrent |
| `defaultLimit` | `KISSSUB_DEFAULT_LIMIT` | `20` | 工具不传 `limit` 时的条数 |

### 无 GUI 下载器示例

**aria2**（`--rpc-secret` 记得和配置一致）：

```sh
aria2c --enable-rpc --rpc-listen-all=false --rpc-secret=YOUR_SECRET \
       --dir=/downloads/anime --continue=true
```

```json
{ "downloader": "aria2", "aria2Rpc": "http://127.0.0.1:6800/jsonrpc", "aria2Secret": "YOUR_SECRET" }
```

**qBittorrent-nox**（无 GUI 版，只要开 WebUI）：

```sh
qbittorrent-nox --webui-port=8080
```

```json
{ "downloader": "qbittorrent", "qbUrl": "http://127.0.0.1:8080", "qbUsername": "admin", "qbPassword": "xxx",
  "savePath": "/downloads/anime", "category": "kisssub", "tags": "kisssub" }
```

配好后先让 agent 调一次 `kisssub_status` 确认「可达」。

## 站点注意事项（都是实测结论）

- **必须带 `Accept-Language`**：站点前面的 Cloudflare 风控会把缺少这个头的请求**直接 404**（连 `rss.xml` 都 404）。插件已内置，自己写脚本调这个站时也要注意。
- **访客门**：首页、`search.php`、详情页 `show-*.html` 对无 Cookie 请求 302 到 `/public/html/start/`。
  插件会自动 `POST addon.php?r=document/view&page=visitor-test` 带 `visitor_test=human` 拿到 Cookie 再重试，无需人工。
- **RSS 免 Cookie**：`rss.xml` 与 `rss-<关键词>.xml` 不需要上面那一套，单页 50 条，是 `kisssub_latest` 和 RSS 搜索通道的后端。
- **磁链是本地合成的**：详情页里的磁链写在 HTML 注释中，`down.php?date=&hash=` 有精确时间戳防盗链（403）。
  所以插件一律用 40 位 BTIH 合成 `magnet:?xt=urn:btih:<hash>`，种子一律走
  `http://v2.uploadbt.com/?r=down&hash=<hash>`（免 Cookie、`application/x-bittorrent`）。
- **没有做种/下载数**：站点列表不提供 seeders/leechers，所以工具结果里没有这两个字段，按做种数择优的策略在这个站无效。
- 有发布组（UP主）、类别、大小、发布时间；RSS 通道**没有大小和类别**，需要时用站点搜索。

## 测试

```sh
node test/config.mjs      # 配置层：首次创建、默认保存目录、优先级、写入合并、脱敏
node test/bundle.mjs      # bundle 清单自检（main / patch / 导出）
node test/live.mjs        # 真实站点（只读）：RSS / 站点搜索 / 访客门 / 详情页 / 种子直链
node test/load.mjs        # 装载插件：工具契约 + output.schema 校验 + 首次使用闭环 + 系统提示引导
node test/downloader.mjs  # 真起一个 aria2 RPC 实例真投递；qBittorrent 用本地 mock 校验协议细节
```

`live` 与 `downloader` 需要外网；`downloader` 里的 qBittorrent 部分是本地 mock，
没有 `qbittorrent-nox` 也能跑。本机装了 `aria2c` 时会走真实 aria2。
`config` 与 `load` 全程用临时目录，不会碰你真实的配置文件。

## 结构

```
dsh-kisssub/
├── package.json            # 声明 dsh.bundle.patch
├── cordis.patch.yml        # 插入 id=kisssub 的插件行
├── lib/
│   ├── index.js            # 插件入口：Config + 6 个 defineTool + 首次使用引导
│   ├── kisssub.js          # 站点客户端（零依赖，可单独复用/测试）
│   ├── downloader.js       # aria2 JSON-RPC + qBittorrent WebUI 适配
│   └── config.js           # 配置归一化 + 配置文件首次创建/写入
├── test/                   # 5 个测试
└── dsh-kisssub.example.json
```

`lib/kisssub.js` 不 import 任何 `@deepseek-ai/*`，可以脱离 DSH 直接用来写别的脚本：

```js
import { KisssubClient } from './lib/kisssub.js'
const client = new KisssubClient()
const { items } = await client.search('葬送的芙莉莲', { limit: 5 })
console.log(items[0].title, items[0].magnet)
```

## 许可

MIT
