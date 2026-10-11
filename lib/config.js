/**
 * 插件配置归一化 + 配置文件生命周期。
 *
 * 取值优先级（后者覆盖前者）：
 *   1. 内置默认值
 *   2. 插件 config（profile 的 cordis.patch.yml 里那一行）
 *   3. 用户配置文件（默认 `~/.dsh/dsh-kisssub.json`，可用 `configFile` 改）
 *   4. 环境变量 `KISSSUB_*`
 *
 * 这样密码/密钥可以只放在文件或环境变量里，不必写进 profile 配置。
 *
 * 配置文件在**第一次使用**（插件装载或第一次调用工具）时自动创建，
 * 用最小字段集，避免用一堆默认值把别的层遮住。
 *
 * @module dsh-kisssub/config
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_BASE_URL, DEFAULT_TRACKERS } from './kisssub.js'

/** 用户配置文件默认路径。 */
export const CONFIG_FILE = join(homedir(), '.dsh', 'dsh-kisssub.json')

/** 用户没指定下载目录时落到这里。 */
export const DEFAULT_SAVE_PATH = join(homedir(), 'Downloads', 'kisssub')

/** 内置默认值。 */
export const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  cookie: '',
  autoVisitorTest: true,
  timeoutMs: 15_000,
  trackers: DEFAULT_TRACKERS,
  downloader: 'none',
  aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
  aria2Secret: '',
  qbUrl: 'http://127.0.0.1:8080',
  qbUsername: 'admin',
  qbPassword: '',
  savePath: '',
  defaultSavePath: DEFAULT_SAVE_PATH,
  savePathConfirmed: false,
  category: 'kisssub',
  tags: 'kisssub',
  defaultLimit: 20,
  configFile: CONFIG_FILE,
}

/** 展开开头的 `~`（agent 经常直接传 `~/Downloads/xxx`）。 */
export function expandHome(input, home = homedir()) {
  const text = String(input ?? '').trim()
  if (!text) return ''
  if (text === '~') return home
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(home, text.slice(2))
  return text
}

/** 相对路径按 cwd 归一成绝对路径；空值原样返回。 */
export function toAbsolute(input) {
  const text = expandHome(input)
  if (!text) return ''
  return isAbsolute(text) ? text : resolve(text)
}

/**
 * 本次下载实际会用的保存目录。
 * 优先级：工具入参 > 用户配置的 savePath > defaultSavePath。
 */
export function resolveSavePath(config, override) {
  const chosen = String(override ?? '').trim() || String(config?.savePath ?? '').trim()
  const fallback = String(config?.defaultSavePath ?? '').trim() || DEFAULT_SAVE_PATH
  return toAbsolute(chosen || fallback)
}

/** 读取用户配置文件；不存在或损坏时返回空对象。 */
export function readConfigFile(file = CONFIG_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 第一次使用时创建配置文件。已存在则原样保留。
 *
 * 只写最小字段集（保存目录 + 确认标记）：写全量默认值会把这些值变成
 * "文件层"配置，反而把 profile 插件 config 和内置默认值遮住。
 *
 * @param {{file?: string, now?: () => Date, savePath?: string}} [options]
 * @returns {{file: string, created: boolean, existed: boolean, error: string|null}}
 */
export function ensureConfigFile(options = {}) {
  const file = toAbsolute(options.file || CONFIG_FILE)
  const existed = existsSync(file)
  if (existed) return { file, created: false, existed: true, error: null }
  const template = {
    _comment:
      'dsh-kisssub 配置。优先级：环境变量 KISSSUB_* > 本文件 > profile 插件 config > 内置默认值。密码只放在这里。',
    _createdAt: (options.now?.() ?? new Date()).toISOString(),
    savePath: toAbsolute(options.savePath || ''),
    defaultSavePath: DEFAULT_SAVE_PATH,
    savePathConfirmed: false,
  }
  const written = writeConfigFile(template, { file })
  return { file, created: written.ok, existed: false, error: written.ok ? null : written.message }
}

/**
 * 合并写入配置文件（保留已有键）。父目录不存在会自动创建。
 *
 * @param {object} patch 要写入的字段
 * @param {{file?: string}} [options]
 * @returns {{ok: boolean, file: string, message: string, config: object}}
 */
export function writeConfigFile(patch, options = {}) {
  const file = toAbsolute(options.file || CONFIG_FILE)
  const current = readConfigFile(file)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined || value === null) continue
    next[key] = value
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return { ok: true, file, message: `已写入 ${file}`, config: next }
  } catch (error) {
    return { ok: false, file, message: `写入配置失败: ${error.message}`, config: current }
  }
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return undefined
}

function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return undefined
}

/** 把 `KISSSUB_*` 环境变量映射成配置片段。 */
export function fromEnv(env = process.env) {
  const map = {
    baseUrl: env.KISSSUB_BASE_URL,
    cookie: env.KISSSUB_COOKIE,
    autoVisitorTest: parseBoolean(env.KISSSUB_AUTO_VISITOR_TEST),
    timeoutMs: env.KISSSUB_TIMEOUT_MS !== undefined ? Number(env.KISSSUB_TIMEOUT_MS) : undefined,
    trackers: parseList(env.KISSSUB_TRACKERS),
    downloader: env.KISSSUB_DOWNLOADER,
    aria2Rpc: env.KISSSUB_ARIA2_RPC,
    aria2Secret: env.KISSSUB_ARIA2_SECRET,
    qbUrl: env.KISSSUB_QB_URL,
    qbUsername: env.KISSSUB_QB_USERNAME,
    qbPassword: env.KISSSUB_QB_PASSWORD,
    savePath: env.KISSSUB_SAVE_PATH,
    defaultSavePath: env.KISSSUB_DEFAULT_SAVE_PATH,
    savePathConfirmed: parseBoolean(env.KISSSUB_SAVE_PATH_CONFIRMED),
    category: env.KISSSUB_CATEGORY,
    tags: env.KISSSUB_TAGS,
    defaultLimit: env.KISSSUB_DEFAULT_LIMIT !== undefined ? Number(env.KISSSUB_DEFAULT_LIMIT) : undefined,
    configFile: env.KISSSUB_CONFIG_FILE,
  }
  const out = {}
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    out[key] = value
  }
  return out
}

/** 丢掉 undefined，以及插件 config 层里等价于"没填"的空串。 */
function compact(source, dropEmptyStrings) {
  const out = {}
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || value === null) continue
    // `_comment` / `_createdAt` 这类文档键不参与合并。
    if (key.startsWith('_')) continue
    if (dropEmptyStrings && typeof value === 'string' && value.trim() === '') continue
    out[key] = value
  }
  return out
}

function normalizeDownloader(value) {
  const text = String(value ?? 'none').trim().toLowerCase()
  if (['qb', 'qbittorrent', 'qbittorrent-nox', 'qb-nox'].includes(text)) return 'qbittorrent'
  if (text === 'aria2') return 'aria2'
  if (['none', '', 'off', 'disabled', 'no'].includes(text)) return 'none'
  return text
}

/**
 * 合并并归一化配置。
 * @param {object} [pluginConfig] 插件 config（来自 profile patch）
 * @param {{env?: object, file?: string, fetchImpl?: Function}} [options]
 */
export function resolveConfig(pluginConfig = {}, options = {}) {
  const envConfig = fromEnv(options.env ?? process.env)
  const pluginLayer = compact(pluginConfig, true)
  // 配置文件路径本身只能来自 env / 插件 config / 默认值（不能来自它自己的内容）。
  const file = toAbsolute(options.file || envConfig.configFile || pluginLayer.configFile || CONFIG_FILE)
  const fileConfig = readConfigFile(file)
  const merged = {
    ...DEFAULTS,
    ...pluginLayer,
    ...compact(fileConfig, false),
    ...compact(envConfig, false),
  }

  const trackers = parseList(merged.trackers) ?? DEFAULT_TRACKERS
  const timeoutMs = Number(merged.timeoutMs)
  const defaultLimit = Number(merged.defaultLimit)

  const config = {
    baseUrl: String(merged.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    cookie: String(merged.cookie ?? '').trim(),
    autoVisitorTest: merged.autoVisitorTest !== false,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.timeoutMs,
    trackers: trackers.length ? trackers : [],
    downloader: normalizeDownloader(merged.downloader),
    aria2Rpc: String(merged.aria2Rpc || DEFAULTS.aria2Rpc),
    aria2Secret: String(merged.aria2Secret ?? ''),
    qbUrl: String(merged.qbUrl || DEFAULTS.qbUrl).replace(/\/+$/, ''),
    qbUsername: String(merged.qbUsername ?? ''),
    qbPassword: String(merged.qbPassword ?? ''),
    savePath: toAbsolute(merged.savePath ?? ''),
    defaultSavePath: toAbsolute(merged.defaultSavePath || DEFAULT_SAVE_PATH),
    savePathConfirmed: merged.savePathConfirmed === true,
    category: String(merged.category ?? ''),
    tags: String(merged.tags ?? ''),
    defaultLimit: Number.isFinite(defaultLimit) && defaultLimit > 0 ? Math.trunc(defaultLimit) : DEFAULTS.defaultLimit,
    configFile: file,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }
  config.effectiveSavePath = resolveSavePath(config)
  return config
}

/** 供工具回显配置用：隐去密码类字段。 */
export function maskConfig(config) {
  const mask = (value) => (value ? '***' : '(未设置)')
  return {
    baseUrl: config.baseUrl,
    cookie: mask(config.cookie),
    autoVisitorTest: config.autoVisitorTest,
    timeoutMs: config.timeoutMs,
    trackers: config.trackers.length,
    downloader: config.downloader,
    aria2Rpc: config.aria2Rpc,
    aria2Secret: mask(config.aria2Secret),
    qbUrl: config.qbUrl,
    qbUsername: config.qbUsername || '(未设置)',
    qbPassword: mask(config.qbPassword),
    savePath: config.savePath || '(未指定，用默认目录)',
    defaultSavePath: config.defaultSavePath,
    effectiveSavePath: config.effectiveSavePath,
    savePathConfirmed: config.savePathConfirmed,
    category: config.category || '(无)',
    tags: config.tags || '(无)',
  }
}
