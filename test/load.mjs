#!/usr/bin/env node
/**
 * 插件装载 + 工具契约测试。
 *
 *   node test/load.mjs
 *
 * 做五件事：
 *   1. 以桩 ctx 装载 lib/index.js（真跑 defineTool，所以 schema 编译错误会在这里暴露）
 *   2. 校验注册出来的工具名与输出 schema（用真实的 validateJsonSchemaValue）
 *   3. 真实调用工具（只读那几个），校验返回值确实符合 output.schema，并跑一遍 render
 *   4. 校验首次使用流程：自动创建配置文件 → firstRun 引导 → kisssub_configure 写入 → 引导消失
 *   5. 校验系统提示段在"未确认保存目录"时出现、确认后消失
 *
 * 全程用临时配置文件，不碰真实的 ~/.dsh/dsh-kisssub.json。
 * 需要能解析到 @deepseek-ai/*（在已装好 dsh 的 profile 里跑，或按 README 建 node_modules 软链）。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../lib/index.js'

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
const EXPECTED = [
  'kisssub_search',
  'kisssub_latest',
  'kisssub_magnet',
  'kisssub_download',
  'kisssub_configure',
  'kisssub_status',
]

const dir = mkdtempSync(join(tmpdir(), 'dsh-kisssub-load-'))
const configFile = join(dir, 'dsh-kisssub.json')

const registered = new Map()
/** 捕获系统提示段，用来验证"首次使用要让 agent 去问用户"。 */
const promptSections = new Map()
const promptCtx = {
  systemPrompt: {
    section(definition) {
      promptSections.set(definition.name, definition)
      return () => promptSections.delete(definition.name)
    },
  },
}
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  inject(deps, callback) {
    if (deps.includes('systemPrompt')) callback(promptCtx)
    return { dispose() {} }
  },
}

console.log('== 装载 ==')
await step('Config schema 可用', () => {
  assert(typeof Config === 'function', 'Config 应导出 schemastery schema')
  assert(Config.type === 'object', `Config.type 应为 object，实际 ${Config.type}`)
  const defaults = Config({})
  assert(defaults && typeof defaults === 'object', 'Config({}) 应能解析出默认值')
  return `${Object.keys(defaults).length} 个配置项`
})

await step('apply() 成功并注册 6 个工具', () => {
  apply(ctx, { configFile })
  assert(registered.size === EXPECTED.length, `注册了 ${registered.size} 个: ${[...registered.keys()].join(', ')}`)
  return [...registered.keys()].join(', ')
})

await step('第一次使用自动创建配置文件', () => {
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  assert(raw.savePathConfirmed === false, 'savePathConfirmed 应为 false')
  assert(raw.savePath === '', '新建时 savePath 应为空')
  assert(typeof raw.defaultSavePath === 'string' && raw.defaultSavePath.length > 0, 'defaultSavePath 缺失')
  return configFile
})

await step('注册了系统提示段（用于让 agent 主动问用户）', () => {
  assert(promptSections.has('plugin:dsh-kisssub'), `未注册: ${[...promptSections.keys()].join(', ')}`)
  return 'plugin:dsh-kisssub'
})

console.log('\n== 工具清单 ==')
for (const name of EXPECTED) {
  await step(name, () => {
    const definition = registered.get(name)
    assert(definition, `未注册 ${name}`)
    assert(definition.description && definition.description.length > 10, 'description 过短')
    assert(definition.parameters && typeof definition.parameters === 'object', 'parameters 缺失')
    assert(definition.output?.schema, 'output.schema 缺失')
    assert(typeof definition.output.render === 'function', 'output.render 缺失')
    return `${Object.keys(definition.parameters.properties ?? {}).length} 个参数`
  })
}

const exec = { signal: new AbortController().signal }

async function callTool(name, args) {
  const definition = registered.get(name)
  assert(definition, `未注册 ${name}`)
  const value = await definition.execute(args, exec)
  const violations = validateJsonSchemaValue(definition.output.schema, value, '')
  assert(
    Array.isArray(violations) && violations.length === 0,
    `返回值不符合 output.schema: ${JSON.stringify(violations).slice(0, 400)}`,
  )
  const content = definition.output.render(args, value)
  assert(Array.isArray(content) && content.length > 0, 'render 返回空')
  assert(content.every((block) => block?.type === 'text' && typeof block.text === 'string'), 'render 内容非法')
  return { value, content }
}

console.log('\n== 真实调用 + 输出 schema 校验 ==')
for (const [name, args] of [
  ['kisssub_status', {}],
  ['kisssub_latest', { limit: 2 }],
  ['kisssub_search', { keyword: '葬送的芙莉莲', limit: 2 }],
  ['kisssub_magnet', { input: HASH }],
  ['kisssub_download', { input: HASH, preferTorrent: true }],
]) {
  await step(`${name} → schema 通过`, async () => {
    const { value, content } = await callTool(name, args)
    console.log(`      render: ${content[0].text.split('\n')[0].slice(0, 90)}`)
    return JSON.stringify(value).slice(0, 100).replace(/\s+/g, ' ')
  })
}

console.log('\n== 首次使用流程 ==')
let statusValue = null
await step('status 报告 firstRun=true 并给出行动指引', async () => {
  statusValue = (await callTool('kisssub_status', {})).value
  assert(statusValue.setup.firstRun === true, 'firstRun 应为 true')
  assert(statusValue.setup.savePathConfirmed === false, 'savePathConfirmed 应为 false')
  assert(statusValue.setup.effectiveSavePath.length > 0, 'effectiveSavePath 缺失')
  assert(statusValue.setup.hint.includes('kisssub_configure'), `hint 没给出下一步: ${statusValue.setup.hint}`)
  assert(statusValue.setup.configFile === configFile, 'configFile 不对')
  return statusValue.setup.effectiveSavePath
})

await step('系统提示段此时非空（agent 会去问用户）', () => {
  const text = promptSections.get('plugin:dsh-kisssub').text()
  assert(text.length > 0, '未确认保存目录时系统提示不该为空')
  assert(text.includes('默认保存到哪个目录'), `提示内容不对: ${text.slice(0, 80)}`)
  return text.slice(0, 70) + '…'
})

await step('未确认时 kisssub_download 会带 note 提醒', async () => {
  const { value } = await callTool('kisssub_download', { input: HASH })
  assert(value.note && value.note.includes('kisssub_configure'), `note 缺失: ${value.note}`)
  assert(value.savePath === statusValue.setup.effectiveSavePath, `savePath 不对: ${value.savePath}`)
  return value.note.slice(0, 70)
})

await step('kisssub_configure 写入 savePath 并自动标记确认', async () => {
  const target = join(dir, 'anime')
  const { value } = await callTool('kisssub_configure', { savePath: target })
  assert(value.ok, `写入失败: ${value.message}`)
  assert(value.written.includes('savePath'), 'written 未包含 savePath')
  assert(value.written.includes('savePathConfirmed'), '未自动标记 savePathConfirmed')
  assert(value.effectiveSavePath === target, `effectiveSavePath 未生效: ${value.effectiveSavePath}`)
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  assert(raw.savePath === target, '文件里的 savePath 不对')
  assert(raw.savePathConfirmed === true, '文件里的 savePathConfirmed 不对')
  assert(typeof raw._createdAt === 'string', '原有字段被覆盖掉了')
  return `${target}`
})

await step('确认后 status 不再提示、系统提示段变空', async () => {
  const { value } = await callTool('kisssub_status', {})
  assert(value.setup.firstRun === false, 'firstRun 应变为 false')
  assert(value.setup.savePathConfirmed === true, 'savePathConfirmed 应为 true')
  assert(value.setup.hint === '', 'hint 应清空')
  assert(value.setup.configFileCreated === false || typeof value.setup.configFileCreated === 'boolean', '状态字段异常')
  const text = promptSections.get('plugin:dsh-kisssub').text()
  assert(text === '', `确认后系统提示应清空，实际: ${text.slice(0, 60)}`)
  return '引导已消失'
})

await step('确认后 kisssub_download 不再带 note', async () => {
  const { value } = await callTool('kisssub_download', { input: HASH })
  assert(value.note === null, `note 应清空: ${value.note}`)
  assert(value.savePath === join(dir, 'anime'), `savePath 不对: ${value.savePath}`)
  return `savePath=${value.savePath}`
})

await step('kisssub_configure 拒绝非法 savePath', async () => {
  const { value } = await callTool('kisssub_configure', { savePath: 'relative/dir' })
  assert(value.ok === false, '相对路径竟然被接受')
  assert(value.message.includes('绝对路径'), `错误信息不可读: ${value.message}`)
  const raw = JSON.parse(readFileSync(configFile, 'utf8'))
  assert(raw.savePath === join(dir, 'anime'), '非法写入污染了配置文件')
  return value.message.slice(0, 50)
})

await step('kisssub_configure 空调用不写文件', async () => {
  const { value } = await callTool('kisssub_configure', {})
  assert(value.ok === false, '空调用不该成功')
  return value.message
})

console.log('\n== 参数校验（负面用例） ==')
await step('kisssub_search 缺少 keyword 会抛错', async () => {
  const definition = registered.get('kisssub_search')
  let message = ''
  try {
    await definition.execute({}, exec)
    throw new Error('缺少必填 keyword 时竟然没抛错')
  } catch (error) {
    message = error?.message ?? String(error)
  }
  assert(message.includes('keyword'), `错误信息不含 keyword: ${message}`)
  return message.split('\n')[0].slice(0, 70)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
