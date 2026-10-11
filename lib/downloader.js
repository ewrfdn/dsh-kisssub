/**
 * 无 GUI 下载器适配层：aria2 JSON-RPC 与 qBittorrent（含 qbittorrent-nox）WebUI API。
 *
 * 零依赖纯 Node，只用全局 fetch / FormData。
 * 两个后端都只做"投递任务 + 连通性探测"，不负责下载完成后的整理。
 *
 * @module dsh-kisssub/downloader
 */

import { resolveSavePath } from './config.js'

const DEFAULT_TIMEOUT = 15_000

function withTimeout(timeoutMs, signal) {
  if (signal) return signal
  return AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT)
}

/**
 * 调一次 aria2 JSON-RPC。
 * @param {object} options
 * @param {string} options.rpc JSON-RPC 地址，如 http://127.0.0.1:6800/jsonrpc
 * @param {string} [options.secret] RPC secret（可空）
 * @param {string} options.method 例如 'aria2.addUri'
 * @param {any[]} [options.params] 方法参数（secret 会自动前置）
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{ok: boolean, result?: any, error?: string}>}
 */
export async function aria2Call(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const params = [...(options.params ?? [])]
  if (options.secret) params.unshift(`token:${options.secret}`)
  let response
  try {
    response = await fetchImpl(options.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'dsh-kisssub', method: options.method, params }),
      signal: withTimeout(options.timeoutMs, options.signal),
    })
  } catch (error) {
    return { ok: false, error: `aria2 RPC 连接失败: ${error?.message ?? error}` }
  }
  if (!response.ok) {
    // aria2 在 secret 不对时返回 HTTP 400 + JSON-RPC error 体，把原因捞出来。
    const raw = await response.text().catch(() => '')
    let detail = ''
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.error?.message) detail = `: ${parsed.error.message}`
    } catch {
      detail = raw ? `: ${raw.slice(0, 120)}` : ''
    }
    const hint = /Unauthorized/i.test(detail) && options.secret ? '（rpc-secret 不对）' : ''
    return { ok: false, error: `aria2 RPC HTTP ${response.status}${detail}${hint}` }
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { ok: false, error: `aria2 RPC 响应不是 JSON: ${error?.message ?? error}` }
  }
  if (payload?.error) {
    return { ok: false, error: `aria2 错误 ${payload.error.code}: ${payload.error.message}` }
  }
  return { ok: true, result: payload?.result }
}

/**
 * 往 aria2 投递一个 magnet / .torrent 直链。
 * @param {object} options
 * @param {string} options.url magnet 或 http(s) 种子直链
 * @param {string} [options.rpc]
 * @param {string} [options.secret]
 * @param {string} [options.dir] 保存目录
 * @param {boolean} [options.paused] 是否暂停加入
 */
export async function aria2Add(options) {
  const ariaOptions = {}
  if (options.dir) ariaOptions.dir = options.dir
  if (options.paused) ariaOptions.pause = 'true'
  const call = await aria2Call({
    rpc: options.rpc,
    secret: options.secret,
    method: 'aria2.addUri',
    params: [[options.url], ariaOptions],
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })
  if (!call.ok) return { ok: false, id: null, message: call.error }
  return { ok: true, id: String(call.result), message: `aria2 已受理（gid=${call.result}）` }
}

/** aria2 连通性 / 版本探测。 */
export async function aria2Version(options) {
  const call = await aria2Call({
    rpc: options.rpc,
    secret: options.secret,
    method: 'aria2.getVersion',
    params: [],
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  })
  if (!call.ok) return { ok: false, detail: call.error }
  return { ok: true, detail: `aria2 ${call.result?.version ?? '?'}` }
}

function qbHeaders(baseUrl, extra = {}) {
  // qBittorrent 对 POST 做 Origin/Referer 校验，缺了会 403。
  return { referer: `${baseUrl}/`, origin: baseUrl, ...extra }
}

/**
 * 登录 qBittorrent WebUI，拿 SID Cookie。
 * @returns {Promise<{ok: boolean, cookie?: string, message: string}>}
 */
export async function qbLogin(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
  const body = new URLSearchParams({
    username: options.username ?? '',
    password: options.password ?? '',
  })
  let response
  try {
    response = await fetchImpl(`${baseUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: qbHeaders(baseUrl, { 'content-type': 'application/x-www-form-urlencoded' }),
      body,
      signal: withTimeout(options.timeoutMs, options.signal),
    })
  } catch (error) {
    return { ok: false, message: `qBittorrent 连接失败: ${error?.message ?? error}` }
  }
  const text = (await response.text().catch(() => '')).trim()
  if (!response.ok) return { ok: false, message: `qBittorrent 登录 HTTP ${response.status}` }
  if (text !== 'Ok.') return { ok: false, message: `qBittorrent 登录被拒（${text || '空响应'}），检查用户名/密码` }
  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
  const sid = setCookie.map((line) => String(line).split(';')[0].trim()).find((pair) => pair.startsWith('SID='))
  if (!sid) return { ok: false, message: 'qBittorrent 登录返回 Ok 但没有 SID Cookie' }
  return { ok: true, cookie: sid, message: 'qBittorrent 登录成功' }
}

/** 探测 qBittorrent 版本（同时验证登录）。 */
export async function qbVersion(options) {
  const login = await qbLogin(options)
  if (!login.ok) return { ok: false, detail: login.message }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
  try {
    const response = await fetchImpl(`${baseUrl}/api/v2/app/version`, {
      headers: qbHeaders(baseUrl, { cookie: login.cookie }),
      signal: withTimeout(options.timeoutMs, options.signal),
    })
    if (!response.ok) return { ok: false, detail: `qBittorrent app/version HTTP ${response.status}` }
    const version = (await response.text()).trim()
    return { ok: true, detail: `qBittorrent ${version || '?'}`, cookie: login.cookie }
  } catch (error) {
    return { ok: false, detail: `qBittorrent 探测失败: ${error?.message ?? error}` }
  }
}

/**
 * 往 qBittorrent 投递一个 magnet / .torrent 直链。
 * @param {object} options
 * @param {string} options.url
 * @param {string} options.baseUrl
 * @param {string} [options.savePath]
 * @param {string} [options.category]
 * @param {string} [options.tags]
 * @param {boolean} [options.paused]
 */
export async function qbAdd(options) {
  const login = await qbLogin(options)
  if (!login.ok) return { ok: false, message: login.message }
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '')
  const form = new FormData()
  form.set('urls', options.url)
  if (options.savePath) form.set('savepath', options.savePath)
  if (options.category) form.set('category', options.category)
  if (options.tags) form.set('tags', options.tags)
  form.set('paused', options.paused ? 'true' : 'false')
  try {
    const response = await fetchImpl(`${baseUrl}/api/v2/torrents/add`, {
      method: 'POST',
      headers: qbHeaders(baseUrl, { cookie: login.cookie }),
      body: form,
      signal: withTimeout(options.timeoutMs, options.signal),
    })
    if (!response.ok) return { ok: false, message: `qBittorrent torrents/add HTTP ${response.status}` }
    const text = (await response.text().catch(() => '')).trim()
    if (text && text !== 'Ok.') return { ok: false, message: `qBittorrent 拒绝任务: ${text}` }
    return { ok: true, id: null, message: `qBittorrent 已受理${options.category ? `（分类 ${options.category}）` : ''}` }
  } catch (error) {
    return { ok: false, message: `qBittorrent 投递失败: ${error?.message ?? error}` }
  }
}

/**
 * 按配置探测下载器可用性。
 * @param {object} config 归一化后的插件配置
 * @returns {Promise<{configured: boolean, kind: string, reachable: boolean, detail: string}>}
 */
export async function probeDownloader(config) {
  const kind = config.downloader ?? 'none'
  if (kind === 'none') {
    return {
      configured: false,
      kind,
      reachable: false,
      detail: '未配置下载器（downloader=none）：工具只返回磁链与种子直链。',
    }
  }
  if (kind === 'aria2') {
    const probe = await aria2Version({
      rpc: config.aria2Rpc,
      secret: config.aria2Secret,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    })
    return { configured: true, kind, reachable: probe.ok, detail: probe.detail }
  }
  if (kind === 'qbittorrent') {
    const probe = await qbVersion({
      baseUrl: config.qbUrl,
      username: config.qbUsername,
      password: config.qbPassword,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl,
    })
    return { configured: true, kind, reachable: probe.ok, detail: probe.detail }
  }
  return { configured: true, kind, reachable: false, detail: `未知下载器类型: ${kind}` }
}

/**
 * 统一投递入口。
 * @param {object} config 归一化后的插件配置
 * @param {{url: string, savePath?: string, category?: string, tags?: string, paused?: boolean}} task
 */
export async function addDownload(config, task) {
  const kind = config.downloader ?? 'none'
  // 工具入参 > 用户配置 savePath > defaultSavePath（用户没指定目录就落到默认目录）。
  const savePath = resolveSavePath(config, task.savePath)
  const category = task.category || config.category || ''
  const tags = task.tags || config.tags || ''
  if (kind === 'none') {
    return { ok: false, id: null, savePath, message: '未配置下载器（downloader=none），只返回链接。' }
  }
  if (kind === 'aria2') {
    return {
      savePath,
      ...(await aria2Add({
        url: task.url,
        rpc: config.aria2Rpc,
        secret: config.aria2Secret,
        dir: savePath || undefined,
        paused: task.paused,
        timeoutMs: config.timeoutMs,
        fetchImpl: config.fetchImpl,
      })),
    }
  }
  if (kind === 'qbittorrent') {
    return {
      savePath,
      ...(await qbAdd({
        url: task.url,
        baseUrl: config.qbUrl,
        username: config.qbUsername,
        password: config.qbPassword,
        savePath: savePath || undefined,
        category: category || undefined,
        tags: tags || undefined,
        paused: task.paused,
        timeoutMs: config.timeoutMs,
        fetchImpl: config.fetchImpl,
      })),
    }
  }
  return { ok: false, id: null, savePath, message: `未知下载器类型: ${kind}` }
}
