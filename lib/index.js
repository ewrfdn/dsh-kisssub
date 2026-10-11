/**
 * dsh-kisssub —— DeepSeek Harness 插件（host）。
 *
 * 给 agent 用的一组工具：
 *   - `kisssub_search`     关键词搜索（站点 search.php，自动过访客门；失败退回免 Cookie 的 RSS）
 *   - `kisssub_latest`     全站最新发布（RSS，免 Cookie）
 *   - `kisssub_magnet`     由 magnet / BTIH / 详情页 / 种子直链 解析出规范条目
 *   - `kisssub_download`   投递到无 GUI 下载器（aria2 JSON-RPC / qBittorrent-nox WebUI）
 *   - `kisssub_configure`  写入配置文件（默认保存目录、下载器、账号）
 *   - `kisssub_status`     回显配置（隐去密钥）+ 下载器连通性 + 首次使用引导
 *
 * 配置文件默认 `~/.dsh/dsh-kisssub.json`，**第一次使用时自动创建**；
 * 用户没有指定下载目录时，落到配置里的 `defaultSavePath`（默认 `~/Downloads/kisssub`）。
 * 首次使用还会往系统提示里插一段，让 agent 主动去问用户"默认保存目录是哪个"。
 *
 * 配置优先级见 ./config.js。所有站点访问逻辑在 ./kisssub.js（零依赖，可独立复用）。
 *
 * @module dsh-kisssub
 */

import { isAbsolute } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { expandHome, maskConfig, resolveConfig, writeConfigFile, ensureConfigFile } from './config.js'
import { addDownload, probeDownloader } from './downloader.js'
import { KisssubClient } from './kisssub.js'

export const name = 'dsh-kisssub'
export const inject = ['tools']

/** 插件配置 schema。空串表示"未填"，会被 config.js 的上游来源覆盖。 */
export const Config = z.object({
  baseUrl: z.string().default(''),
  cookie: z.string().default(''),
  autoVisitorTest: z.boolean().default(true),
  timeoutMs: z.number().default(15_000),
  trackers: z.array(z.string()).default([]),
  downloader: z.union([z.const('none'), z.const('aria2'), z.const('qbittorrent')]).default('none'),
  aria2Rpc: z.string().default(''),
  aria2Secret: z.string().default(''),
  qbUrl: z.string().default(''),
  qbUsername: z.string().default(''),
  qbPassword: z.string().default(''),
  savePath: z.string().default(''),
  defaultSavePath: z.string().default(''),
  savePathConfirmed: z.boolean().default(false),
  category: z.string().default(''),
  tags: z.string().default(''),
  defaultLimit: z.number().default(20),
  configFile: z.string().default(''),
})

const text = (value) => [{ type: 'text', text: String(value) }]

/** 取一个命名 logger；宿主没提供时返回 null（可选依赖，不影响功能）。 */
function loggerFor(ctx) {
  try {
    if (typeof ctx?.logger === 'function') {
      const named = ctx.logger('dsh-kisssub')
      if (named && typeof named.info === 'function') return named
    }
    if (ctx?.logger && typeof ctx.logger.info === 'function') return ctx.logger
  } catch {
    /* 日志不可用不该影响插件 */
  }
  return null
}

/** 可空字段：oneOf [T, null]。 */
const nullable = (spec) => ({ oneOf: [spec, { type: 'null' }] })

/** 一条资源的规范结构。 */
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: nullable({ type: 'string' }),
    btih: { type: 'string' },
    magnet: { type: 'string' },
    torrentUrl: { type: 'string' },
    detailUrl: nullable({ type: 'string' }),
    category: nullable({ type: 'string' }),
    size: nullable({ type: 'string' }),
    publishedAt: nullable({ type: 'string' }),
    uploader: nullable({ type: 'string' }),
  },
}

const ITEMS_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string' },
    keyword: nullable({ type: 'string' }),
    page: { type: 'number' },
    count: { type: 'number' },
    note: nullable({ type: 'string' }),
    items: { type: 'array', items: ITEM_SCHEMA },
  },
}

/** 下载器探测结果。 */
const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configured: { type: 'boolean' },
    kind: { type: 'string' },
    reachable: { type: 'boolean' },
    detail: { type: 'string' },
  },
}

/** 首次使用 / 配置文件状态。 */
const SETUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    configFile: { type: 'string' },
    configFileCreated: { type: 'boolean' },
    configFileError: nullable({ type: 'string' }),
    savePath: { type: 'string' },
    defaultSavePath: { type: 'string' },
    effectiveSavePath: { type: 'string' },
    savePathConfirmed: { type: 'boolean' },
    firstRun: { type: 'boolean' },
    hint: { type: 'string' },
  },
}

/** 渲染条目列表。 */
function renderItems(result) {
  const lines = []
  const head = result.keyword
    ? `kisssub「${result.keyword}」共 ${result.count} 条`
    : `kisssub 最新发布 ${result.count} 条`
  lines.push(head + `（来源: ${result.source}${result.page > 1 ? `，第 ${result.page} 页` : ''}）`)
  if (result.note) lines.push(`注意: ${result.note}`)
  result.items.forEach((item, index) => {
    const meta = [item.category, item.size, item.publishedAt, item.uploader].filter(Boolean).join(' | ')
    lines.push(`${index + 1}. ${item.title}`)
    if (meta) lines.push(`   ${meta}`)
    lines.push(`   btih: ${item.btih}`)
    lines.push(`   magnet: ${item.magnet}`)
    lines.push(`   torrent: ${item.torrentUrl}`)
  })
  lines.push('')
  lines.push('提示: 用 kisssub_download 传 magnet 或 btih 即可投递到下载器；不传则只有链接。')
  return text(lines.join('\n'))
}

/** 渲染单个条目。 */
function renderItem(item) {
  return text(
    [
      item.title ?? '(无标题)',
      [item.category, item.size, item.publishedAt, item.uploader].filter(Boolean).join(' | '),
      `btih: ${item.btih}`,
      `magnet: ${item.magnet}`,
      `torrent: ${item.torrentUrl}`,
      item.detailUrl ? `detail: ${item.detailUrl}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

/** 组装"首次使用 / 配置文件"状态，并给出 agent 该做什么。 */
function buildSetup(config, ensured = {}) {
  const firstRun = !config.savePathConfirmed
  return {
    configFile: config.configFile,
    configFileCreated: ensured.created === true,
    configFileError: ensured.error ?? null,
    savePath: config.savePath,
    defaultSavePath: config.defaultSavePath,
    effectiveSavePath: config.effectiveSavePath,
    savePathConfirmed: config.savePathConfirmed,
    firstRun,
    hint: firstRun
      ? `默认下载保存目录还没有和用户确认：请先问用户「kisssub 下载的资源默认保存到哪个目录？」（不指定就用 ${config.effectiveSavePath}），拿到答复后调用 kisssub_configure（savePath=目录，会自动标记已确认）写进 ${config.configFile}。`
      : '',
  }
}

/** 渲染 setup 状态。 */
function renderSetup(setup) {
  const lines = [`配置文件: ${setup.configFile}${setup.configFileCreated ? '（本次首次创建）' : ''}`]
  if (setup.configFileError) lines.push(`配置文件错误: ${setup.configFileError}`)
  lines.push(`默认保存目录: ${setup.effectiveSavePath}${setup.savePath ? `（用户指定）` : '（内置默认）'}`)
  lines.push(`保存目录是否已与用户确认: ${setup.savePathConfirmed ? '是' : '否'}`)
  if (setup.hint) lines.push('', `⚠️ ${setup.hint}`)
  return lines
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} pluginConfig
 */
export function apply(ctx, pluginConfig = {}) {
  let cachedClient = null
  let cachedKey = ''
  /** 配置文件只创建一次；记录是否是本进程创建的，供 status 回显。 */
  let ensured = { file: null, created: false, error: null }

  /** 每次调用重新解析配置（改配置文件无需重启），客户端按关键字段复用。 */
  function runtime() {
    const config = resolveConfig(pluginConfig)
    const key = [
      config.baseUrl,
      config.cookie,
      config.timeoutMs,
      config.autoVisitorTest,
      config.trackers.join(','),
      config.downloader,
      config.aria2Rpc,
      config.qbUrl,
    ].join('\u0000')
    if (!cachedClient || key !== cachedKey) {
      cachedClient = new KisssubClient({
        baseUrl: config.baseUrl,
        cookie: config.cookie,
        autoVisitorTest: config.autoVisitorTest,
        timeoutMs: config.timeoutMs,
        trackers: config.trackers.length ? config.trackers : undefined,
      })
      cachedKey = key
    }
    // 第一次使用（或配置文件被删掉）时补建，失败不阻断工具。
    if (ensured.file !== config.configFile) {
      const result = ensureConfigFile({ file: config.configFile })
      ensured = { file: result.file, created: result.created, error: result.error }
    }
    return { config, client: cachedClient, ensured }
  }

  // 配置文件的第一次创建：插件装载即视为"第一次使用"。
  const log = loggerFor(ctx)
  try {
    const initial = resolveConfig(pluginConfig)
    const result = ensureConfigFile({ file: initial.configFile })
    ensured = { file: result.file, created: result.created, error: result.error }
    log?.info(
      `dsh-kisssub 已加载：配置文件 ${initial.configFile}${result.created ? '（本次新创建）' : ''}，` +
        `下载器 ${initial.downloader}，默认保存目录 ${initial.effectiveSavePath}，` +
        `保存目录${initial.savePathConfirmed ? '已' : '尚未'}与用户确认`,
    )
    if (result.error) log?.warn(`dsh-kisssub 配置文件创建失败: ${result.error}`)
  } catch (error) {
    /* 配置不可写不阻断插件加载，status 会回显 */
    log?.warn(`dsh-kisssub 初始化异常（不影响工具注册）: ${error?.message ?? error}`)
  }

  // 首次使用：让 agent 主动去问用户默认下载保存目录。
  // 用 inject 而不是写进 inject 数组，缺 systemPrompt 服务时插件依然可用。
  // ctx.inject 是 cordis 的 API，真实宿主里一定存在；这里防一手是为了让
  // 复用 lib/index.js 的脚本/测试在简化 ctx 下也不会整体崩掉。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'plugin:dsh-kisssub',
        order: 240,
        text: () => {
          try {
            const config = resolveConfig(pluginConfig)
            if (config.savePathConfirmed) return ''
            return [
              '[dsh-kisssub] kisssub（爱恋动漫）下载插件已就绪，但默认下载保存目录还没有和用户确认过。',
              `在你第一次真正帮用户下载之前，主动问一句「下载的资源默认保存到哪个目录？」，并说明不指定就用当前默认 ${config.effectiveSavePath}。`,
              `拿到答复后调用 kisssub_configure（savePath=用户给的目录）把它写进 ${config.configFile}；`,
              '用户回答"就用默认/随便"时，也调用一次 kisssub_configure（savePathConfirmed=true）标记为已确认，避免以后重复询问。',
            ].join('')
          } catch {
            return ''
          }
        },
      })
    })
  }

  ctx.tools.register(
    defineTool({
      name: 'kisssub_search',
      description:
        '在爱恋动漫 (kisssub.org) 按关键词搜索动画/漫画/音乐等 BT 资源，返回标题、类别、大小、发布时间、发布组、BTIH、磁力链接和种子直链。默认走站点搜索（支持翻页，自动过人机验证门），失败时自动退回免 Cookie 的 RSS 搜索（无翻页/无大小）。',
      parameters: {
        keyword: { type: 'string', required: true, description: '搜索关键词，中日文皆可，例如「葬送的芙莉莲」' },
        page: { type: 'number', description: '页码，从 1 开始（默认 1，仅站点搜索支持翻页）' },
        limit: { type: 'number', description: '最多返回多少条（默认取插件配置 defaultLimit，通常 20）' },
        source: {
          type: 'string',
          enum: ['auto', 'site', 'rss'],
          description: 'auto（默认，站点失败自动退回 RSS）/ site（只用站点搜索）/ rss（只用免 Cookie 的 RSS）',
        },
      },
      output: { schema: ITEMS_RESULT_SCHEMA, render: (_args, value) => renderItems(value) },
      async execute(args, exec) {
        const { config, client } = runtime()
        const result = await client.search(args.keyword, {
          page: args.page,
          limit: args.limit ?? config.defaultLimit,
          source: args.source ?? 'auto',
          signal: exec?.signal,
        })
        return { ...result, count: result.items.length }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kisssub_latest',
      description:
        '列出爱恋动漫 (kisssub.org) 最新发布的 BT 资源（走站点 RSS，免 Cookie、不需过人机验证）。适合「最近有什么新番资源」这类问题。',
      parameters: {
        limit: { type: 'number', description: '最多返回多少条（默认取插件配置 defaultLimit，通常 20）' },
      },
      output: { schema: ITEMS_RESULT_SCHEMA, render: (_args, value) => renderItems(value) },
      async execute(args, exec) {
        const { config, client } = runtime()
        const result = await client.latest({
          limit: args.limit ?? config.defaultLimit,
          signal: exec?.signal,
        })
        return { source: 'rss', keyword: null, page: 1, count: result.items.length, note: null, items: result.items }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kisssub_magnet',
      description:
        '把任意一种输入（磁力链接 / 40 位 BTIH 特征码 / kisssub 详情页链接 / 种子直链）解析成规范条目：补全磁力链接与种子直链，并可顺便抓详情页拿到标题、发布组、发布时间、大小。',
      parameters: {
        input: {
          type: 'string',
          required: true,
          description: 'magnet: 链接、40 位 BTIH、show-&lt;hash&gt;.html 链接或 v2.uploadbt.com 种子直链',
        },
        withDetail: { type: 'boolean', description: '是否额外抓详情页补全标题/发布组/发布时间（默认 true）' },
      },
      output: { schema: ITEM_SCHEMA, render: (_args, value) => renderItem(value) },
      async execute(args, exec) {
        const { client } = runtime()
        return client.resolve(args.input, { withDetail: args.withDetail !== false, signal: exec?.signal })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kisssub_download',
      description:
        '把一个 magnet / BTIH / 种子直链投递到已配置的无 GUI 下载器（aria2 JSON-RPC 或 qBittorrent-nox WebUI），返回是否受理以及实际保存目录。未配置下载器（downloader=none）时返回 ok=false，此时请直接使用磁力链接或种子直链。若返回的 note 提示默认保存目录尚未与用户确认，请先问用户并用 kisssub_configure 固化。',
      parameters: {
        input: { type: 'string', required: true, description: 'magnet: 链接、40 位 BTIH、详情页链接或种子直链' },
        savePath: {
          type: 'string',
          description: '保存目录，覆盖配置里的默认目录（支持 ~ 开头；aria2 用 dir，qB 用 savepath）',
        },
        category: { type: 'string', description: 'qBittorrent 分类（aria2 忽略）' },
        tags: { type: 'string', description: 'qBittorrent 标签，逗号分隔（aria2 忽略）' },
        paused: { type: 'boolean', description: '是否暂停状态加入（默认 false）' },
        preferTorrent: {
          type: 'boolean',
          description: '优先投递 .torrent 直链而不是磁力链接（默认 false，即优先 magnet）',
        },
        withDetail: {
          type: 'boolean',
          description: '是否抓一次详情页补全标题/发布组（默认 true，让回执更可读；失败不影响投递）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            downloader: { type: 'string' },
            id: nullable({ type: 'string' }),
            message: { type: 'string' },
            usedUrl: { type: 'string' },
            savePath: { type: 'string' },
            note: nullable({ type: 'string' }),
            item: ITEM_SCHEMA,
          },
        },
        render: (_args, value) =>
          text(
            [
              value.ok ? '✅ 已投递到下载器' : '❌ 未投递',
              `下载器: ${value.downloader}`,
              value.id ? `任务 id: ${value.id}` : '',
              `保存目录: ${value.savePath || '(下载器默认)'}`,
              `说明: ${value.message}`,
              `使用链接: ${value.usedUrl}`,
              `标题: ${value.item?.title ?? '(未知)'}`,
              `btih: ${value.item?.btih ?? '(未知)'}`,
              value.note ? `\n${value.note}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
      },
      async execute(args, exec) {
        const { config, client, ensured } = runtime()
        const item = await client.resolve(args.input, {
          withDetail: args.withDetail !== false,
          signal: exec?.signal,
        })
        const usedUrl = args.preferTorrent ? item.torrentUrl : item.magnet
        const result = await addDownload(config, {
          url: usedUrl,
          savePath: args.savePath,
          category: args.category,
          tags: args.tags,
          paused: args.paused,
          signal: exec?.signal,
        })
        const notes = []
        if (!config.savePathConfirmed) {
          notes.push(
            `默认下载保存目录尚未与用户确认，本次保存到 ${result.savePath}。请询问用户是否要改，并用 kisssub_configure( savePath ) 固化。`,
          )
        }
        if (ensured.error) notes.push(`配置文件不可写（${ensured.error}），当前配置只对本次会话生效。`)
        return {
          ok: result.ok,
          downloader: config.downloader,
          id: result.id ?? null,
          message: result.message,
          usedUrl,
          savePath: result.savePath ?? config.effectiveSavePath,
          note: notes.length ? notes.join(' ') : null,
          item,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kisssub_configure',
      description:
        '把设置写进 dsh-kisssub 的配置文件（默认 ~/.dsh/dsh-kisssub.json，不存在会自动创建）。首次使用时用它记录用户指定的默认下载保存目录（savePath）与下载器账号。只写传入的字段，其余保持不变。',
      parameters: {
        savePath: {
          type: 'string',
          description: '用户指定的默认下载保存目录（绝对路径或 ~ 开头）；传了就自动标记为已与用户确认',
        },
        savePathConfirmed: {
          type: 'boolean',
          description: '把"默认保存目录已与用户确认"标记为 true（用户说"就用默认/随便"时传它）',
        },
        downloader: {
          type: 'string',
          enum: ['none', 'aria2', 'qbittorrent'],
          description: '下载器类型：none 只给链接 / aria2 / qbittorrent（qbittorrent-nox 走 WebUI）',
        },
        aria2Rpc: { type: 'string', description: 'aria2 JSON-RPC 地址，如 http://127.0.0.1:6800/jsonrpc' },
        aria2Secret: { type: 'string', description: 'aria2 --rpc-secret（没设就留空）' },
        qbUrl: { type: 'string', description: 'qBittorrent WebUI 地址，如 http://127.0.0.1:8080' },
        qbUsername: { type: 'string', description: 'qBittorrent WebUI 用户名' },
        qbPassword: { type: 'string', description: 'qBittorrent WebUI 密码' },
        category: { type: 'string', description: 'qBittorrent 分类' },
        tags: { type: 'string', description: 'qBittorrent 标签，逗号分隔' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            configFile: { type: 'string' },
            written: { type: 'array', items: { type: 'string' } },
            effectiveSavePath: { type: 'string' },
            message: { type: 'string' },
            downloader: PROBE_SCHEMA,
            config: { type: 'json' },
          },
        },
        render: (_args, value) =>
          text(
            [
              value.ok ? '✅ 配置已保存' : '❌ 配置未保存',
              `配置文件: ${value.configFile}`,
              value.written.length ? `本次写入: ${value.written.join(', ')}` : '',
              `默认保存目录: ${value.effectiveSavePath || '(未设置)'}`,
              `说明: ${value.message}`,
              value.downloader.configured
                ? `下载器: ${value.downloader.kind}（${value.downloader.reachable ? '可达' : '不可达'}）— ${value.downloader.detail}`
                : '下载器: 未配置（只输出链接）',
              '生效配置:',
              JSON.stringify(value.config, null, 2),
            ]
              .filter(Boolean)
              .join('\n'),
          ),
      },
      async execute(args) {
        const { config } = runtime()
        const patch = {}
        const written = []
        const setString = (key, value) => {
          if (value === undefined || value === null) return
          patch[key] = String(value).trim()
          written.push(key)
        }

        if (args.savePath !== undefined && args.savePath !== null) {
          // 只接受绝对路径（允许 ~ 开头）：相对路径对下载器/守护进程没有意义，静默按 cwd
          // 解析会让人以为存到了别处，所以这里直接拒绝。
          const absolute = expandHome(args.savePath)
          if (!absolute || !isAbsolute(absolute)) {
            return {
              ok: false,
              configFile: config.configFile,
              written: [],
              effectiveSavePath: config.effectiveSavePath,
              message: `savePath 必须是绝对路径（或 ~ 开头），收到: ${String(args.savePath)}`,
              downloader: { configured: false, kind: config.downloader, reachable: false, detail: '未探测（参数非法）' },
              config: maskConfig(config),
            }
          }
          patch.savePath = absolute
          written.push('savePath')
          // 用户明确给了目录，就顺手标记为已确认，省一次往返。
          if (args.savePathConfirmed === undefined) {
            patch.savePathConfirmed = true
            written.push('savePathConfirmed')
          }
        }
        if (args.savePathConfirmed !== undefined && args.savePathConfirmed !== null) {
          patch.savePathConfirmed = args.savePathConfirmed === true
          written.push('savePathConfirmed')
        }
        setString('aria2Rpc', args.aria2Rpc)
        setString('aria2Secret', args.aria2Secret)
        setString('qbUrl', args.qbUrl)
        setString('qbUsername', args.qbUsername)
        setString('qbPassword', args.qbPassword)
        setString('category', args.category)
        setString('tags', args.tags)
        if (args.downloader !== undefined && args.downloader !== null) {
          const kind = String(args.downloader).trim().toLowerCase()
          if (!['none', 'aria2', 'qbittorrent'].includes(kind)) {
            return {
              ok: false,
              configFile: config.configFile,
              written: [],
              effectiveSavePath: config.effectiveSavePath,
              message: `downloader 只能是 none / aria2 / qbittorrent，收到: ${kind}`,
              downloader: { configured: false, kind: config.downloader, reachable: false, detail: '未探测（参数非法）' },
              config: maskConfig(config),
            }
          }
          patch.downloader = kind
          written.push('downloader')
        }

        if (!written.length) {
          return {
            ok: false,
            configFile: config.configFile,
            written: [],
            effectiveSavePath: config.effectiveSavePath,
            message: '没有传入任何要写入的字段。',
            downloader: { configured: false, kind: config.downloader, reachable: false, detail: '未探测' },
            config: maskConfig(config),
          }
        }

        const result = writeConfigFile(patch, { file: config.configFile })
        const next = resolveConfig(pluginConfig)
        const probe = await probeDownloader(next)
        return {
          ok: result.ok,
          configFile: result.file,
          written: result.ok ? written : [],
          effectiveSavePath: next.effectiveSavePath,
          message: result.ok ? `已把 ${written.join('、')} 写入配置文件。` : result.message,
          downloader: probe,
          config: maskConfig(next),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'kisssub_status',
      description:
        '查看 dsh-kisssub 插件的生效配置（密钥已隐去）、配置文件位置、默认下载保存目录，以及下载器连通性。用于排查「搜不到」「投递失败」。若返回的 setup.firstRun 为 true，说明默认保存目录还没和用户确认过，请先问用户再用 kisssub_configure 写入。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            configFile: { type: 'string' },
            setup: SETUP_SCHEMA,
            config: { type: 'json' },
            downloader: PROBE_SCHEMA,
          },
        },
        render: (_args, value) =>
          text(
            [
              ...renderSetup(value.setup),
              `下载器: ${value.downloader.configured ? value.downloader.kind : '未配置'}${
                value.downloader.configured ? `（${value.downloader.reachable ? '可达' : '不可达'}）` : ''
              } — ${value.downloader.detail}`,
              '生效配置:',
              JSON.stringify(value.config, null, 2),
            ].join('\n'),
          ),
      },
      async execute() {
        const { config, ensured } = runtime()
        const probe = await probeDownloader(config)
        return {
          configFile: config.configFile,
          setup: buildSetup(config, ensured),
          config: maskConfig(config),
          downloader: probe,
        }
      },
    }),
  )
}
