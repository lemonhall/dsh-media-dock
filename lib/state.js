/**
 * 通用本地状态：宿主持有，客户端只是它的视图。
 *
 * 为什么要放宿主：这样**两边都能读写** —— 界面里点一下，Agent 调工具就能读到；
 * Agent 写一次，界面轮询到就跟着变。状态只活在浏览器里的话，刷新即丢，Agent 也看不见。
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
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object') state = { ...fallback, ...parsed }
  } catch {
    /* 第一次跑没有文件，用默认值 */
  }

  function get() {
    return { ...state }
  }

  /** 只认识的键会被合并进去，其余忽略；写盘失败不影响返回值。 */
  function patch(partial) {
    const next = { ...state }
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
