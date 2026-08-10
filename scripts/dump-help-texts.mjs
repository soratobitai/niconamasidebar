// 設定パネルの「?」の中身を doc へ書き出す。
// 🔴 手で書き写さないこと。実装からそのまま取り出す（写し間違いと、後の食い違いを避ける）。
import { readFileSync, writeFileSync } from 'node:fs'

const SB = 'src/render/sidebar.js'
const src = readFileSync(SB, 'utf8')

// optionHtml のテンプレートリテラルだけを対象にする
const a = src.indexOf('const optionHtml =')
const b = src.indexOf('</form>', a)
if (a < 0 || b < 0) { console.error('NG   optionHtml を切り出せない'); process.exit(1) }
const tpl = src.slice(a, b)

// 🔴 **正規表現1本で「見出し＋ヘルプ」を取ろうとしないこと。**
//    見出しは1行の時（ヘルプ無し）と複数行の時（ヘルプ有り）で形が違うので、
//    片方の形に合わせた正規表現はもう片方を取りこぼす。**取りこぼしても静かに減るだけ**で、
//    「この設定にはヘルプが無い」と誤って読める（2026-08-10 に「テーマ」が消えて気付いた）。
//    opt-label の開きから **div の入れ子を数えて**閉じを見つける、素直な走査にする。
function readLabelBlocks(html) {
    const out = []
    const open = /<div class="opt-label([^"]*)">/g
    let m
    while ((m = open.exec(html)) !== null) {
        let depth = 1
        let i = open.lastIndex
        while (depth > 0 && i < html.length) {
            const nextOpen = html.indexOf('<div', i)
            const nextClose = html.indexOf('</div>', i)
            if (nextClose < 0) break
            if (nextOpen >= 0 && nextOpen < nextClose) { depth++; i = nextOpen + 4 } else { depth--; i = nextClose + 6 }
        }
        out.push({ cls: m[1], body: html.slice(open.lastIndex, i - 6) })
    }
    return out
}

const blocks = readLabelBlocks(tpl)
const parsed = blocks.map(({ body }) => {
    const beta = (body.match(/<span class="opt-beta-badge">([^<]*)<\/span>/) || [])[1] || ''
    const tip = (body.match(/<span class="help-tooltip" role="tooltip">([\s\S]*?)<\/span><\/span>/) || [])[1] || ''
    // 見出しの文字＝最初のタグより前の地の文
    const label = body.split('<')[0].trim()
    return { label, beta, tip }
}).filter((x) => x.label)

const tips = parsed.filter((x) => x.tip).map((x) => [null, x.label, x.beta, x.tip])

if (!tips.length) { console.error('NG   ヘルプを1件も拾えない（空振り）'); process.exit(1) }
// 空振り防止: 設定の総数が極端に少なければ走査が壊れている
if (parsed.length < 8) { console.error(`NG   設定を ${parsed.length} 件しか拾えない（走査が壊れている）`); process.exit(1) }

// HTML を読みやすい Markdown へ
const toMd = (html) => html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const lines = []
lines.push('# 設定の「?」ヘルプ文')
lines.push('')
lines.push('サイドバーの設定パネルで「?」を押すと出る説明文を、**実装からそのまま書き出した**もの。')
lines.push('文面を直したい時はこのファイルを直接編集せず、**直したい箇所をこのファイルで指し示す**こと。')
lines.push('実体は `src/render/sidebar.js` の `optionHtml`（テンプレートリテラル）の中にある。')
lines.push('')
lines.push('🔴 **このファイルは手で書き写したものではない。** 書き出し直すには')
lines.push('`scripts/dump-help-texts.mjs` を使う（実装を変えたら再生成すること）。')
lines.push('')
lines.push('⚠️ 実体はテンプレートリテラルの中なので、**バッククォートを書くとビルドが落ちる。**')
lines.push('文面に記号を入れたい時は注意すること。改行は `<br>`、強調は `<b>…</b>`。')
lines.push('')
lines.push(`書き出し時点で ${tips.length} 件。`)
lines.push('')

for (const [, label, beta, tip] of tips) {
    lines.push(`## ${label}${beta ? `（${beta}）` : ''}`)
    lines.push('')
    lines.push(toMd(tip))
    lines.push('')
}

// 「?」を持たない設定も一覧に出す（説明が要るかの判断材料になる）
const without = parsed.filter((x) => !x.tip).map((x) => x.label)
if (without.length) {
    lines.push('---')
    lines.push('')
    lines.push('## 「?」が付いていない設定')
    lines.push('')
    lines.push('説明が要ると思うものがあれば言ってください。')
    lines.push('')
    for (const l of without) lines.push(`- ${l}`)
    lines.push('')
}

writeFileSync('doc/12-help-texts.md', lines.join('\n'))
console.log(`OK   doc/12-help-texts.md へ ${tips.length} 件（「?」無しの設定 ${without.length} 件も併記）`)
