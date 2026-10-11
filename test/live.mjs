#!/usr/bin/env node
/**
 * 真实站点冒烟测试（只读：搜索 / RSS / 详情，不投递下载）。
 *
 *   node test/live.mjs
 *
 * 需要外网。退出码非 0 表示有断言失败。
 */

import { KisssubClient, buildMagnet, extractBtih, parseRssXml, parseSearchHtml } from '../lib/kisssub.js'

let passed = 0
let failed = 0

function ok(label, detail = '') {
  passed += 1
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

function bad(label, error) {
  failed += 1
  console.log(`  ✗ ${label} — ${error?.message ?? error}`)
}

async function step(label, fn) {
  try {
    const detail = await fn()
    ok(label, detail)
  } catch (error) {
    bad(label, error)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const HASH = 'f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19'
const client = new KisssubClient({ timeoutMs: 25_000 })

console.log('== 纯函数（离线） ==')
await step('extractBtih 支持 magnet / 详情页 / hash 查询串', () => {
  assert(extractBtih(`magnet:?xt=urn:btih:${HASH}`) === HASH, 'magnet 解析失败')
  assert(extractBtih(`https://kisssub.org/show-${HASH}.html`) === HASH, 'show 链接解析失败')
  assert(extractBtih(`http://v2.uploadbt.com/?r=down&hash=${HASH}`) === HASH, '种子直链解析失败')
  assert(extractBtih(HASH.toUpperCase()) === HASH, '大写 hash 归一失败')
  assert(extractBtih('not-a-hash') === null, '非法输入应返回 null')
  return '4 种输入形态'
})

await step('buildMagnet 合成磁链', () => {
  const magnet = buildMagnet(HASH, { trackers: ['http://open.acgtracker.com:1096/announce'] })
  assert(magnet.startsWith(`magnet:?xt=urn:btih:${HASH}`), 'btih 缺失')
  assert(magnet.includes('tr='), 'tracker 缺失')
  return magnet.slice(0, 72) + '…'
})

await step('parseRssXml 能解析真实 RSS 结构', () => {
  const xml = `<rss><channel><item>
    <title><![CDATA[测试 & 标题]]></title>
    <link>http://kisssub.org/show-${HASH}.html</link>
    <author><![CDATA[字幕组]]></author>
    <enclosure url="http://v2.uploadbt.com/?r=down&amp;hash=${HASH}" type="application/x-bittorrent" />
    <pubDate>Sun, 11 Oct 2026 21:20:03 +0800</pubDate>
    <category domain="http://kisssub.org/sort-1-1.html"><![CDATA[动画]]></category>
  </item></channel></rss>`
  const items = parseRssXml(xml)
  assert(items.length === 1, `期望 1 条，得到 ${items.length}`)
  assert(items[0].btih === HASH, 'btih 解析失败')
  assert(items[0].category === '动画', 'category 解析失败')
  assert(items[0].uploader === '字幕组', 'author 解析失败')
  // RSS 的 pubDate 带时区（+0800），所以归一成 UTC 是正确行为。
  assert(
    new Date(items[0].publishedAt).toISOString() === '2026-10-11T13:20:03.000Z',
    `pubDate 解析失败: ${items[0].publishedAt}`,
  )
  return items[0].title
})

await step('parseSearchHtml 能解析真实表格结构', () => {
  const html = `<table id="listTable"><tr><th>发表时间</th></tr><tr class="alt1">
    <td nowrap="nowrap"> 2026/08/28 </td>
    <td><a href="sort-1-1.html">动画</a></td>
    <td style="text-align:left;"><a href="show-${HASH}.html"> [组] <span class="keyword">标题</span> 1080p</a></td>
    <td>48.5GB</td>
    <td><a href="search.php?keyword=x">发布组</a></td>
  </tr></table>`
  const items = parseSearchHtml(html)
  assert(items.length === 1, `期望 1 条，得到 ${items.length}`)
  assert(items[0].title === '[组] 标题 1080p', `标题解析失败: ${items[0].title}`)
  assert(items[0].size === '48.5GB', `大小解析失败: ${items[0].size}`)
  assert(String(items[0].publishedAt).startsWith('2026-08-28'), '日期解析失败')
  return `${items[0].title} | ${items[0].size}`
})

console.log('\n== 真实站点 ==')
await step('kisssub_latest：RSS 最新发布（免 Cookie）', async () => {
  const result = await client.latest({ limit: 5 })
  assert(result.items.length > 0, '没有拿到任何条目')
  for (const item of result.items) {
    assert(/^[0-9a-f]{40}$/.test(item.btih), `btih 非法: ${item.btih}`)
    assert(item.magnet.startsWith('magnet:?xt=urn:btih:'), 'magnet 非法')
    assert(item.torrentUrl.includes(item.btih), 'torrentUrl 与 btih 不一致')
    assert(item.title && item.title.length > 3, '标题缺失')
  }
  console.log(`      首条: ${result.items[0].title.slice(0, 70)}`)
  return `${result.items.length} 条`
})

await step('kisssub_search：站点搜索（自动过访客门）', async () => {
  const result = await client.search('葬送的芙莉莲', { limit: 5, source: 'site' })
  assert(result.source === 'site', `期望走站点搜索，实际 ${result.source}（note: ${result.note ?? '-'}）`)
  assert(result.items.length > 0, '没有拿到任何条目')
  const first = result.items[0]
  assert(first.title, '标题缺失')
  assert(/^[0-9a-f]{40}$/.test(first.btih), `btih 非法: ${first.btih}`)
  console.log(`      首条: [${first.category ?? '?'}] ${first.title.slice(0, 60)} (${first.size ?? '?'})`)
  return `${result.items.length} 条，含类别/大小`
})

await step('kisssub_search：RSS 通道（免 Cookie）', async () => {
  const result = await client.search('葬送的芙莉莲', { limit: 3, source: 'rss' })
  assert(result.source === 'rss', 'source 应为 rss')
  assert(result.items.length > 0, '没有拿到任何条目')
  return `${result.items.length} 条`
})

await step('kisssub_magnet：解析 hash 并抓详情页', async () => {
  const item = await client.resolve(HASH, { withDetail: true })
  assert(item.btih === HASH, 'btih 不一致')
  assert(item.magnet.includes(HASH), 'magnet 不含 hash')
  assert(item.torrentUrl.includes(HASH), 'torrentUrl 不含 hash')
  console.log(`      标题: ${item.title ?? '(详情页未取到)'}`)
  console.log(`      发布组: ${item.uploader ?? '?'} | 发布时间: ${item.publishedAt ?? '?'} | 大小: ${item.size ?? '?'}`)
  return item.title ? '详情页 OK' : '详情页不可用（仍可合成磁链）'
})

await step('种子直链可下载（免 Cookie）', async () => {
  const item = await client.resolve(HASH)
  const response = await fetch(item.torrentUrl, { method: 'GET' })
  assert(response.ok, `HTTP ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  const body = Buffer.from(await response.arrayBuffer())
  assert(type.includes('bittorrent'), `content-type 异常: ${type}`)
  assert(body.length > 1000, `种子文件太小: ${body.length}`)
  assert(body.subarray(0, 1).toString() === 'd', `不是 bencode: ${body.subarray(0, 8).toString('hex')}`)
  return `${type}，${body.length} 字节`
})

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
