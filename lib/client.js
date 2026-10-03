/**
 * Client half of dsh-media-dock —— 右侧栏的「媒体台」tab。
 *
 * ⚠️ 「打开抖音/YouTube」**不自己渲染 webview**：第三方渲染的 <webview> 能进 DOM、
 * 尺寸也对，但永远 attach 不上、白屏（实测）。正解是让官方 provider 承载内容 ——
 * `ctx.sidebarRight.openTab('browser', { params: { url } })`。
 * ⚠️ 整个模块包在 IIFE 里（DSH 把客户端插件拼成一个脚本，顶层 const 会撞名）。
 */

;(() => {
const TAB_KIND = 'media'
const TAB_ID = 'dsh-media-dock:media'
const ROUTE_STATE = '/dsh-media/state'

const SITES = [
  { key: 'youtube', label: '▶️ YouTube', url: 'https://www.youtube.com' },
  { key: 'douyin', label: '🎵 抖音', url: 'https://www.douyin.com' },
]

window.__ModuleLoader__.load({
  id: 'dsh-media-dock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary, #5a7cff)',
      warn: '#ffb020',
      err: '#ff5a4d',
      ok: '#3ddc84',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const STATUS = {
      added: { text: '已加入', tone: C.dim },
      queued: { text: '排队中', tone: C.dim },
      probing: { text: '解析中', tone: C.accent },
      downloading: { text: '下载中', tone: C.accent },
      converting: { text: '转码中', tone: C.warn },
      transcribing: { text: '转写中', tone: C.warn },
      done: { text: '完成', tone: C.ok },
      error: { text: '出错', tone: C.err },
    }

    function fmtDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const hh = Math.floor(total / 3600)
      const mm = Math.floor((total % 3600) / 60)
      const ss = total % 60
      const pad = (n) => String(n).padStart(2, '0')
      return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
    }

    function MediaPanel(props) {
      const [items, setItems] = React.useState([])
      const [stt, setStt] = React.useState(null)
      const [draft, setDraft] = React.useState('')
      const [selected, setSelected] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [sent, setSent] = React.useState(null)
      const [running, setRunning] = React.useState([])
      const revisionRef = React.useRef(-1)

      const pull = React.useCallback(() => {
        return fetch(ROUTE_STATE)
          .then((response) => response.json())
          .then((payload) => {
            if (!payload || !payload.ok) return
            setItems(payload.items || [])
            setStt(payload.stt || null)
            setRunning(payload.running || [])
            revisionRef.current = (payload.items || []).length
          })
          .catch(() => {})
      }, [])

      React.useEffect(() => {
        pull()
        const timer = setInterval(pull, 2000)
        return () => clearInterval(timer)
      }, [pull])

      // 选中的那条要跟着刷新（字幕是写完之后才有的）
      const current = selected ? items.find((row) => row.id === selected) || null : null

      const post = React.useCallback((body) => {
        setBusy(true)
        setError(null)
        return fetch(ROUTE_STATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then((response) => response.json())
          .then((payload) => {
            if (payload && payload.items) setItems(payload.items)
            if (payload && !payload.ok) setError(payload.error || '出错了')
            return payload
          })
          .catch((err) => {
            setError(String((err && err.message) || err))
            return null
          })
          .finally(() => {
            setBusy(false)
            pull()
          })
      }, [pull])

      const openSite = (url) => {
        // 交给官方 browser tab —— 第三方自己渲染 webview 是白屏（实测）
        try {
          const right = props && props.sidebarRight
          if (right && typeof right.openTab === 'function') {
            right.openTab('browser', { params: { url } })
            return
          }
        } catch {
          /* 落到下面兜底 */
        }
        // 兜底：新窗口打开（至少能看）
        window.open(url, '_blank', 'noopener')
      }

      const add = () => {
        const url = draft.trim()
        if (!url) return
        setDraft('')
        post({ action: 'add', url })
      }

      const askAgent = (item) => {
        post({
          action: 'ask',
          id: item.id,
          question: `帮我总结这个视频：${item.title || item.url}（字幕在 media_panel 里，id=${item.id}）`,
        }).then((payload) => {
          if (payload && payload.ok) setSent('已把问题交给对话 —— 切回左边看')
        })
      }

      const sttReady = stt && stt.available

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text } },
        // 顶栏
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12 } },
          h('span', { style: { fontWeight: 600 } }, '📺 媒体台'),
          h('span', { style: { width: 7, height: 7, borderRadius: 7, flex: 'none', background: sttReady ? C.ok : C.warn } }),
          h(
            'span',
            { style: { fontFamily: C.mono, fontSize: 10, color: sttReady ? C.dim : C.warn } },
            sttReady ? `STT ${(stt.selected && stt.selected.name) || '就绪'}` : 'STT 不可用（只能抓字幕）',
          ),
          running.length ? h('span', { style: { fontFamily: C.mono, fontSize: 10, color: C.accent } }, `处理中 ${running.length}`) : null,
          h('button', { type: 'button', onClick: pull, title: '刷新', style: { marginLeft: 'auto', ...btn() } }, busy ? '…' : '⟳'),
        ),
        // 打开站点 + 贴链接
        h(
          'div',
          { style: { padding: '8px 10px', borderBottom: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 7 } },
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            SITES.map((site) =>
              h('button', { key: site.key, type: 'button', onClick: () => openSite(site.url), style: btn() }, site.label),
            ),
            h('button', { type: 'button', onClick: () => openSite('https://x.com'), style: btn() }, '𝕏'),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6 } },
            h('input', {
              value: draft,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') add()
              },
              placeholder: '贴视频链接（抖音分享短链也行），回车加入',
              style: { flex: '1 1 auto', minWidth: 0, ...input() },
            }),
            h('button', { type: 'button', onClick: add, style: { ...btn(), padding: '2px 10px', flex: 'none' } }, '加入'),
          ),
        ),
        // 主体
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
          h(
            'div',
            { style: { width: 214, flex: 'none', borderRight: `1px solid ${C.border}`, overflow: 'auto', padding: '4px' } },
            items.length
              ? items.map((item) => {
                  const status = STATUS[item.status] || { text: item.status, tone: C.dim }
                  const active = item.status === 'downloading' || item.status === 'transcribing' || item.status === 'converting'
                  return h(
                    'div',
                    {
                      key: item.id,
                      onClick: () => setSelected(item.id),
                      style: {
                        padding: '5px 7px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        marginBottom: 3,
                        background: selected === item.id ? `color-mix(in srgb, ${C.accent} 18%, transparent)` : 'transparent',
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 5, alignItems: 'baseline', fontSize: 11.5 } },
                      h('span', { style: { color: status.tone, fontFamily: C.mono, fontSize: 9.5, flex: 'none' } }, status.text),
                      h(
                        'span',
                        { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        item.title || item.url,
                      ),
                      item.durationSec ? h('span', { style: { fontFamily: C.mono, fontSize: 9.5, color: C.dim, flex: 'none' } }, fmtDuration(item.durationSec)) : null,
                    ),
                    active || item.status === 'downloading'
                      ? h(
                          'div',
                          { style: { height: 2, borderRadius: 2, marginTop: 3, background: `color-mix(in srgb, ${C.accent} 18%, transparent)` } },
                          h('div', {
                            style: {
                              height: '100%',
                              width: `${Math.max(4, Math.round((item.progress || 0) * 100))}%`,
                              borderRadius: 2,
                              background: status.tone,
                            },
                          }),
                        )
                      : h(
                          'div',
                          { style: { fontSize: 10, color: item.error ? C.err : C.dim, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                          item.error || item.note || (item.transcript ? `${item.chars || item.transcript.length} 字` : ''),
                        ),
                  )
                })
              : h('div', { style: { padding: 12, fontSize: 11.5, color: C.dim } }, '还没有内容。上面点 YouTube/抖音，或直接贴链接。'),
          ),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto', padding: '10px 12px' } },
            current
              ? h(
                  'div',
                  null,
                  h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, current.title || current.url),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' } },
                    h(
                      'span',
                      { style: { fontFamily: C.mono, fontSize: 10.5, color: C.dim } },
                      `${current.site}${current.durationSec ? ` · ${fmtDuration(current.durationSec)}` : ''}` +
                        `${current.transcriptSource === 'subtitle' ? ' · 视频自带字幕' : current.transcriptSource === 'stt' ? ' · 本地转写' : ''}`,
                    ),
                    current.transcript
                      ? h('button', { type: 'button', onClick: () => askAgent(current), style: { ...btn(), borderColor: C.accent, color: C.accent } }, '让 Agent 总结')
                      : null,
                    current.status === 'error' ? h('button', { type: 'button', onClick: () => post({ action: 'retry', id: current.id }), style: btn() }, '重试') : null,
                    h('button', { type: 'button', onClick: () => post({ action: 'remove', id: current.id }).then(() => setSelected(null)), style: btn() }, '删除'),
                  ),
                  sent ? h('div', { style: { fontSize: 11, color: C.ok, marginBottom: 8 } }, sent) : null,
                  current.transcript
                    ? h('div', { style: { fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, current.transcript)
                    : h(
                        'div',
                        { style: { fontSize: 12, color: C.dim, lineHeight: 1.6 } },
                        current.status === 'error'
                          ? `出错：${current.error}`
                          : current.note || '处理中…（下载 → 转码 → 转写，长视频要等一会儿）',
                      ),
                )
              : h('div', { style: { fontSize: 11.5, color: C.dim } }, '左边点一条看字幕'),
          ),
        ),
        error ? h('div', { style: { flex: 'none', padding: '6px 12px', borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.err } }, error) : null,
      )
    }

    function btn() {
      return {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        fontSize: 11.5,
        padding: '1px 8px',
        cursor: 'pointer',
      }
    }

    function input() {
      return {
        background: 'transparent',
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        color: C.text,
        fontSize: 11.5,
        padding: '3px 6px',
        outline: 'none',
      }
    }

    function MediaBody(props) {
      return h(MediaPanel, props)
    }

    function MediaTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { 'aria-hidden': 'true' }, '📺'),
        h('span', null, '媒体台'),
      )
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        scoped.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => '媒体台',
          guide: [
            {
              id: TAB_KIND,
              kind: TAB_KIND,
              order: 150,
              title: () => '媒体台',
              description: () => '抖音/YouTube · 下载 · 本地转写 · 总结',
              icon: () => h('span', { style: { fontSize: 16 } }, '📺'),
            },
          ],
        })
      })
      ctx.inject(['slots'], (scoped) => {
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, (props) =>
            h(MediaPanel, { ...props, sidebarRight: ctx.get('sidebarRight') }),
          ),
        )
        scoped.slots.inject('sidebar.right.pane.tab.title', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, MediaTitle),
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
})()
