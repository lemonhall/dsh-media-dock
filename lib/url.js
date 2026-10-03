/**
 * URL 解析、时长格式化、切段计划 —— 都是纯函数，先测通再写流水线。
 *
 * 特意不引任何依赖：这几个站点的主链接形态很少变，
 * 而且解析失败时**必须退回"原样交给 yt-dlp"**，不能因为解析不了就拒绝一个能下载的链接。
 */

/** 站点识别。认不出就返回 other —— 依然允许下载（yt-dlp 支持 1000+ 站点）。 */
export function parseMediaUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase()
  const path = url.pathname

  const youtubeId = (() => {
    if (host === 'youtu.be') return path.slice(1).split('/')[0] || null
    if (!/(^|\.)youtube\.com$/.test(host) && !/(^|\.)youtube-nocookie\.com$/.test(host)) return null
    const v = url.searchParams.get('v')
    if (v) return v
    const hit = path.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/)
    return hit ? hit[1] : null
  })()

  if (youtubeId) {
    return { site: 'youtube', id: youtubeId, canonical: `https://www.youtube.com/watch?v=${youtubeId}`, original: raw }
  }
  if (/(^|\.)youtube\.com$/.test(host)) {
    return { site: 'youtube', id: null, canonical: withScheme, original: raw }
  }
  if (/(^|\.)douyin\.com$/.test(host)) {
    // v.douyin.com/xxxx 是分享短链，id 拿不到，交给 yt-dlp 跟重定向
    const hit = path.match(/\/video\/(\d+)/) || path.match(/\/note\/(\d+)/)
    return { site: 'douyin', id: hit ? hit[1] : null, canonical: withScheme, original: raw }
  }
  if (/(^|\.)iesdouyin\.com$/.test(host)) {
    return { site: 'douyin', id: null, canonical: withScheme, original: raw }
  }
  if (/(^|\.)bilibili\.com$/.test(host) || host === 'b23.tv') {
    const hit = path.match(/\/video\/(BV[A-Za-z0-9]+)/)
    return { site: 'bilibili', id: hit ? hit[1] : null, canonical: withScheme, original: raw }
  }
  if (/(^|\.)(x|twitter)\.com$/.test(host)) {
    const hit = path.match(/\/status\/(\d+)/)
    return { site: 'x', id: hit ? hit[1] : null, canonical: withScheme, original: raw }
  }
  return { site: 'other', id: null, canonical: withScheme, original: raw }
}

/** 秒 → 1:02:03 / 12:34。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 把总时长切成若干段（官方转写 API 是有界的，长视频必须切）。 */
export function chunkPlan(durationSec, chunkSec) {
  const total = Math.max(0, Number(durationSec) || 0)
  const size = Math.max(30, Number(chunkSec) || 240)
  if (!total) return []
  const chunks = []
  for (let start = 0, index = 0; start < total; start += size, index += 1) {
    chunks.push({ index, start, duration: Math.min(size, total - start) })
  }
  return chunks
}

/**
 * 字幕文件挑选：yt-dlp 会下出 `标题.zh-Hans.srt` 这种。
 * 按语言优先级挑，挑不到就给第一个（有总比没有好）。
 */
export function pickSubtitleFile(files, langPref) {
  const list = (files || []).filter(Boolean)
  if (!list.length) return null
  const prefs = String(langPref || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
  for (const want of prefs) {
    const hit = list.find((file) => String(file).toLowerCase().includes(`.${want}.`))
    if (hit) return hit
  }
  return list[0]
}

/** 把 SRT/VTT 变成纯文本（去掉序号/时间轴/内联标签），顺便去掉重复行。 */
export function subtitleToText(raw) {
  const lines = String(raw || '').split(/\r?\n/)
  const out = []
  let last = ''
  for (const line of lines) {
    const text = line
      .replace(/<[^>]*>/g, '') // <i> 之类
      .replace(/\{\\[^}]*\}/g, '') // {\an8}
      .trim()
    if (!text) continue
    if (/^\d+$/.test(text)) continue // 序号
    if (/-->/.test(text)) continue // 时间轴
    if (/^WEBVTT/i.test(text)) continue
    if (/^Kind:|^Language:/i.test(text)) continue
    // 自动字幕常有滚动重复：与前一行完全相同就跳过
    if (text === last) continue
    out.push(text)
    last = text
  }
  return out.join('\n')
}

/** 多段转写结果拼接（去空、按顺序）。 */
export function joinTranscripts(parts) {
  return (parts || [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 给文件名做安全化（标题里有 / : 之类会让 yt-dlp 写不出来）。 */
export function safeFileName(name, fallback = 'media') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}
