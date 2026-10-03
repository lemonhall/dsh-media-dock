/**
 * Host half of dsh-media-dock —— 媒体台。
 *
 * 流水线（每段都用本机已有的东西）：
 *   ① yt-dlp 探元数据（标题/时长/有没有字幕），再下载；优先抓现成字幕（零成本）
 *   ② 没字幕才 ffmpeg 转 16kHz 单声道 PCM16 WAV —— 这是官方 speechToText 唯一接受的格式
 *   ③ ctx.speechToText.transcribe()（SenseVoice，本地）—— **有界**，所以长视频自己切段
 *   ④ 字幕存进本插件状态（官方不留转写历史，这活儿归我）
 *
 * STT 是 **optional**（`ctx.get('speechToText')`）：没装语音输入插件也能用，只是只能抓现成字幕。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStateStore } from './state.js'
import {
  parseMediaUrl,
  formatDuration,
  chunkPlan,
  pickSubtitleFile,
  subtitleToText,
  joinTranscripts,
  safeFileName,
} from './url.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  outputDir: 'E:\\development\\dsh-media',
  ytDlpPath: 'C:\\Users\\lemon\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe',
  ffmpegPath: 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  proxy: 'http://127.0.0.1:7897',
  // 代理按站点决定：国内站点（抖音/B站）**不能走代理**，境外（YouTube/X）必须走。
  // 'auto' = 看 site 在不在 proxySites 里；也接受 true/false 强制全局。
  useProxy: 'auto',
  proxySites: ['youtube', 'x'],
  // ---- Cookie 阶梯（照 video-download SKILL 的做法）----
  // ① 先不带 cookie 跑（公开内容一次就过，别让人白关浏览器）
  // ② 命中登录墙特征才升级：优先用 cookiesFile，其次 --cookies-from-browser
  // ③ `--cookies-from-browser chrome` 要求 **Chrome 完全退出**（16 个进程一个不剩），
  //    否则 yt-dlp 报 `Could not copy Chrome cookie database`（issue 7271，是文件被锁不是加密）
  // ④ 不想关 Chrome 就用导出式：Chrome 装 `Get cookies.txt LOCALLY` 导出 cookies.txt，
  //    路径填进 cookiesFile —— **不受 Chrome 运行状态影响，适合当长期方案**。
  // 配了 cookiesFile 就用它（最稳）；否则**默认自己试 --cookies-from-browser chrome** ——
  // 不要一上来就让用户去配置：Chrome 已经关掉的话，这一步本来就该自动成功。
  // 只有这一步因为 cookie 库被锁而失败时，才提示"关掉 Chrome 或改用 cookiesFile"。
  cookiesFile: '',
  cookiesFromBrowser: 'chrome',
  // 命中这些字样就判定是登录墙，自动带 cookie 重跑
  cookieWallPatterns: [
    'fresh cookies',
    'sign in to confirm',
    'login required',
    'age-restricted',
    'no video could be found',
    'cookies are needed',
    'not a bot',
  ],
  preferSubtitles: true,
  subtitleLangs: 'zh-Hans,zh-CN,zh,en',
  transcribeChunkSeconds: 180,
  // 转写语言。**默认 auto**：硬编码 'zh' 会让英文音频被按中文解码（实测冒出"那那s错"
  // 这种中英混合垃圾）；抖音里中英夹杂更是常态。要固定语言再显式配。
  transcribeLanguage: 'auto',
  maxConcurrent: 1,
  keepItems: 50,
}

const ROUTE_STATE = '/dsh-media/state'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const stateStore = createStateStore(join(DSH_HOME, 'dsh-media-dock', 'state.json'), {
  items: [], // [{id, url, site, title, durationSec, status, progress, note, transcript, transcriptSource, error, at}]
  pendingQuestion: null,
})

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 跑一个子进程，逐行回调；Windows 下命令行的中文输出按 UTF-8 读。 */
function runCommand(exe, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8')
      if (isErr) stderr += text
      else stdout += text
      if (options.onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) options.onLine(line.trim())
        }
      }
    }
    child.stdout.on('data', (chunk) => feed(chunk, false))
    child.stderr.on('data', (chunk) => feed(chunk, true))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` }))
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, stdout, stderr }))
    if (options.signal) {
      const abort = () => {
        try {
          child.kill()
        } catch {
          /* fine */
        }
      }
      if (options.signal.aborted) abort()
      else options.signal.addEventListener('abort', abort, { once: true })
    }
  })
}

function pickExecutable(configured, fallbackName) {
  if (configured && existsSync(configured)) return configured
  return fallbackName // 交给 PATH
}

/** 目录里按后缀找文件（最新优先）。 */
function findFiles(dir, predicate) {
  try {
    return readdirSync(dir)
      .filter((name) => predicate(name))
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

/** Host plugin body. */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  const outputDir = String(opts.outputDir || DEFAULTS.outputDir)
  try {
    mkdirSync(outputDir, { recursive: true })
  } catch {
    /* 下面用到时会再报 */
  }

  const running = new Set() // 正在处理中的 item id
  const aborts = new Map() // id → AbortController
  let activeCount = 0
  const queue = []

  const patchItem = (id, patch) => {
    const items = stateStore.get().items || []
    const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
    stateStore.patch({ items: trim(next) })
    return next.find((item) => item.id === id)
  }
  const trim = (items) => {
    const keep = Math.max(5, Number(opts.keepItems) || 50)
    return items.length > keep ? items.slice(0, keep) : items
  }

  /** 用 ffprobe 就地量时长（本地，不联网）。拿不到返回 0。 */
  async function ffprobeDuration(mediaPath) {
    const ffprobe = pickExecutable(String(opts.ffmpegPath || '').replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), 'ffprobe')
    const { code, stdout } = await runCommand(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      mediaPath,
    ])
    if (code !== 0) return 0
    const seconds = Number(String(stdout).trim().split('\n')[0])
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  }

  /** STT 是否可用（optional access，契约里就是这么写的）。 */
  const stt = () => (typeof ctx.get === 'function' ? ctx.get('speechToText') : undefined)

  /**
   * 官方那套转写是**有界**的 —— `SpeechCatalog` 上写着 `maxAudioBytes` 和 `maxDurationSeconds`。
   * 我一开始把段长拍成 180 秒，5.8MB 直接被拒：`Invalid speech audio size`。
   * 所以段长必须**问它要**，不能猜。
   */
  const speechLimits = () => {
    const controller = typeof ctx.get === 'function' ? ctx.get('speechController') : undefined
    try {
      const catalog = controller && typeof controller.catalog === 'function' ? controller.catalog() : null
      return {
        maxAudioBytes: Number(catalog && catalog.maxAudioBytes) || 0,
        maxDurationSeconds: Number(catalog && catalog.maxDurationSeconds) || 0,
      }
    } catch {
      return { maxAudioBytes: 0, maxDurationSeconds: 0 }
    }
  }

  /** 按官方上限算出真正安全的段长（16kHz 单声道 16bit = 每秒 32000 字节）。 */
  const safeChunkSeconds = () => {
    const configured = Math.max(30, Number(opts.transcribeChunkSeconds) || 180)
    const { maxAudioBytes, maxDurationSeconds } = speechLimits()
    let seconds = configured
    if (maxDurationSeconds > 0) seconds = Math.min(seconds, Math.floor(maxDurationSeconds * 0.9))
    if (maxAudioBytes > 0) seconds = Math.min(seconds, Math.floor((maxAudioBytes * 0.9) / 32000))
    return { seconds: Math.max(5, seconds), maxAudioBytes, maxDurationSeconds }
  }

  const sttStatus = () => {
    const service = stt()
    if (!service) return { available: false, reason: '没装/没启用语音输入插件（speechToText 服务不存在）' }
    try {
      const snapshot = service.snapshot()
      const providers = (snapshot && snapshot.providers) || []
      const selection = (snapshot && snapshot.selection) || {}
      const chosen = providers.find((provider) => provider.id === selection.providerId) || providers[0]
      return {
        available: Boolean(providers.length),
        reason: providers.length ? null : '语音服务在，但一个 provider 都没注册',
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          location: provider.location,
          languages: provider.languages,
          preparation: provider.preparation && provider.preparation.phase,
        })),
        selected: chosen ? { id: chosen.id, name: chosen.name, language: selection.language || null } : null,
      }
    } catch (error) {
      return { available: false, reason: `读语音服务状态失败：${(error && error.message) || error}` }
    }
  }

  /**
   * 代理按站点决定：**抖音/B站 这类国内站点绝不能走代理**（Clash 会把它送出国，要么慢要么废），
   * YouTube/X 必须走。这是柠檬叔明确要求的规则。
   *
   * ⚠️ 关键细节：**即使不走代理也要显式传 `--proxy ""`** —— 否则 yt-dlp 会去读环境变量里的
   * HTTP_PROXY/HTTPS_PROXY（我的 spawn 继承 process.env），等于偷偷走了代理。
   */
  const proxyForSite = (site) => {
    if (opts.useProxy === false) return ''
    if (opts.useProxy === true) return String(opts.proxy || '')
    const list = Array.isArray(opts.proxySites) ? opts.proxySites : DEFAULTS.proxySites
    return list.includes(String(site || '').toLowerCase()) ? String(opts.proxy || '') : ''
  }

  const ytArgs = (site, extra = [], withCookies = false) => {
    const args = ['--no-playlist', '--no-warnings', '--newline', ...extra]
    args.push('--proxy', proxyForSite(site))
    if (withCookies) {
      const cookie = cookieArgs()
      if (Array.isArray(cookie)) args.push(...cookie)
      else if (cookie && cookie.error) args.push('--cookies-from-browser', String(opts.cookiesFromBrowser))
    }
    return args
  }

  /** 这段输出像不像"登录墙"？（照 SKILL 里那串特征） */
  const looksLikeCookieWall = (text) => {
    const lower = String(text || '').toLowerCase()
    const patterns = Array.isArray(opts.cookieWallPatterns) ? opts.cookieWallPatterns : DEFAULTS.cookieWallPatterns
    return patterns.some((pattern) => lower.includes(String(pattern).toLowerCase()))
  }

  /**
   * 把 Chrome 的 cookie 库复制成一个"迷你 profile"，绕开 issue 7271 的锁。
   *
   * 为什么需要：`--cookies-from-browser chrome` 在 Chrome 运行时读不了那个 SQLite
   * （报 `Could not copy Chrome cookie database`）。柠檬叔的原话是"我都关闭 chrome 了啊，
   * 为啥还要我配置"—— 实测他机器上还有 12 个 chrome 进程（**关窗口 ≠ 退进程**）。
   * 与其要求人手动退干净，不如把两个文件复制到临时目录，再用
   * `--cookies-from-browser chrome:<复制出来的目录>` —— **Chrome 开着也能用**。
   *
   * 要两个文件：`Local State`（解密密钥在里面）和 `Default/Network/Cookies`。
   */
  function chromeCookieProfile() {
    const browser = String(opts.cookiesFromBrowser || '').toLowerCase()
    if (!browser.startsWith('chrome')) return null
    const userData = join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
    const state = join(userData, 'Local State')
    const cookies = join(userData, 'Default', 'Network', 'Cookies')
    if (!existsSync(state) || !existsSync(cookies)) return null
    const target = join(tmpdir(), 'dsh-media-chrome-profile')
    try {
      mkdirSync(join(target, 'Default', 'Network'), { recursive: true })
      copyFileSync(state, join(target, 'Local State'))
      copyFileSync(cookies, join(target, 'Default', 'Network', 'Cookies'))
      return { ok: true, dir: target }
    } catch (error) {
      return { ok: false, error: (error && error.message) || String(error) }
    }
  }

  /** 实际传给 yt-dlp 的 cookie 参数：优先 cookiesFile，其次自动复制出来的 Chrome profile。 */
  function cookieArgs() {
    if (opts.cookiesFile) return ['--cookies', String(opts.cookiesFile)]
    const profile = chromeCookieProfile()
    if (profile && profile.ok) return ['--cookies-from-browser', `chrome:${profile.dir}`]
    if (profile && !profile.ok) return { error: profile.error }
    if (opts.cookiesFromBrowser) return ['--cookies-from-browser', String(opts.cookiesFromBrowser)]
    return []
  }

  const cookieHint = () => {
    if (opts.cookiesFile) return `已配 cookiesFile=${opts.cookiesFile}`
    if (opts.cookiesFromBrowser) {
      return `正在用 --cookies-from-browser ${opts.cookiesFromBrowser}（Chrome 必须完全退出，否则会报 Could not copy Chrome cookie database）`
    }
    return '没配 cookie。两条路：① Chrome 装扩展 `Get cookies.txt LOCALLY` 导出 cookies.txt，路径填进 cookiesFile（推荐，不受 Chrome 运行状态影响）；② 配 cookiesFromBrowser: chrome，但要先完全退出 Chrome'
  }

  /**
   * 探元数据。失败也返回 {ok:false}，调用方决定要不要照样下载。
   *
   * ⚠️ 这里**也必须走 cookie 阶梯** —— 我一开始只给下载那步加了 cookie，
   * 结果抖音的探测失败 → `durationSec` 变 0 → 切段算出空方案 → 整段音频当一段喂进去
   * → `Invalid speech audio size`。**一个漏掉的 cookie 让另一个 bug 换了张脸出现。**
   */
  async function probe(url) {
    const site = (parseMediaUrl(url) || {}).site
    const exe = pickExecutable(opts.ytDlpPath, 'yt-dlp')
    const args = (withCookies) => ytArgs(site, ['--dump-single-json', '--skip-download', url], withCookies)
    let { code, stdout, stderr } = await runCommand(exe, args(false))
    if (code !== 0 && looksLikeCookieWall(`${stderr}\n${stdout}`)) {
      const retry = await runCommand(exe, args(true))
      code = retry.code
      stdout = retry.stdout
      stderr = retry.stderr
    }
    if (code !== 0) return { ok: false, error: (stderr || stdout).trim().split('\n').slice(-3).join(' ') }
    try {
      const json = JSON.parse(stdout.trim().split('\n').find((line) => line.trim().startsWith('{')) || '{}')
      const subs = Object.keys(json.subtitles || {})
      const auto = Object.keys(json.automatic_captions || {})
      return {
        ok: true,
        title: json.title || null,
        durationSec: Number(json.duration) || 0,
        uploader: json.uploader || json.channel || null,
        hasSubtitle: subs.length > 0,
        hasAutoCaption: auto.length > 0,
        subtitleLangs: subs,
      }
    } catch (error) {
      return { ok: false, error: `解析元数据失败：${(error && error.message) || error}` }
    }
  }

  /** 下载：优先抓字幕，拿回最终文件路径。 */
  async function download(item, signal) {
    const startedAt = Date.now() // 扫目录找产物时用它当分界：只要"这次下载之后新出现的"
    const prefix = safeFileName(item.title || item.site || 'media')
    const outTemplate = join(outputDir, `${prefix}.%(ext)s`)
    const buildArgs = (withCookies) =>
      ytArgs(
        item.site,
        [
      '--no-simulate',
      '--print',
      'after_move:filepath',
      '-o',
      outTemplate,
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      String(opts.subtitleLangs),
      '--convert-subs',
      'srt',
      '--retries',
      '5',
      '--fragment-retries',
      '10',
      item.url,
      ],
      withCookies,
    )
    const lines = []
    const exe = pickExecutable(opts.ytDlpPath, 'yt-dlp')
    const onLine = (line) => {
      lines.push(line)
      const percent = line.match(/\[download\]\s+([\d.]+)%/)
      if (percent) patchItem(item.id, { progress: Number(percent[1]) / 100, note: `下载 ${percent[1]}%` })
      else if (/\[ExtractAudio\]|\[Merger\]|\[Fixup/.test(line)) patchItem(item.id, { note: line.slice(0, 80) })
    }
    let { code, stdout, stderr } = await runCommand(exe, buildArgs(false), { signal, onLine })

    // Cookie 阶梯：先不带 cookie 跑；命中登录墙特征才带 cookie 重跑一次。
    // （抖音实测就是 `Fresh cookies (not necessarily logged in) are needed`。）
    if (code !== 0 && looksLikeCookieWall(`${stderr}\n${stdout}`)) {
      if (!opts.cookiesFile && !opts.cookiesFromBrowser) {
        const detail = (stderr || stdout).trim().split('\n').filter(Boolean).slice(-2).join(' | ')
        return { ok: false, error: `${detail}\n→ 这是登录墙，需要 cookie：${cookieHint()}` }
      }
      patchItem(item.id, { note: '命中登录墙，带 cookie 重试…', progress: 0 })
      const retry = await runCommand(exe, buildArgs(true), { signal, onLine })
      code = retry.code
      stdout = retry.stdout
      stderr = retry.stderr
    }
    if (code !== 0) {
      const detail = (stderr || stdout).trim().split('\n').filter(Boolean).slice(-4).join(' | ')
      return {
        ok: false,
        error: /could not copy chrome cookie database/i.test(detail)
          ? `${detail}\n→ Chrome 开着时 cookie 库被锁：先完全退出 Chrome，或改用 cookiesFile（导出式 cookies.txt 不受 Chrome 运行状态影响）`
          : detail,
      }
    }
    // 找下载产物。**不能只信 yt-dlp 打印的路径** —— 实测 `--print after_move:filepath`
    // 在这台机器上没给出可用路径（这个 bug 之前被"现成字幕"那条路提前 return 盖住了，
    // 一直没暴露）。也不能按"下载开始之后的新文件"过滤：yt-dlp 发现已下过会跳过
    // （`has already been downloaded`），mtime 是上一次的，一过滤就全没了。
    // 目录是我们自己的、maxConcurrent 默认 1，所以按前缀匹配、再退到最新文件就够。
    const printed = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('[') && existsSync(line))
    const isMedia = (name) => /\.(mp4|mkv|webm|mov|flv|m4a|mp3|opus|aac|wav|ts)$/i.test(name)
    let media = printed.reverse().find((path) => isMedia(path)) || null
    if (!media) {
      const candidates = findFiles(outputDir, isMedia)
        .map((path) => {
          try {
            return { path, mtime: statSync(path).mtimeMs, name: basename(path) }
          } catch {
            return null
          }
        })
        .filter(Boolean)
      // 先按前缀（yt-dlp 自己的文件名清洗规则和我的 safeFileName 不一定一致，
      // 所以这里只是"更精确的一档"）；不中就用目录里最新的媒体文件。
      const byPrefix = candidates.filter((row) => row.name.startsWith(prefix)).sort((a, b) => b.mtime - a.mtime)
      const chosen = byPrefix.length ? byPrefix[0] : candidates.sort((a, b) => b.mtime - a.mtime)[0]
      media = chosen ? chosen.path : null
      if (!media) {
        patchItem(item.id, {
          note: `没找到媒体文件；目录里有 ${candidates.length} 个媒体文件；yt-dlp 末尾：${(stdout || stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 100)}`,
        })
      }
    }
    const subs = findFiles(outputDir, (name) => name.startsWith(prefix) && /\.(srt|vtt)$/i.test(name))
    return { ok: true, media, subtitleFiles: subs, log: lines.slice(-3) }
  }

  /** ffmpeg 转 16kHz 单声道 PCM16 WAV；按 chunkSeconds 切段。 */
  async function toWavChunks(item, mediaPath, durationSec, signal) {
    const prefix = safeFileName(item.title || 'media')
    const limits = safeChunkSeconds()
    const chunks = chunkPlan(durationSec, limits.seconds)
    const plan = chunks.length ? chunks : [{ index: 0, start: 0, duration: 0 }]
    const outputs = []
    for (const chunk of plan) {
      const out = join(outputDir, `${prefix}.part${String(chunk.index).padStart(2, '0')}.wav`)
      const args = ['-hide_banner', '-loglevel', 'error', '-y']
      if (chunk.duration) args.push('-ss', String(chunk.start), '-t', String(chunk.duration))
      // ⚠️ 必须显式 pcm_s16le + `-fflags +bitexact -map_metadata -1`：
      // ffmpeg 默认会往 WAV 里塞一个 LIST/INFO/ISFT "Lavf…" 元数据 chunk，
      // 而官方 speechToText 校验的是**规范** 16kHz 单声道 PCM16 WAV —— 多那个 chunk 就报
      // "Invalid speech WAV"（实测：头里 fmt 完全正确，只有它是多余的）。
      args.push(
        '-i',
        mediaPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-acodec',
        'pcm_s16le',
        '-map_metadata',
        '-1',
        '-fflags',
        '+bitexact',
        '-f',
        'wav',
        out,
      )
      const { code, stderr } = await runCommand(pickExecutable(opts.ffmpegPath, 'ffmpeg'), args, { signal })
      if (code !== 0) return { ok: false, error: `ffmpeg 失败：${(stderr || '').trim().split('\n').slice(-2).join(' ')}` }
      outputs.push(out)
      patchItem(item.id, { note: `转码 ${outputs.length}/${plan.length} 段` })
    }
    return { ok: true, chunks: outputs }
  }

  /** 逐段转写（官方 API 是有界的，所以不一次喂整段）。 */
  async function transcribeChunks(item, wavFiles, signal) {
    const service = stt()
    if (!service) return { ok: false, error: 'speechToText 服务不可用' }
    const texts = []
    for (let index = 0; index < wavFiles.length; index += 1) {
      if (signal && signal.aborted) return { ok: false, error: '已取消' }
      const bytes = new Uint8Array(readFileSync(wavFiles[index]))
      let spec
      try {
        spec = service.resolve({
          audio: bytes,
          language: String(opts.transcribeLanguage || 'zh'),
        })
      } catch (error) {
        return { ok: false, error: `解析转写参数失败：${(error && error.message) || error}` }
      }
      try {
        const transcript = await service.transcribe(spec, signal)
        texts.push((transcript && transcript.text) || '')
        const seconds = transcript && transcript.audioSeconds ? ` (${Math.round(transcript.audioSeconds)}s)` : ''
        patchItem(item.id, { note: `转写 ${index + 1}/${wavFiles.length} 段${seconds}` })
      } catch (error) {
        return { ok: false, error: `转写失败（第 ${index + 1} 段）：${(error && error.message) || error}` }
      }
    }
    return { ok: true, text: joinTranscripts(texts) }
  }

  /** 一条的完整流水线。 */
  async function processItem(id) {
    if (running.has(id)) return
    running.add(id)
    const controller = new AbortController()
    aborts.set(id, controller)
    const signal = controller.signal
    try {
      const item = (stateStore.get().items || []).find((row) => row.id === id)
      if (!item) return
      patchItem(id, { status: 'probing', error: null, note: '解析链接…', progress: 0 })

      const meta = await probe(item.url)
      if (meta.ok) {
        patchItem(id, {
          title: item.title || meta.title || null,
          durationSec: meta.durationSec || item.durationSec || 0,
          uploader: meta.uploader || null,
          subtitleLangs: meta.subtitleLangs || [],
        })
      }

      patchItem(id, { status: 'downloading', note: '下载中…' })
      const got = await download({ ...item, title: (stateStore.get().items || []).find((r) => r.id === id)?.title || item.title }, signal)
      if (!got.ok) {
        patchItem(id, { status: 'error', error: got.error, note: null })
        return
      }
      patchItem(id, { mediaPath: got.media, note: null, progress: 1 })

      // ① 优先用现成字幕（零成本、最准）
      const subFile = opts.preferSubtitles ? pickSubtitleFile(got.subtitleFiles, opts.subtitleLangs) : null
      if (subFile) {
        const text = subtitleToText(readFileSync(subFile, 'utf8'))
        if (text.trim()) {
          patchItem(id, {
            status: 'done',
            transcript: text,
            transcriptSource: 'subtitle',
            subtitlePath: subFile,
            note: `用了现成字幕（${basename(subFile)}）`,
            chars: text.length,
          })
          return
        }
      }

      // ② 没字幕 → 转码 + 本地转写
      const sttInfo = sttStatus()
      if (!sttInfo.available) {
        patchItem(id, {
          status: 'done',
          transcriptSource: 'none',
          note: `没有现成字幕；${sttInfo.reason}`,
        })
        return
      }
      const current = (stateStore.get().items || []).find((row) => row.id === id) || {}
      if (!got.media) {
        patchItem(id, { status: 'error', error: '下载完成但没找到媒体文件', note: null })
        return
      }
      // 时长必须**准**：切段计划全靠它。探测失败（比如漏了 cookie）时 durationSec 是 0，
      // 切段会算出空方案、退化成"整段当一段"—— 于是又变成 Invalid speech audio size。
      // 所以这里用 ffprobe 就地量一遍真时长（本地、不联网、一定拿得到）。
      let duration = Number(current.durationSec) || 0
      if (!duration) {
        const probed = await ffprobeDuration(got.media)
        if (probed > 0) {
          duration = probed
          patchItem(id, { durationSec: probed })
        }
      }
      patchItem(id, { status: 'converting', note: '转 16kHz WAV…' })
      const wav = await toWavChunks(current, got.media, duration, signal)
      if (!wav.ok) {
        patchItem(id, { status: 'error', error: wav.error, note: null })
        return
      }
      patchItem(id, { status: 'transcribing', note: '本地转写中…', wavFiles: wav.chunks })
      const result = await transcribeChunks(current, wav.chunks, signal)
      if (!result.ok) {
        patchItem(id, { status: 'error', error: result.error, note: null })
        return
      }
      patchItem(id, {
        status: 'done',
        transcript: result.text,
        transcriptSource: 'stt',
        note: `本地转写完成（${wav.chunks.length} 段）`,
        chars: result.text.length,
      })
    } catch (error) {
      patchItem(id, { status: 'error', error: (error && error.message) || String(error), note: null })
    } finally {
      running.delete(id)
      aborts.delete(id)
      pump()
    }
  }

  /** 简单的并发控制。 */
  function pump() {
    const limit = Math.max(1, Number(opts.maxConcurrent) || 1)
    while (activeCount < limit && queue.length) {
      const id = queue.shift()
      activeCount += 1
      processItem(id).finally(() => {
        activeCount -= 1
        pump()
      })
    }
  }

  function enqueue(id) {
    const item = (stateStore.get().items || []).find((row) => row.id === id)
    if (!item || running.has(id) || queue.includes(id)) return
    patchItem(id, { status: 'queued', note: '排队中…', error: null })
    queue.push(id)
    pump()
  }

  function addUrl(input) {
    const parsed = parseMediaUrl(input)
    if (!parsed) return { ok: false, error: `认不出这是个链接：${String(input || '').slice(0, 60)}` }
    const item = {
      id: newId(),
      url: parsed.canonical,
      original: parsed.original,
      site: parsed.site,
      mediaId: parsed.id,
      title: null,
      durationSec: 0,
      status: 'added',
      progress: 0,
      note: null,
      transcript: null,
      transcriptSource: null,
      error: null,
      at: Date.now(),
    }
    const items = trim([item, ...(stateStore.get().items || [])])
    stateStore.patch({ items })
    enqueue(item.id)
    return { ok: true, item }
  }

  // ---------------------------------------------------------------- 工具
  ctx.inject(['tools'], (toolScoped) => {
    toolScoped.tools.register({
      name: 'media_panel',
      description:
        'DSH 右侧栏「媒体台」：把抖音/YouTube 等链接丢进来，本机 yt-dlp 下载、ffmpeg 转 16k WAV、官方 speechToText（SenseVoice）本地转写；字幕存进面板，Agent 可直接读原文做总结。' +
        'action=add 加一条（需要 url，会自动排队）；action=list 看队列与状态；action=read 读某条的字幕全文（需要 id，这是总结视频用的）；' +
        'action=status 看 STT 是否可用；action=retry 重跑（需要 id）；action=remove 删一条（需要 id）；action=clear 清空。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'read', 'status', 'retry', 'remove', 'clear'], description: '要做的动作。' },
          url: { type: 'string', description: 'add：视频链接（抖音分享短链也行）。' },
          id: { type: 'string', description: 'read/retry/remove：条目 id。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render(_args, value) {
          return [{ type: 'text', text: String((value && value.text) || '') }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `media_panel ${String((args && args.action) || 'list')}`.trim() }
      },
      async execute(args) {
        const action = String((args && args.action) || 'list').toLowerCase()
        const items = stateStore.get().items || []

        if (action === 'status') {
          const info = sttStatus()
          const limits = speechLimits()
          const chunk = safeChunkSeconds()
          return {
            text:
              `条目 ${items.length} 条（处理中 ${running.size}，排队 ${queue.length}）\n` +
              `官方上限：maxAudioBytes=${limits.maxAudioBytes || '（读不到）'} maxDurationSeconds=${limits.maxDurationSeconds || '（读不到）'} → 实际按 ${chunk.seconds} 秒切段\n` +
              `STT：${info.available ? '可用' : `不可用 —— ${info.reason}`}` +
              (info.selected ? `\n  选中：${info.selected.name}${info.selected.language ? ` · 语言 ${info.selected.language}` : ''}` : '') +
              (info.providers && info.providers.length
                ? `\n  providers：${info.providers.map((p) => `${p.id}(${p.location}, ${p.preparation})`).join('，')}`
                : '') +
              `\n工具：yt-dlp=${pickExecutable(opts.ytDlpPath, 'yt-dlp')}  ffmpeg=${pickExecutable(opts.ffmpegPath, 'ffmpeg')}\n产物目录：${outputDir}`,
          }
        }

        if (action === 'add') {
          const result = addUrl(args.url)
          if (!result.ok) return { text: result.error }
          return { text: `已加入：${result.item.site} ${result.item.url}\nid=${result.item.id}（已排队，用 action=list 看进度）` }
        }

        if (action === 'list') {
          if (!items.length) return { text: '队列是空的。用 action=add url=… 加一条。' }
          const label = { queued: '排队', probing: '解析', downloading: '下载', converting: '转码', transcribing: '转写', done: '完成', error: '出错', added: '已加入' }
          return {
            text: items
              .map((item) => {
                const dur = item.durationSec ? ` ${formatDuration(item.durationSec)}` : ''
                const src = item.transcriptSource === 'subtitle' ? '（字幕）' : item.transcriptSource === 'stt' ? '（本地转写）' : ''
                return (
                  `[${label[item.status] || item.status}] ${item.title || item.url}${dur}${src}\n` +
                  `  ${item.note || ''}${item.error ? ` ✗ ${item.error}` : ''}` +
                  `${item.transcript ? ` · 字幕 ${item.chars || item.transcript.length} 字` : ''}\n  id=${item.id}`
                )
              })
              .join('\n'),
          }
        }

        if (action === 'read') {
          const item = items.find((row) => row.id === String(args.id || ''))
          if (!item) return { text: `找不到 id=${args.id}` }
          if (!item.transcript) return { text: `这条还没有字幕（状态：${item.status}${item.error ? `，错误：${item.error}` : ''}）` }
          return {
            text:
              `# ${item.title || item.url}${item.durationSec ? `（${formatDuration(item.durationSec)}）` : ''}\n` +
              `来源：${item.transcriptSource === 'subtitle' ? '视频自带字幕' : '本地语音转写（SenseVoice）'} · ${item.transcript.length} 字\n\n` +
              item.transcript,
          }
        }

        if (action === 'retry') {
          const item = items.find((row) => row.id === String(args.id || ''))
          if (!item) return { text: `找不到 id=${args.id}` }
          patchItem(item.id, { status: 'added', error: null, transcript: null, transcriptSource: null, progress: 0 })
          enqueue(item.id)
          return { text: `已重新排队：${item.title || item.url}` }
        }

        if (action === 'remove') {
          const id = String(args.id || '')
          const item = items.find((row) => row.id === id)
          if (!item) return { text: `找不到 id=${id}` }
          const controller = aborts.get(id)
          if (controller) controller.abort()
          queue.splice(0, queue.length, ...queue.filter((row) => row !== id))
          stateStore.patch({ items: items.filter((row) => row.id !== id) })
          return { text: `已删：${item.title || item.url}` }
        }

        if (action === 'clear') {
          for (const controller of aborts.values()) controller.abort()
          queue.length = 0
          stateStore.patch({ items: [] })
          return { text: '队列已清空（磁盘上的产物没删）' }
        }

        return { text: `不认识的动作：${action}` }
      },
    })
  })

  // ---------------------------------------------------------------- 路由
  ctx.inject(['webServer'], (scoped) => {
    const disposers = []
    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          const headers = (req && req.headers) || {}
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end()
            return
          }
          if (method === 'GET' || method === 'HEAD') {
            const state = stateStore.get()
            sendJson(res, 200, {
              ok: true,
              items: state.items || [],
              pendingQuestion: state.pendingQuestion || null,
              stt: sttStatus(),
              running: [...running],
              queued: queue,
              outputDir,
            })
            return
          }
          if (method === 'POST') {
            let raw = ''
            req.on('data', (chunk) => {
              raw += chunk
              if (raw.length > 512 * 1024) req.destroy()
            })
            req.on('end', async () => {
              let body = {}
              try {
                body = raw.trim() ? JSON.parse(raw) : {}
              } catch {
                sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
                return
              }
              const action = String(body.action || '').toLowerCase()
              try {
                if (action === 'add') {
                  const result = addUrl(body.url)
                  sendJson(res, result.ok ? 200 : 400, { ok: result.ok, ...result, items: stateStore.get().items })
                  return
                }
                if (action === 'retry') {
                  const item = (stateStore.get().items || []).find((row) => row.id === body.id)
                  if (!item) {
                    sendJson(res, 404, { ok: false, error: '找不到这条' })
                    return
                  }
                  patchItem(item.id, { status: 'added', error: null, transcript: null, transcriptSource: null, progress: 0 })
                  enqueue(item.id)
                  sendJson(res, 200, { ok: true, items: stateStore.get().items })
                  return
                }
                if (action === 'remove') {
                  const controller = aborts.get(String(body.id))
                  if (controller) controller.abort()
                  stateStore.patch({ items: (stateStore.get().items || []).filter((row) => row.id !== body.id) })
                  sendJson(res, 200, { ok: true, items: stateStore.get().items })
                  return
                }
                if (action === 'clear') {
                  for (const controller of aborts.values()) controller.abort()
                  queue.length = 0
                  stateStore.patch({ items: [] })
                  sendJson(res, 200, { ok: true, items: [] })
                  return
                }
                if (action === 'openexternal') {
                  // 用系统浏览器打开。抖音/X 对嵌入的 webview 有反爬（实测点了会一直"加载中"），
                  // 所以这两个站点让它在真正的浏览器里跑，刷完复制链接回来扒字幕。
                  const url = String(body.url || '').trim()
                  if (!/^https?:\/\//i.test(url)) {
                    sendJson(res, 400, { ok: false, error: '只接受 http(s) 链接' })
                    return
                  }
                  const child = spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' })
                  child.unref()
                  sendJson(res, 200, { ok: true, opened: url })
                  return
                }
                if (action === 'ask') {
                  // 「让 Agent 总结」：把问题写进状态，右边聊天里我会看到
                  const item = (stateStore.get().items || []).find((row) => row.id === body.id)
                  const question = String(body.question || '').trim() || `帮我总结这个视频：${item ? item.title || item.url : body.id}`
                  stateStore.patch({ pendingQuestion: { question, itemId: body.id || null, at: Date.now() } })
                  sendJson(res, 200, { ok: true, pendingQuestion: stateStore.get().pendingQuestion })
                  return
                }
                if (action === 'prepareStt') {
                  const service = stt()
                  if (!service) {
                    sendJson(res, 400, { ok: false, error: 'speechToText 服务不可用' })
                    return
                  }
                  const snapshot = service.snapshot()
                  const providers = (snapshot && snapshot.providers) || []
                  const chosen = (snapshot && snapshot.selection && snapshot.selection.providerId) || (providers[0] && providers[0].id)
                  if (chosen) service.prepare(chosen)
                  sendJson(res, 200, { ok: true, stt: sttStatus() })
                  return
                }
                sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: (error && error.message) || String(error) })
              }
            })
            return
          }
          res.statusCode = 405
          res.end()
        },
      }),
    )

    ctx.on('dispose', () => {
      for (const controller of aborts.values()) {
        try {
          controller.abort()
        } catch {
          /* fine */
        }
      }
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* already gone */
        }
      }
    })
  })
}

export { apply, ROUTE_STATE, DEFAULTS }
