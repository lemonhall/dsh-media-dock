/**
 * 状态存储的回归测试：**同一份状态文件，两个实例必须看到同一份内容**。
 *   node test/state.test.mjs
 *
 * 测的是 2026-10-03 的真实事故：宿主插件被 HMR 热重载（改 lib/*.js 就会）后，同一进程里
 * 同时存在新旧两个实例，而工具名仍然解析到**旧**实例。旧实例只在模块初始化时读过一次文件：
 *   · `get()` 给出的是它加载那一刻的快照 → `media_panel read id=…` 报"找不到 id"、`list` 少条目；
 *   · 它一写，就是拿旧快照**整份覆盖**文件 → 新实例辛苦转写出来的字幕被静默抹掉。
 * 修法：get() 每次重读文件，patch() 先重读再合并。下面每一条都是在钉这个行为。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStateStore } from '../lib/state.js'

let failed = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`}`)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-state-store-'))
const file = join(dir, 'state.json')
// 覆盖所有 dock 用到的键；finance 那个变体不接 defaults 参数，多传一个也无害
const defaults = { selected: null, watchlist: [], notes: {}, pinned: [], pendingQuestion: null }

try {
  // 旧实例先加载（模拟热重载之前那一个），新实例后加载
  const stale = createStateStore(file, defaults)
  const live = createStateStore(file, defaults)

  stale.patch({ watchlist: ['AAA'] })
  check('新实例看得到旧实例写的（读文件而不是读快照）', live.get().watchlist, ['AAA'])

  live.patch({ watchlist: ['AAA', 'BBB'] })
  check('旧实例也看得到新实例写的', stale.get().watchlist, ['AAA', 'BBB'])

  // 核心一条：旧实例接着写，必须先把 BBB 合并进来，不能整份覆盖
  stale.patch({ selected: 'CCC' })
  check('旧实例的写不会抹掉新实例的数据', JSON.parse(readFileSync(file, 'utf8')).watchlist, ['AAA', 'BBB'])
  check('旧实例的写本身照样生效', stale.get().selected, 'CCC')

  // 另一个 DSH 进程直接改文件，也要马上可见
  writeFileSync(file, JSON.stringify({ ...defaults, watchlist: ['ZZZ'], revision: 9 }), 'utf8')
  check('外部进程写过之后立刻可见', live.get().watchlist, ['ZZZ'])

  // revision 单调 +1：客户端靠它判断要不要重画
  const before = live.get().revision
  check('revision 递增', live.patch({ selected: null }).revision, before + 1)

  // 不认识的键被忽略（免得客户端塞垃圾进来）
  live.patch({ junkKey: 1 })
  check('不认识的键被忽略', 'junkKey' in live.get(), false)

  // 文件不存在时给默认值，不炸
  const empty = createStateStore(join(dir, 'nope.json'), defaults)
  check('没有文件时用默认值', empty.get().watchlist, [])
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
