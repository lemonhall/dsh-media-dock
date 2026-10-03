/**
 * 通用本地状态：宿主持有，客户端只是它的视图。
 *
 * 为什么要放宿主：这样**两边都能读写** —— 界面里点一下，Agent 调工具就能读到；
 * Agent 写一次，界面轮询到就跟着变。状态只活在浏览器里的话，刷新即丢，Agent 也看不见。
 *
 * ⚠️ 2026-10-03 修的坑（症状：`media_panel read id=…` 报"找不到 id"，`list` 里少一条）：
 * 原来只在模块初始化时把文件读进内存，之后 `get()` 只认内存那一份。而宿主插件被 HMR
 * 热重载（改一下 `lib/*.js` 就会）时模块会被**重新求值一次**，于是同一个进程里同时存在
 * 两个实例、两份互不相干的快照 —— 而且工具名仍然解析到**旧实例**（新实例的注册没顶掉它）：
 *   · 旧实例读到的是它加载那一刻的快照 → 新写入的条目它看不见；
 *   · 旧实例一写，就是拿旧快照**整份覆盖**文件 → 新实例写的东西被静默抹掉（真丢过一条字幕）。
 * 现在：`get()` 每次都重读文件（文件是唯一真相），`patch()` 先重读再合并，绝不用旧快照覆盖。
 *
 * 原子写：先写临时文件再 rename，读的人不会撞上写了一半的文件。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * @param {string} file 状态文件路径
 * @param {object} defaults 默认状态（同时规定了允许出现的键）
 */
export function createStateStore(file, defaults) {
  const fallback = { ...(defaults || {}) }
  let state = { ...fallback }

  /**
   * 从磁盘重读一份。**不能只读一次** —— 见文件头那段：热重载/多实例下，
   * 内存里的快照随时可能过期。文件不存在（第一次跑）就保留内存里的默认值。
   */
  function refresh() {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') state = { ...fallback, ...parsed }
    } catch {
      /* 第一次跑没有文件，用默认值 */
    }
    return state
  }

  refresh()

  function get() {
    return { ...refresh() }
  }

  /** 只认识的键会被合并进去，其余忽略；写盘失败不影响返回值。 */
  function patch(partial) {
    // ① 先重读：别人（另一个实例、热重载后的新实例）刚写的内容才是基线，
    //    否则我这份旧快照会把它们整份覆盖掉。
    const next = { ...refresh() }
    for (const [key, value] of Object.entries(partial || {})) {
      if (!(key in fallback)) continue
      next[key] = value
    }
    next.updatedAt = Date.now()
    next.revision = (Number(state.revision) || 0) + 1
    state = next
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      /* 写不进去也不该把界面拖垮 */
    }
    return get()
  }

  return { get, patch, file }
}
