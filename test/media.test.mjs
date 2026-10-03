/**
 * URL 解析 / 时长 / 切段 / 字幕清洗的单元测试：
 *   node test/media.test.mjs
 */
import {
  parseMediaUrl,
  formatDuration,
  chunkPlan,
  pickSubtitleFile,
  subtitleToText,
  joinTranscripts,
  safeFileName,
} from '../lib/url.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`}`)
}

// --- 站点识别 ---
check('YouTube watch', parseMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').site, 'youtube')
check('YouTube watch 的 id', parseMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').id, 'dQw4w9WgXcQ')
check('YouTube 短链 youtu.be', parseMediaUrl('https://youtu.be/dQw4w9WgXcQ').id, 'dQw4w9WgXcQ')
check('YouTube Shorts', parseMediaUrl('https://www.youtube.com/shorts/abc123XYZ').id, 'abc123XYZ')
check('YouTube 带多余参数', parseMediaUrl('https://m.youtube.com/watch?v=abc123&t=42s').id, 'abc123')
check('规范成 watch 形式', parseMediaUrl('https://youtu.be/abc123').canonical, 'https://www.youtube.com/watch?v=abc123')
check('抖音分享短链', parseMediaUrl('https://v.douyin.com/iRNBho6/').site, 'douyin')
check('抖音短链没有 id（交给 yt-dlp 跟重定向）', parseMediaUrl('https://v.douyin.com/iRNBho6/').id, null)
check('抖音长链拿得到 id', parseMediaUrl('https://www.douyin.com/video/7123456789012345678').id, '7123456789012345678')
check('B 站 BV 号', parseMediaUrl('https://www.bilibili.com/video/BV1xx411c7mD').id, 'BV1xx411c7mD')
check('X 的 status', parseMediaUrl('https://x.com/someone/status/1234567890').id, '1234567890')
check('认不出的站点也不拒绝', parseMediaUrl('https://example.com/v/1').site, 'other')
check('没有 scheme 也能认', parseMediaUrl('youtu.be/abc123').site, 'youtube')
check('空串给 null', parseMediaUrl('   '), null)
check('垃圾串给 null', parseMediaUrl(':::::'), null)

// --- 时长 ---
check('一分钟内', formatDuration(59), '0:59')
check('十分零五秒', formatDuration(605), '10:05')
check('一小时', formatDuration(3725), '1:02:05')
check('负数不炸', formatDuration(-5), '0:00')

// --- 切段（官方转写 API 有界，长视频必须切） ---
const plan = chunkPlan(605, 240)
check('605 秒按 240 秒切成 3 段', plan.length, 3)
check('第一段', plan[0], { index: 0, start: 0, duration: 240 })
check('最后一段是余数', plan[2], { index: 2, start: 480, duration: 125 })
check('零时长不给段', chunkPlan(0, 240), [])
check('段长有下限（防止配成 1 秒）', chunkPlan(100, 1)[0].duration, 30)

// --- 字幕挑选 ---
const files = ['a.en.srt', 'a.zh-Hans.srt', 'a.ja.srt']
check('按优先级挑中文', pickSubtitleFile(files, 'zh-Hans,zh,en'), 'a.zh-Hans.srt')
check('没有首选语言就退到 en', pickSubtitleFile(['a.en.srt', 'a.ja.srt'], 'zh'), 'a.en.srt')
check('一个都没有给 null', pickSubtitleFile([], 'zh'), null)

// --- 字幕清洗 ---
const srt = ['1', '00:00:01,000 --> 00:00:03,000', '大家好', '', '2', '00:00:03,000 --> 00:00:05,000', '<i>大家好</i>', '', '3', '00:00:05,000 --> 00:00:07,000', '今天讲个事'].join('\n')
check('去掉序号和时间轴', subtitleToText(srt), '大家好\n今天讲个事')
check('去掉内联标签', subtitleToText('1\n00:00:01,000 --> 00:00:02,000\n<i>斜体</i>'), '斜体')
check('去掉 WEBVTT 头', subtitleToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n内容').includes('WEBVTT'), false)
check('去掉 {\an8} 之类', subtitleToText('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}顶部字幕').includes('顶部字幕'), true)

// --- 拼接与文件名 ---
check('多段拼接', joinTranscripts(['第一段', '', '第二段']), '第一段\n第二段')
check('全是空给空串', joinTranscripts(['', '  ']), '')
check('文件名安全化', safeFileName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i')
check('文件名空给兜底', safeFileName(''), 'media')
check('文件名截断', safeFileName('x'.repeat(200)).length, 80)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
