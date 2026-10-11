/**
 * KissSub（爱恋动漫 kisssub.org，站点自研程序 MioBT）站点客户端。
 *
 * 零依赖纯 Node（只用全局 fetch），不 import 任何 @deepseek-ai/* 包，
 * 因此可以被独立测试，也可以被任何 agent harness 复用。
 *
 * 站点现状（2026-10 实测）：
 * - `rss.xml` / `rss-<关键词>.xml`：**免 Cookie**，单页 50 条，标准 RSS 2.0，
 *   `<enclosure url="http://v2.uploadbt.com/?r=down&hash=<40位BTIH>">`。
 * - `search.php?keyword=`、首页、`show-*.html` 详情页：**有访客门**，
 *   无 Cookie 会 302 到 `/public/html/start/`。
 *   带 `visitor_test=human` Cookie 即 200；该 Cookie 可以脚本化拿到：
 *   POST `addon.php?r=document/view&page=visitor-test`，body `visitor_test=human`。
 * - 详情页的磁链是写在 HTML 注释里的，且 `down.php?date=&hash=` 有防盗链（403），
 *   所以磁链一律由 40 位 BTIH 本地合成，种子一律走 `v2.uploadbt.com`（免 Cookie 200）。
 *
 * @module dsh-kisssub/kisssub
 */

/** 站点默认地址。 */
export const DEFAULT_BASE_URL = 'https://kisssub.org'

/** 免 Cookie 的种子下载入口（站点 RSS `<enclosure>` 用的就是它）。 */
export const DEFAULT_TORRENT_ORIGIN = 'http://v2.uploadbt.com'

/**
 * 合成磁链时的默认 tracker。第一条是站点种子自带的 announce，
 * 其余是公共 tracker，用于提升连通性。
 */
export const DEFAULT_TRACKERS = [
  'http://open.acgtracker.com:1096/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker1.itzmx.com:8080/announce',
]

/** 访客门（人机验证）页面。 */
const VISITOR_PATH = 'addon.php?r=document/view&page=visitor-test'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/**
 * 站点前置的 Cloudflare 风控会**直接 404 掉缺少 `accept-language` 的请求**
 * （curl 默认不发这个头却不带 `Accept-Language` 时也会 404）。
 * 所以这两个头是必需的，不是可选的"礼貌头"。
 */
const DEFAULT_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8'

const BTIH_RE = /^[0-9a-fA-F]{40}$/

/** 判断一个字符串是否正好是 40 位 BTIH / infohash。 */
export function isBtih(value) {
  return typeof value === 'string' && BTIH_RE.test(value.trim())
}

/**
 * 从任意字符串里抽出 40 位 BTIH（magnet、`show-<hash>.html`、
 * `down.php?…hash=<hash>`、`?r=down&hash=<hash>` 都适用）。
 * @returns {string|null} 小写 BTIH，找不到返回 null
 */
export function extractBtih(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (isBtih(text)) return text.toLowerCase()
  const magnet = text.match(/xt=urn:btih:([0-9a-fA-F]{40})/i)
  if (magnet) return magnet[1].toLowerCase()
  const show = text.match(/show-([0-9a-fA-F]{40})\.html/)
  if (show) return show[1].toLowerCase()
  const query = text.match(/[?&]hash=([0-9a-fA-F]{40})/i)
  if (query) return query[1].toLowerCase()
  const loose = text.match(/\b([0-9a-fA-F]{40})\b/)
  return loose ? loose[1].toLowerCase() : null
}

/**
 * 由 BTIH 合成磁链。
 * @param {string} btih 40 位 infohash
 * @param {{trackers?: string[], name?: string}} [options]
 */
export function buildMagnet(btih, options = {}) {
  const hash = extractBtih(btih)
  if (!hash) throw new Error(`不是合法的 BTIH: ${String(btih).slice(0, 60)}`)
  const trackers = options.trackers ?? DEFAULT_TRACKERS
  const params = [`xt=urn:btih:${hash}`]
  if (options.name) params.push(`dn=${encodeURIComponent(options.name)}`)
  for (const tracker of trackers) {
    if (typeof tracker === 'string' && tracker.trim()) {
      params.push(`tr=${encodeURIComponent(tracker.trim())}`)
    }
  }
  return `magnet:?${params.join('&')}`
}

/** 免 Cookie 的 .torrent 直链。 */
export function torrentUrlFor(btih, origin = DEFAULT_TORRENT_ORIGIN) {
  const hash = extractBtih(btih)
  if (!hash) throw new Error(`不是合法的 BTIH: ${String(btih).slice(0, 60)}`)
  return `${origin.replace(/\/+$/, '')}/?r=down&hash=${hash}`
}

/** 解码 HTML 实体（含数字实体）。 */
export function decodeEntities(input) {
  if (!input) return ''
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function safeCodePoint(code) {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** 去掉标签 + 解实体 + 压空白。 */
export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 剥掉 CDATA 外壳。<b>必须先剥 CDATA 再 stripTags</b>：
 * `stripTags` 会把 `<![CDATA[动画]]>` 当成一个标签整体删掉，内容就丢了。
 */
export function unwrapCdata(html) {
  return String(html ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

/** 把站点上的 `YYYY/MM/DD` 或 `YYYY-MM-DD HH:MM:SS` 归一成 ISO 字符串。 */
export function toIso(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const m = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m
  // 站点时间按东八区标注（RSS pubDate 也带 +0800），这里保留字面时间并标 +08:00。
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+08:00`
}

function absolutize(baseUrl, href) {
  if (!href) return null
  const text = String(href).trim()
  if (/^https?:\/\//i.test(text)) return text
  return `${baseUrl.replace(/\/+$/, '')}/${text.replace(/^\/+/, '')}`
}

/**
 * 解析 `search.php` 结果表格。
 *
 * 实测结构（2026-10）：
 * ```html
 * <table id="listTable">
 *   <tr class="alt1">
 *     <td nowrap>2026/08/28</td>
 *     <td><a href="sort-1-1.html">动画</a></td>
 *     <td><a href="show-<hash>.html">标题（可能含 <span class="keyword">）</a></td>
 *     <td>48.5GB</td>
 *     <td><a href="search.php?keyword=...">发布组</a></td>
 *   </tr>
 * </table>
 * ```
 * @returns {Array<object>} 条目数组（未排序、未裁剪）
 */
export function parseSearchHtml(html, baseUrl = DEFAULT_BASE_URL) {
  const items = []
  const table = String(html ?? '').match(/<table[^>]*id="listTable"[\s\S]*?<\/table>/i)
  if (!table) return items
  const rows = table[0].match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  for (const row of rows) {
    const link = row.match(/<a[^>]+href="show-([0-9a-fA-F]{40})\.html"[^>]*>([\s\S]*?)<\/a>/i)
    if (!link) continue
    const btih = link[1].toLowerCase()
    const title = stripTags(link[2])
    if (!title) continue
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? []
    const cell = (i) => (tds[i] ? stripTags(tds[i]) : '')
    const categoryMatch = row.match(/<a[^>]+href="sort-[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const uploaderMatch = row.match(/<a[^>]+href="search\.php\?keyword=[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const size = tds.map((td) => stripTags(td)).find((t) => /^[\d.]+\s*[KMGTP]?i?B$/i.test(t)) ?? null
    items.push({
      title,
      btih,
      category: categoryMatch ? stripTags(unwrapCdata(categoryMatch[1])) : null,
      size,
      publishedAt: toIso(cell(0)),
      uploader: uploaderMatch ? stripTags(uploaderMatch[1]) : null,
      detailUrl: absolutize(baseUrl, `show-${btih}.html`),
    })
  }
  return items
}

/**
 * 解析 RSS 2.0（`rss.xml` / `rss-<关键词>.xml`）。
 * @returns {Array<object>} 条目数组
 */
export function parseRssXml(xml, baseUrl = DEFAULT_BASE_URL) {
  const items = []
  const blocks = String(xml ?? '').match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
      if (!m) return null
      return stripTags(unwrapCdata(m[1]))
    }
    const enclosure = block.match(/<enclosure[^>]*url="([^"]+)"/i)
    const btih =
      extractBtih(enclosure ? decodeEntities(enclosure[1]) : '') ??
      extractBtih(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? '')
    if (!btih) continue
    const title = pick('title')
    if (!title) continue
    const categoryMatch = block.match(/<category[^>]*>([\s\S]*?)<\/category>/i)
    items.push({
      title,
      btih,
      category: categoryMatch ? stripTags(unwrapCdata(categoryMatch[1])) : null,
      size: null,
      publishedAt: toIso(pick('pubDate')),
      uploader: pick('author'),
      detailUrl: absolutize(baseUrl, `show-${btih}.html`),
    })
  }
  return items
}

/**
 * 解析详情页（`show-<hash>.html`，需要访客 Cookie）。
 * @returns {{title: string|null, uploader: string|null, publishedAt: string|null, size: string|null, btih: string|null}}
 */
export function parseDetailHtml(html) {
  const text = String(html ?? '')
  const breadcrumb = text.match(/<div[^>]*class="[^"]*location[^"]*"[\s\S]*?<\/div>/i)
  let title = null
  if (breadcrumb) {
    const anchors = breadcrumb[0].match(/<a[^>]+href="show-[0-9a-fA-F]{40}\.html"[^>]*>([\s\S]*?)<\/a>/i)
    if (anchors) title = stripTags(anchors[1])
  }
  if (!title) {
    const docTitle = text.match(/<title>([\s\S]*?)<\/title>/i)
    if (docTitle) {
      title = stripTags(docTitle[1])
        .replace(/\s*-\s*爱恋动漫\s*[0-9a-fA-F]{40}\s*$/i, '')
        .trim()
    }
  }
  const uploader = text.match(/发布代号[:：]?\s*<a[^>]*>([\s\S]*?)<\/a>/i)
  const published = text.match(/发布时间[:：]?\s*([\d]{4}[/-][\d]{1,2}[/-][\d]{1,2}[^<]*)/i)
  const size = text.match(/大小[:：]?\s*([\d.]+\s*[KMGTP]?i?B)/i)
  const hashField = text.match(/hash_id'\]\s*=\s*"([0-9a-fA-F]{40})"/i)
  return {
    title: title || null,
    uploader: uploader ? stripTags(uploader[1]) : null,
    publishedAt: published ? toIso(published[1]) : null,
    size: size ? size[1].trim() : null,
    btih: hashField ? hashField[1].toLowerCase() : extractBtih(text),
  }
}

/**
 * 把站点条目补全成统一的规范结构（补上磁链与种子直链）。
 * @param {object} item
 * @param {{trackers?: string[]}} [options]
 */
export function normalizeItem(item, options = {}) {
  const btih = item.btih ?? extractBtih(item.detailUrl ?? item.magnet ?? '')
  if (!btih) throw new Error(`条目缺少 BTIH: ${item.title ?? ''}`)
  return {
    title: item.title ?? null,
    btih: btih.toLowerCase(),
    magnet: buildMagnet(btih, { trackers: options.trackers, name: item.title ?? undefined }),
    torrentUrl: torrentUrlFor(btih),
    detailUrl: item.detailUrl ?? null,
    category: item.category ?? null,
    size: item.size ?? null,
    publishedAt: item.publishedAt ?? null,
    uploader: item.uploader ?? null,
  }
}

/** 站点客户端。 */
export class KisssubClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] 站点地址
   * @param {string} [options.cookie] 额外的 Cookie（例如手动抓的 `visitor_test`）
   * @param {boolean} [options.autoVisitorTest] 是否自动过人机验证门（默认 true）
   * @param {number} [options.timeoutMs] 单请求超时
   * @param {string[]} [options.trackers] 合成磁链用的 tracker 列表
   * @param {string} [options.torrentOrigin] 种子直链源
   * @param {Function} [options.fetchImpl] 便于测试注入
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.trackers = Array.isArray(options.trackers) ? options.trackers : DEFAULT_TRACKERS
    this.torrentOrigin = options.torrentOrigin || DEFAULT_TORRENT_ORIGIN
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000
    this.autoVisitorTest = options.autoVisitorTest !== false
    this.userAgent = options.userAgent || DEFAULT_UA
    this.acceptLanguage = options.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE
    this.cookie = String(options.cookie ?? '').trim()
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this._gate = null
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('KisssubClient 需要可用的 fetch（Node 18+ 自带全局 fetch）')
    }
  }

  /** 当前累积的 Cookie 串。 */
  get cookieHeader() {
    return this.cookie
  }

  _absorb(response) {
    const raw =
      typeof response.headers?.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers?.get?.('set-cookie')].filter(Boolean)
    for (const line of raw) {
      const pair = String(line).split(';')[0].trim()
      if (!pair || !pair.includes('=')) continue
      const name = pair.slice(0, pair.indexOf('='))
      const existing = this.cookie
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => part.slice(0, part.indexOf('=')) !== name)
      existing.push(pair)
      this.cookie = existing.join('; ')
    }
  }

  async _raw(url, init = {}) {
    const headers = {
      'user-agent': this.userAgent,
      'accept-language': this.acceptLanguage,
      accept: '*/*',
      ...(init.headers ?? {}),
    }
    if (this.cookie) headers.cookie = this.cookie
    const response = await this.fetchImpl(url, {
      redirect: 'manual',
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    })
    this._absorb(response)
    return response
  }

  /**
   * 拿到访客门 Cookie（`visitor_test=human`）。可并发安全地重复调用。
   * @param {boolean} [force] 强制重新获取（Cookie 失效时）
   */
  async ensureVisitorCookie(force = false) {
    if (!force && /(?:^|;\s*)visitor_test=/.test(this.cookie)) return this.cookie
    if (this._gate && !force) return this._gate
    const url = `${this.baseUrl}/${VISITOR_PATH}`
    const run = (async () => {
      // 站点要求先访问一次门页，再提交表单；两步都可能下发 Cookie。
      try {
        await this._raw(url)
      } catch {
        // 门页拿不到就算了，下面的 POST 才是关键。
      }
      await this._raw(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'visitor_test=human',
      })
      if (!/(?:^|;\s*)visitor_test=/.test(this.cookie)) {
        throw new Error(
          'kisssub 访客验证失败：未能拿到 visitor_test Cookie。请稍后重试，或在配置里手动填 cookie。',
        )
      }
      return this.cookie
    })()
    this._gate = run
    try {
      return await run
    } finally {
      this._gate = null
    }
  }

  /**
   * 带访客门自动处理的 HTML 获取：遇到 302 门页就先拿 Cookie 再重试一次。
   * @param {string} url
   * @param {AbortSignal} [signal] harness 传下来的取消信号
   */
  async _getHtml(url, signal) {
    if (this.autoVisitorTest) await this.ensureVisitorCookie()
    let response = await this._raw(url, { signal })
    if (response.status >= 300 && response.status < 400) {
      if (!this.autoVisitorTest) {
        throw new Error(`需要访客验证（HTTP ${response.status} → ${response.headers.get('location') ?? '?'}）`)
      }
      await this.ensureVisitorCookie(true)
      response = await this._raw(url, { signal })
    }
    if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}: ${url}`)
    return response.text()
  }

  /**
   * 纯文本获取（RSS 用，免 Cookie）。
   * @param {string} url
   * @param {AbortSignal} [signal]
   */
  async _getText(url, signal) {
    const response = await this._raw(url, { signal })
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`请求被重定向 HTTP ${response.status}: ${url}`)
    }
    if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}: ${url}`)
    return response.text()
  }

  /**
   * 关键词搜索。默认走站点 `search.php`（含类别/大小/发布组），
   * 失败时自动退回免 Cookie 的 RSS 搜索。
   * @param {string} keyword
   * @param {{page?: number, limit?: number, source?: 'site'|'rss'|'auto', signal?: AbortSignal}} [options]
   * @returns {Promise<{source: string, keyword: string, page: number, items: object[], note: string|null}>}
   */
  async search(keyword, options = {}) {
    const page = Math.max(1, Math.trunc(options.page ?? 1) || 1)
    const limit = Math.max(1, Math.trunc(options.limit ?? 30) || 30)
    const source = options.source ?? 'auto'
    const signal = options.signal
    const query = String(keyword ?? '').trim()
    if (!query) throw new Error('搜索关键词不能为空')

    if (source === 'site' || source === 'auto') {
      try {
        const url = `${this.baseUrl}/search.php?keyword=${encodeURIComponent(query)}&page=${page}`
        const html = await this._getHtml(url, signal)
        const items = parseSearchHtml(html, this.baseUrl)
        return { source: 'site', keyword: query, page, items: this._finish(items, limit), note: null }
      } catch (error) {
        if (signal?.aborted) throw error
        if (source === 'site') throw error
        const fallback = await this.rss(query, { limit, signal })
        return {
          source: 'rss',
          keyword: query,
          page,
          items: fallback.items,
          note: `站点搜索不可用（${error.message}），已退回 RSS 搜索；RSS 不支持翻页、无大小/类别信息。`,
        }
      }
    }
    const fallback = await this.rss(query, { limit, signal })
    return { source: 'rss', keyword: query, page, items: fallback.items, note: null }
  }

  /**
   * RSS 关键词订阅（免 Cookie）。
   * @param {string} keyword
   * @param {{limit?: number, signal?: AbortSignal}} [options]
   */
  async rss(keyword, options = {}) {
    const limit = Math.max(1, Math.trunc(options.limit ?? 30) || 30)
    const query = String(keyword ?? '').trim()
    if (!query) throw new Error('RSS 关键词不能为空')
    const xml = await this._getText(`${this.baseUrl}/rss-${encodeURIComponent(query)}.xml`, options.signal)
    const items = parseRssXml(xml, this.baseUrl)
    return { source: 'rss', keyword: query, page: 1, items: this._finish(items, limit), note: null }
  }

  /**
   * 全站最新发布（免 Cookie）。
   * @param {{limit?: number, signal?: AbortSignal}} [options]
   */
  async latest(options = {}) {
    const limit = Math.max(1, Math.trunc(options.limit ?? 20) || 20)
    const xml = await this._getText(`${this.baseUrl}/rss.xml`, options.signal)
    const items = parseRssXml(xml, this.baseUrl)
    return { items: this._finish(items, limit) }
  }

  /**
   * 详情页（需要访客 Cookie）。失败时返回 null，调用方仍可用 BTIH 合成磁链。
   * @param {string} btihOrUrl
   * @param {{signal?: AbortSignal}} [options]
   */
  async detail(btihOrUrl, options = {}) {
    const btih = extractBtih(btihOrUrl)
    if (!btih) throw new Error(`无法从输入解析出 BTIH: ${String(btihOrUrl).slice(0, 80)}`)
    try {
      const html = await this._getHtml(`${this.baseUrl}/show-${btih}.html`, options.signal)
      return parseDetailHtml(html)
    } catch {
      return null
    }
  }

  /**
   * 把 magnet / BTIH / 详情页链接 / 种子直链 统一解析成规范条目。
   * @param {string} input
   * @param {{withDetail?: boolean, title?: string, signal?: AbortSignal}} [options]
   */
  async resolve(input, options = {}) {
    const btih = extractBtih(input)
    if (!btih) {
      throw new Error(`无法识别: ${String(input).slice(0, 120)}（支持 magnet / 40 位 BTIH / show-*.html / 种子直链）`)
    }
    let detail = null
    if (options.withDetail) detail = await this.detail(btih, { signal: options.signal })
    return {
      title: options.title ?? detail?.title ?? null,
      btih,
      magnet: buildMagnet(btih, { trackers: this.trackers, name: options.title ?? detail?.title ?? undefined }),
      torrentUrl: torrentUrlFor(btih, this.torrentOrigin),
      detailUrl: `${this.baseUrl}/show-${btih}.html`,
      category: null,
      size: detail?.size ?? null,
      publishedAt: detail?.publishedAt ?? null,
      uploader: detail?.uploader ?? null,
    }
  }

  _finish(items, limit) {
    return items.slice(0, limit).map((item) => normalizeItem(item, { trackers: this.trackers }))
  }
}
