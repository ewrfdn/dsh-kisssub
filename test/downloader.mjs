#!/usr/bin/env node
/**
 * 下载器投递路径测试。
 *
 *   node test/downloader.mjs
 *
 * 1. aria2：如果本机有 `aria2c`，就真的起一个 RPC-only 实例，
 *    真投递 magnet 与 .torrent 直链，再用 aria2.tellStatus 回查。
 * 2. qBittorrent：本机没有 qbittorrent-nox 时，用本地 mock WebUI 校验
 *    登录、SID Cookie、Referer/Origin、multipart 字段这些协议细节。
 * 3. 最后走一遍完整工具链：apply(下载器配置) → kisssub_download → 真实 aria2。
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addDownload, aria2Call, probeDownloader, qbAdd, qbVersion } from '../lib/downloader.js'

let passed = 0
let failed = 0
const ok = (label, detail = '') => {
  passed += 1
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}
const bad = (label, error) => {
  failed += 1
  console.log(`  ✗ ${label} — ${error?.message ?? error}`)
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
async function step(label, fn) {
  try {
    ok(label, await fn())
  } catch (error) {
    bad(label, error)
  }
}

const HASH = 'f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19'
const MAGNET = `magnet:?xt=urn:btih:${HASH}&tr=http%3A%2F%2Fopen.acgtracker.com%3A1096%2Fannounce`
const TORRENT_URL = `http://v2.uploadbt.com/?r=down&hash=${HASH}`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- aria2

const ARIA_PORT = 6899
const ARIA_SECRET = 'dsh-kisssub-test'
let aria = null
let ariaDir = null

async function which(binary) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${binary}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('close', (code) => resolve(code === 0 ? out.trim() : null))
  })
}

async function startAria() {
  if (!(await which('aria2c'))) return null
  ariaDir = mkdtempSync(join(tmpdir(), 'dsh-kisssub-aria2-'))
  aria = spawn(
    'aria2c',
    [
      '--enable-rpc',
      `--rpc-listen-port=${ARIA_PORT}`,
      '--rpc-listen-all=false',
      `--rpc-secret=${ARIA_SECRET}`,
      `--dir=${ariaDir}`,
      '--no-conf',
      '--quiet=true',
      '--enable-dht=false',
      '--enable-dht6=false',
      '--bt-enable-lpd=false',
      '--seed-time=0',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  aria.stderr.on('data', (chunk) => (stderr += chunk))
  const rpc = `http://127.0.0.1:${ARIA_PORT}/jsonrpc`
  for (let i = 0; i < 40; i += 1) {
    const probe = await aria2Call({ rpc, secret: ARIA_SECRET, method: 'aria2.getVersion', params: [] })
    if (probe.ok) return { rpc, version: probe.result?.version }
    await sleep(250)
  }
  throw new Error(`aria2c 未能在 10s 内就绪；stderr: ${stderr.slice(0, 300)}`)
}

function stopAria() {
  if (aria && !aria.killed) aria.kill('SIGTERM')
  if (ariaDir) {
    try {
      rmSync(ariaDir, { recursive: true, force: true })
    } catch {
      /* 清理失败无所谓 */
    }
  }
}

console.log('== aria2（真实实例） ==')
let ariaInfo = null
try {
  ariaInfo = await startAria()
  if (!ariaInfo) {
    console.log('  - 本机没有 aria2c，跳过真实 aria2 测试')
  } else {
    ok('aria2c RPC 已就绪', `v${ariaInfo.version} @ ${ariaInfo.rpc}`)
    const config = {
      downloader: 'aria2',
      aria2Rpc: ariaInfo.rpc,
      aria2Secret: ARIA_SECRET,
      savePath: '',
      category: '',
      tags: '',
      timeoutMs: 15_000,
    }

    await step('probeDownloader 报告可达', async () => {
      const probe = await probeDownloader(config)
      assert(probe.configured && probe.reachable, `不可达: ${probe.detail}`)
      return probe.detail
    })

    await step('投递 magnet 得到 gid', async () => {
      const result = await addDownload(config, { url: MAGNET })
      assert(result.ok, `投递失败: ${result.message}`)
      assert(result.id && result.id.length >= 8, `gid 异常: ${result.id}`)
      // 回查确认任务真的在 aria2 里
      const status = await aria2Call({
        rpc: ariaInfo.rpc,
        secret: ARIA_SECRET,
        method: 'aria2.tellStatus',
        params: [result.id],
      })
      assert(status.ok, `tellStatus 失败: ${status.error}`)
      assert(status.result?.infoHash?.toLowerCase() === HASH, `infoHash 不一致: ${status.result?.infoHash}`)
      return `gid=${result.id} status=${status.result.status}`
    })

    await step('投递 .torrent 直链（带保存目录）', async () => {
      const result = await addDownload(config, { url: TORRENT_URL, savePath: ariaDir })
      assert(result.ok, `投递失败: ${result.message}`)
      const status = await aria2Call({
        rpc: ariaInfo.rpc,
        secret: ARIA_SECRET,
        method: 'aria2.tellStatus',
        params: [result.id],
      })
      assert(status.ok, `tellStatus 失败: ${status.error}`)
      return `gid=${result.id} dir=${status.result?.dir}`
    })

    await step('错误 secret 会明确报错而不是静默成功', async () => {
      const result = await addDownload({ ...config, aria2Secret: 'wrong-secret' }, { url: MAGNET })
      assert(!result.ok, '错误 secret 竟然投递成功')
      assert(/Unauthorized/i.test(result.message), `没捞到 aria2 的 Unauthorized: ${result.message}`)
      assert(/rpc-secret/.test(result.message), `没给出排查提示: ${result.message}`)
      return result.message.slice(0, 80)
    })

    await step('downloader=none 时只返回链接不报错', async () => {
      const result = await addDownload({ ...config, downloader: 'none' }, { url: MAGNET })
      assert(!result.ok, 'none 不该受理')
      return result.message
    })
  }
} catch (error) {
  bad('aria2 真实实例测试', error)
}

// ------------------------------------------------------- 完整工具链（真实 aria2）

if (ariaInfo) {
  console.log('\n== 完整工具链：agent 工具 → 真实 aria2 ==')
  const { apply } = await import('../lib/index.js')
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    // 真实宿主里由 cordis 提供；这里给个最小实现，让系统提示段也能被注册到。
    inject: (deps, callback) => {
      if (deps.includes('systemPrompt')) {
        callback({ systemPrompt: { section: () => () => {} } })
      }
      return { dispose() {} }
    },
  }
  apply(ctx, {
    downloader: 'aria2',
    aria2Rpc: ariaInfo.rpc,
    aria2Secret: ARIA_SECRET,
    category: 'kisssub-test',
  })
  const definition = registered.get('kisssub_download')
  await step('kisssub_download 用 BTIH 投递到 aria2', async () => {
    const value = await definition.execute({ input: HASH }, { signal: new AbortController().signal })
    assert(value.ok, `ok=false: ${value.message}`)
    assert(value.downloader === 'aria2', `downloader=${value.downloader}`)
    assert(value.id, '缺少任务 id')
    const status = await aria2Call({
      rpc: ariaInfo.rpc,
      secret: ARIA_SECRET,
      method: 'aria2.tellStatus',
      params: [value.id],
    })
    assert(status.ok && status.result?.infoHash?.toLowerCase() === HASH, 'aria2 里查不到该任务')
    assert(value.item?.title, '默认应抓详情页补全标题')
    // 没传 savePath 时，应该落到配置里的 defaultSavePath 并被真正传给 aria2。
    assert(value.savePath?.startsWith('/'), `savePath 不是绝对路径: ${value.savePath}`)
    assert(
      String(status.result?.dir).replace(/\/+$/, '') === value.savePath.replace(/\/+$/, ''),
      `aria2 dir(${status.result?.dir}) 与回执 savePath(${value.savePath}) 不一致`,
    )
    return `gid=${value.id}，dir=${value.savePath}，标题=${String(value.item?.title).slice(0, 30)}`
  })

  await step('kisssub_status 回显配置且不含明文密钥', async () => {
    const value = await registered
      .get('kisssub_status')
      .execute({}, { signal: new AbortController().signal })
    assert(value.config.aria2Secret === '***', `密钥未脱敏: ${value.config.aria2Secret}`)
    assert(value.downloader.reachable, '下载器应可达')
    return value.downloader.detail
  })
}

// ---------------------------------------------------------------- qBittorrent mock

console.log('\n== qBittorrent（本地 mock WebUI，校验协议细节） ==')

const received = { login: [], add: [], headers: [] }
let qbServer = null
let qbBase = ''
const QB_USER = 'admin'
const QB_PASS = 'secret'
const SID = 'SID=mock-sid-123'

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => resolve(body))
  })
}

async function startQbMock() {
  qbServer = http.createServer(async (request, response) => {
    const body = await readBody(request)
    const cookie = request.headers.cookie ?? ''
    const authed = cookie.includes('mock-sid-123')
    if (request.url === '/api/v2/auth/login' && request.method === 'POST') {
      received.login.push(body)
      const params = new URLSearchParams(body)
      if (params.get('username') === QB_USER && params.get('password') === QB_PASS) {
        response.writeHead(200, { 'set-cookie': `${SID}; path=/; HttpOnly` })
        response.end('Ok.')
      } else {
        response.writeHead(200)
        response.end('Fails.')
      }
      return
    }
    if (request.url === '/api/v2/app/version') {
      if (!authed) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      response.writeHead(200)
      response.end('v5.0.3')
      return
    }
    if (request.url === '/api/v2/torrents/add' && request.method === 'POST') {
      received.headers.push({
        cookie,
        referer: request.headers.referer ?? null,
        origin: request.headers.origin ?? null,
        contentType: request.headers['content-type'] ?? null,
      })
      received.add.push(body)
      if (!authed) {
        response.writeHead(403)
        response.end('Forbidden')
        return
      }
      response.writeHead(200)
      response.end('Ok.')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise((resolve) => qbServer.listen(0, '127.0.0.1', resolve))
  qbBase = `http://127.0.0.1:${qbServer.address().port}`
}

try {
  await startQbMock()
  const config = {
    downloader: 'qbittorrent',
    qbUrl: qbBase,
    qbUsername: QB_USER,
    qbPassword: QB_PASS,
    savePath: '/downloads/anime',
    category: 'kisssub',
    tags: 'kisssub,anime',
    timeoutMs: 10_000,
  }

  await step('probeDownloader 走 登录 + app/version', async () => {
    const probe = await probeDownloader(config)
    assert(probe.reachable, `不可达: ${probe.detail}`)
    assert(received.login.length === 1, '应登录一次')
    return probe.detail
  })

  await step('qbVersion 需要 SID 才能读版本', async () => {
    const probe = await qbVersion({ baseUrl: qbBase, username: QB_USER, password: QB_PASS })
    assert(probe.ok, probe.detail)
    return probe.detail
  })

  await step('投递任务带上 savepath/category/tags/paused 与 Referer', async () => {
    const result = await qbAdd({
      url: MAGNET,
      baseUrl: qbBase,
      username: QB_USER,
      password: QB_PASS,
      savePath: '/downloads/anime',
      category: 'kisssub',
      tags: 'kisssub,anime',
      paused: true,
    })
    assert(result.ok, result.message)
    const body = received.add.at(-1)
    const headers = received.headers.at(-1)
    assert(body.includes(HASH), 'multipart body 里没有 magnet')
    assert(body.includes('name="urls"'), '缺少 urls 字段')
    assert(body.includes('name="savepath"') && body.includes('/downloads/anime'), '缺少 savepath')
    assert(body.includes('name="category"') && body.includes('kisssub'), '缺少 category')
    assert(body.includes('name="tags"'), '缺少 tags')
    assert(/name="paused"[\s\S]{0,20}true/.test(body), 'paused 未传 true')
    assert(headers.cookie.includes('mock-sid-123'), `未带 SID: ${headers.cookie}`)
    assert(headers.referer === `${qbBase}/`, `Referer 不对: ${headers.referer}`)
    assert(headers.origin === qbBase, `Origin 不对: ${headers.origin}`)
    assert(String(headers.contentType).startsWith('multipart/form-data'), '不是 multipart')
    return `paused=true, category=${'kisssub'}`
  })

  await step('密码错误时返回可读错误', async () => {
    const probe = await qbVersion({ baseUrl: qbBase, username: QB_USER, password: 'wrong' })
    assert(!probe.ok, '错误密码竟然成功')
    assert(/被拒|失败/.test(probe.detail), `错误信息不可读: ${probe.detail}`)
    return probe.detail.slice(0, 50)
  })
} catch (error) {
  bad('qBittorrent mock 测试', error)
} finally {
  qbServer?.close()
}

stopAria()
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
