#!/usr/bin/env node
/**
 * bundle 清单自检：确认这个包满足 DSH 的「可安装 bundle」契约。
 *
 *   node test/bundle.mjs
 *
 * 校验：
 *   - package.json 合法，main / dsh.bundle.patch 指向的文件真实存在
 *   - cordis.patch.yml 是合法的 patch 列表，insert 行的 name 与包名一致
 *   - 插件入口真的导出 name / inject / apply / Config，且 inject 含 tools
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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

console.log('== package.json ==')
let manifest = null
step('package.json 可解析', () => {
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert(manifest.name, '缺少 name')
  assert(manifest.type === 'module', 'type 必须是 module')
  return `${manifest.name}@${manifest.version}`
})

step('main 指向的文件存在', () => {
  assert(manifest.main, '缺少 main')
  const mainPath = join(root, manifest.main)
  assert(existsSync(mainPath), `不存在: ${manifest.main}`)
  return manifest.main
})

step('dsh.bundle.patch 声明正确', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert(patch, '缺少 dsh.bundle.patch（装了也不会激活任何 layer）')
  assert(existsSync(join(root, patch)), `patch 文件不存在: ${patch}`)
  return patch
})

step('files 覆盖运行所需文件', () => {
  assert(manifest.files?.includes('lib'), 'files 应包含 lib')
  assert(manifest.files?.some((f) => f.endsWith('.patch.yml')), 'files 应包含 cordis.patch.yml')
  return manifest.files.join(', ')
})

console.log('\n== cordis.patch.yml ==')
step('是合法的 patch 列表并插入了插件行', () => {
  const patch = yaml.load(readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8'))
  assert(Array.isArray(patch), 'patch 顶层应为数组')
  const rows = patch.flatMap((layer) => layer?.insert ?? [])
  assert(rows.length >= 1, '没有 insert 行')
  const row = rows[0]
  assert(row.id, 'insert 行缺少 id')
  assert(row.name === manifest.name, `insert 行 name(${row.name}) 应等于包名(${manifest.name})`)
  return `id=${row.id}, name=${row.name}`
})

console.log('\n== 插件入口 ==')
const module = await import(join(root, manifest.main))
step('导出 name / inject / apply / Config', () => {
  assert(typeof module.name === 'string', '缺少 name 导出')
  assert(Array.isArray(module.inject), '缺少 inject 导出')
  assert(module.inject.includes('tools'), "inject 必须含 'tools'")
  assert(typeof module.apply === 'function', '缺少 apply 导出')
  assert(typeof module.Config === 'function' && module.Config.type === 'object', 'Config 应为 schemastery object schema')
  return `name=${module.name}, inject=[${module.inject.join(',')}]`
})

console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
