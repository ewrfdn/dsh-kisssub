#!/usr/bin/env node
/**
 * 配置层测试：首次创建、默认保存目录、优先级、写入合并。
 *
 *   node test/config.mjs
 *
 * 全程使用临时目录，不碰真实的 ~/.dsh/dsh-kisssub.json。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONFIG_FILE,
  DEFAULT_SAVE_PATH,
  DEFAULTS,
  ensureConfigFile,
  expandHome,
  fromEnv,
  maskConfig,
  readConfigFile,
  resolveConfig,
  resolveSavePath,
  toAbsolute,
  writeConfigFile,
} from '../lib/config.js'

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
function step(label, fn) {
  try {
    ok(label, fn())
  } catch (error) {
    bad(label, error)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-kisssub-cfg-'))
const file = join(dir, 'nested', 'dsh-kisssub.json')

console.log('== 路径工具 ==')
step('expandHome 展开 ~', () => {
  assert(expandHome('~/Downloads/a') === join(homedir(), 'Downloads', 'a'), '~ 展开失败')
  assert(expandHome('~') === homedir(), '单独 ~ 失败')
  assert(expandHome('/abs/path') === '/abs/path', '绝对路径被改动')
  assert(expandHome('') === '', '空值应原样返回')
  return `~ → ${homedir()}`
})

step('toAbsolute 相对路径按 cwd 归一', () => {
  assert(toAbsolute('rel/dir') === join(process.cwd(), 'rel/dir'), '相对路径未归一')
  assert(toAbsolute('') === '', '空值应原样返回')
  return toAbsolute('rel/dir')
})

console.log('\n== 首次使用：创建配置文件 ==')
let first = null
step('第一次调用会创建文件（含父目录）', () => {
  assert(!existsSync(file), '前提：文件不该存在')
  first = ensureConfigFile({ file })
  assert(first.created, `未创建: ${first.error}`)
  assert(first.existed === false, 'existed 应为 false')
  assert(existsSync(file), '文件不存在')
  return file
})

step('创建的内容是最小字段集 + 说明', () => {
  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert(written.savePath === '', `savePath 应为空，实际 ${written.savePath}`)
  assert(written.defaultSavePath === DEFAULT_SAVE_PATH, 'defaultSavePath 不对')
  assert(written.savePathConfirmed === false, 'savePathConfirmed 应为 false')
  assert(typeof written._comment === 'string' && written._comment.length > 10, '_comment 缺失')
  assert(typeof written._createdAt === 'string', '_createdAt 缺失')
  // 最小字段集：不该把 downloader/密钥这类默认值写进去，否则会遮住别的配置层
  assert(!('downloader' in written), '创建时不该写 downloader')
  assert(!('qbPassword' in written), '创建时不该写密钥字段')
  return Object.keys(written).join(', ')
})

step('第二次调用是幂等的', () => {
  const second = ensureConfigFile({ file })
  assert(second.created === false && second.existed === true, '重复调用不该再创建')
  return 'created=false'
})

step('配置文件损坏时读取降级为空对象', () => {
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json', 'utf8')
  assert(Object.keys(readConfigFile(broken)).length === 0, '损坏文件应返回 {}')
  return 'readConfigFile → {}'
})

console.log('\n== 默认保存目录 ==')
const base = resolveConfig({}, { file, env: {} })
step('未指定目录时用 defaultSavePath', () => {
  assert(base.savePath === '', `savePath 应空: ${base.savePath}`)
  assert(base.defaultSavePath === DEFAULT_SAVE_PATH, 'defaultSavePath 不对')
  assert(base.effectiveSavePath === DEFAULT_SAVE_PATH, `实际: ${base.effectiveSavePath}`)
  assert(base.savePathConfirmed === false, 'savePathConfirmed 应为 false')
  return base.effectiveSavePath
})

step('resolveSavePath 优先级：入参 > savePath > defaultSavePath', () => {
  const config = { savePath: '/data/anime', defaultSavePath: '/data/default' }
  assert(resolveSavePath(config, '/tmp/x') === '/tmp/x', '入参没赢')
  assert(resolveSavePath(config, '') === '/data/anime', 'savePath 没赢')
  assert(resolveSavePath({ savePath: '', defaultSavePath: '/data/default' }) === '/data/default', '默认没生效')
  assert(resolveSavePath({}, '~/a') === join(homedir(), 'a'), '~ 没展开')
  return '/tmp/x > /data/anime > /data/default'
})

step('用户写入 savePath 后生效并被标记确认', () => {
  const written = writeConfigFile({ savePath: '/srv/anime', savePathConfirmed: true }, { file })
  assert(written.ok, written.message)
  const next = resolveConfig({}, { file, env: {} })
  assert(next.savePath === '/srv/anime', `savePath 未生效: ${next.savePath}`)
  assert(next.effectiveSavePath === '/srv/anime', 'effectiveSavePath 未跟随')
  assert(next.savePathConfirmed === true, 'savePathConfirmed 未生效')
  return next.effectiveSavePath
})

step('写入是合并而不是覆盖', () => {
  const written = writeConfigFile({ downloader: 'aria2' }, { file })
  assert(written.ok, written.message)
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert(raw.savePath === '/srv/anime', 'savePath 被覆盖掉了')
  assert(raw.downloader === 'aria2', 'downloader 未写入')
  assert(raw.savePathConfirmed === true, 'savePathConfirmed 被覆盖掉了')
  return Object.keys(raw).join(', ')
})

step('null / undefined 字段被跳过，空串会显式清空', () => {
  writeConfigFile({ qbPassword: null, qbUsername: undefined, tags: '' }, { file })
  const raw = readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  assert(!('qbPassword' in parsed), 'null 不该写入')
  assert(!('qbUsername' in parsed), 'undefined 不该写入')
  assert(parsed.tags === '', '空串应写入（用于清空）')
  return 'null/undefined 跳过'
})

console.log('\n== 优先级 ==')
step('内置默认 < 插件 config < 文件 < 环境变量', () => {
  const resolved = resolveConfig(
    { downloader: 'aria2', aria2Secret: 'from-plugin', category: 'plugin' },
    { file, env: { KISSSUB_DOWNLOADER: 'qbittorrent', KISSSUB_CATEGORY: 'env' } },
  )
  assert(resolved.downloader === 'qbittorrent', `env 没赢: ${resolved.downloader}`)
  assert(resolved.aria2Secret === 'from-plugin', `插件层没生效: ${resolved.aria2Secret}`)
  assert(resolved.category === 'env', `env 没赢 category: ${resolved.category}`)
  assert(resolved.defaultLimit === DEFAULTS.defaultLimit, '内置默认值没兜住')
  return 'env > 文件 > 插件 > 默认'
})

step('插件 config 里的空串视为"没填"', () => {
  const resolved = resolveConfig({ aria2Rpc: '   ', baseUrl: '' }, { file, env: {} })
  assert(resolved.aria2Rpc === DEFAULTS.aria2Rpc, `空串遮住了默认值: ${resolved.aria2Rpc}`)
  assert(resolved.baseUrl === DEFAULTS.baseUrl, `空串遮住了 baseUrl: ${resolved.baseUrl}`)
  return '空串被丢弃'
})

step('文件里的文档键不进入生效配置', () => {
  const resolved = resolveConfig({}, { file, env: {} })
  assert(!('_comment' in resolved) && !('_createdAt' in resolved), '_ 开头的键泄漏了')
  return '已过滤'
})

step('configFile 可由插件 config / 环境变量指定', () => {
  const viaEnv = resolveConfig({}, { env: { KISSSUB_CONFIG_FILE: '/tmp/via-env.json' } })
  assert(viaEnv.configFile === '/tmp/via-env.json', `env 指定失败: ${viaEnv.configFile}`)
  const viaPlugin = resolveConfig({ configFile: '/tmp/via-plugin.json' }, { env: {} })
  assert(viaPlugin.configFile === '/tmp/via-plugin.json', '插件 config 指定失败')
  const viaPath = resolveConfig({}, { file: 'rel.json', env: {} })
  assert(viaPath.configFile === join(process.cwd(), 'rel.json'), '相对路径应归一成绝对路径')
  return '/tmp/via-env.json 等'
})

step('默认配置文件路径就是 ~/.dsh/dsh-kisssub.json', () => {
  assert(CONFIG_FILE === join(homedir(), '.dsh', 'dsh-kisssub.json'), `实际: ${CONFIG_FILE}`)
  assert(resolveConfig({}, { env: {} }).configFile === CONFIG_FILE, '默认 configFile 不对')
  return CONFIG_FILE
})

step('fromEnv 解析布尔与列表', () => {
  const parsed = fromEnv({ KISSSUB_SAVE_PATH_CONFIRMED: 'true', KISSSUB_TRACKERS: 'a, b ,c' })
  assert(parsed.savePathConfirmed === true, '布尔解析失败')
  assert(JSON.stringify(parsed.trackers) === '["a","b","c"]', '列表解析失败')
  return 'true / [a,b,c]'
})

console.log('\n== 回显脱敏 ==')
step('maskConfig 隐去密钥并带出保存目录信息', () => {
  const resolved = resolveConfig(
    { cookie: 'x', aria2Secret: 'y', qbPassword: 'z', savePath: '/srv/anime' },
    { file, env: {} },
  )
  const masked = maskConfig(resolved)
  assert(masked.cookie === '***', 'cookie 未脱敏')
  assert(masked.aria2Secret === '***', 'aria2Secret 未脱敏')
  assert(masked.qbPassword === '***', 'qbPassword 未脱敏')
  assert(masked.effectiveSavePath === '/srv/anime', 'effectiveSavePath 缺失')
  assert(masked.savePathConfirmed === true, 'savePathConfirmed 缺失')
  assert(JSON.stringify(masked).includes('"y"') === false, '明文密钥泄漏')
  return Object.keys(masked).join(', ')
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
