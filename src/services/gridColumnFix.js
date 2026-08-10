/**
 * 【カードの列数を、ウィンドウ幅ではなく「実際に使える幅」で決め直す】
 *
 * 🔴 **これは3種類目の問題**（doc/09 項目BZ）。
 *      `w-xvw` の読み替え → **幅**を主張する要素に効く
 *      実測して押す（BY）  → `position: fixed` の**位置**に効く
 *      ここ                → **メディアクエリ**。ビューポート幅で効くので body を狭めても変わらない
 *    そのため列数が減らず、器だけ狭くなってカードが痩せる。
 *    実測（2026-08-08・/following・画面幅1920・サイドバー702）:
 *      器 1078px に **7列** = 1枚 140px。拡張が無ければ器 1780px で 1枚 240px。
 *
 * 🔴 **クラス名を自分で解釈しないこと。** 実測で Kick は `3xl:` という独自の折り返し点と
 *    `group-data-[sidebar=false]/main:` という条件を使っていた。Tailwind 既定の表で予測すると
 *    「5列」となり、**実際の7列と食い違う。** 既定値を当てにした時点で間違える。
 *    代わりに **Kick の CSS そのもの**から「この要素に効く `grid-template-columns` の指定と、
 *    それを囲む `@media (min-width: …)`」を集める。独自の折り返し点も条件も向こうの定義で解決される。
 *
 * 🔴 **理解できたことを毎回確かめてから当てる。** 集めた表で「今の画面幅なら何列か」を出し、
 *    **実際に適用されている列数と一致しなければ何もしない。** 一致して初めて、
 *    同じ表を「使える幅」で引き直した値を当てる。
 */

/** 当てた列数を記録する属性。**これが無い要素の grid-template-columns は触らない。** */
export const GRID_ATTR = 'data-nns-grid'

/** これより狭い器は相手にしない（カードの並びではない）。 */
const MIN_CONTAINER_W = 300

/**
 * 本来の大きさに対して、ここまでの痩せは許す（実測からの推定でのみ使う）。
 * 🔴 1.0 に近づけるほど、わずかな差で列数が動いてガタつく。
 */
const SHRINK_TOLERANCE = 0.9

/**
 * `repeat(4, minmax(0, 1fr))` のような指定から列数を読む。
 * ⚠️ `repeat()` 以外（px の並びや `auto-fill`）は**読まない**。auto-fill は本来こちらの
 *    出番が無い（勝手に減る）し、px 並びを列数に読み替えると意味が変わる。
 */
export function columnsOf(value) {
    const m = /^\s*repeat\(\s*(\d+)\s*,/.exec(String(value || ''))
    return m ? Number(m[1]) : null
}

/** `(min-width: 1600px)` / `(min-width: 100rem)` から px を読む。無ければ 0（＝常に効く）。 */
export function minWidthOf(conditionText, rootFontSize = 16) {
    const px = /min-width:\s*(\d+(?:\.\d+)?)px/.exec(String(conditionText || ''))
    if (px) return Number(px[1])
    const rem = /min-width:\s*(\d+(?:\.\d+)?)rem/.exec(String(conditionText || ''))
    if (rem) return Number(rem[1]) * rootFontSize
    return 0
}

/**
 * ある幅の時に効く列数を選ぶ。
 * ⚠️ 同じ折り返し幅が複数あったら**後に書かれたほうが勝つ**（CSS の順序どおり）。
 * @param {{min:number, cols:number, index:number}[]} entries
 */
export function pickColumns(entries, width) {
    let best = null
    for (const e of entries) {
        if (e.min > width) continue
        if (!best || e.min > best.min || (e.min === best.min && e.index > best.index)) best = e
    }
    return best ? best.cols : null
}

/**
 * この要素に効きうる「列数の指定」を Kick の CSS から集める。
 *
 * ⚠️ `el.matches(セレクタ)` で判定するので、`group-data-[sidebar=false]/main:` のような
 *    こちらが解釈できない条件も**ブラウザが正しく評価してくれる。**
 * ⚠️ 別オリジンのスタイルシートは `cssRules` が例外を投げる。黙って飛ばす（触らない側に倒れる）。
 */
export function collectColumnRules(el, doc, rootFontSize = 16, stats = null) {
    const entries = []
    let index = 0
    const count = stats || {}
    count.sheets = 0; count.readable = 0; count.blocked = 0; count.rules = 0; count.withCols = 0
    let sheets = []
    try { sheets = [...doc.styleSheets] } catch (e) { return entries }
    // ⚠️ `adoptedStyleSheets` は `styleSheets` に入らない。入れ忘れると丸ごと見落とす。
    try { if (doc.adoptedStyleSheets) sheets = sheets.concat([...doc.adoptedStyleSheets]) } catch (e) { /* 無ければ無視 */ }
    count.sheets = sheets.length

    for (const sheet of sheets) {
        let rules
        try { rules = sheet.cssRules } catch (e) { count.blocked++; continue } // 別オリジン
        if (!rules) { count.blocked++; continue }
        count.readable++
        walk(rules, 0)
    }
    count.matched = entries.length
    return entries

    function walk(rules, mediaMin) {
        for (const rule of rules) {
            index++
            count.rules++
            // @media など、中に規則を持つもの
            if (rule.cssRules) {
                const min = Math.max(mediaMin, minWidthOf(rule.conditionText || rule.media?.mediaText, rootFontSize))
                walk(rule.cssRules, min)
                continue
            }
            const value = rule.style && rule.style.gridTemplateColumns
            if (!value) continue
            const cols = columnsOf(value)
            if (cols === null) continue
            count.withCols++
            let hit = false
            try { hit = el.matches(rule.selectorText) } catch (e) { continue } // 読めないセレクタ
            if (!hit) continue
            entries.push({ min: mediaMin, cols, index })
        }
    }
}

/**
 * 【CSS が読めない時の逃げ道】実測だけから列数を決める。
 *
 * 🔴 実機で **`document.styleSheets` から規則を読めなかった**（2026-08-08）。
 *    別オリジン配信などで `cssRules` に触れないことがある。**読めない環境でも直せる道が要る。**
 *
 * 考え方: いま器は `containerWidth`。拡張が無ければ `containerWidth + reserved` あったはず。
 * そこに Kick 自身が選んだ `observed` 列を並べた時の1枚の幅が「本来の大きさ」。
 * 今の器にその大きさで何枚入るかを数える。
 *
 * ⚠️ **器が「使える幅いっぱいに広がる」前提。** `max-width` で頭打ちになっていると
 *    `+ reserved` が過大になる。実測では `maxWidth=none` だった。
 * ⚠️ 列を**増やす方向には動かさない**（Kick の判断より詰め込まない）。
 */
export function planFromMeasurement({ containerWidth, gap = 0, reserved }, observed) {
    if (!(containerWidth > 0) || !(observed > 0) || !(reserved > 0)) return null
    const naturalWidth = containerWidth + reserved
    const naturalCard = (naturalWidth - (observed - 1) * gap) / observed
    if (!(naturalCard > 0)) return null

    // 🔴 **わずかな痩せで列を落とさないこと。** 割り算だけで決めると、本来より数px 狭いだけで
    //    1列減らしてしまい、**カードが本来より大きくなる**（そちらのほうが見た目が変わる）。
    //    サイドバーを細くした時に列数がガタガタ動く原因にもなる。
    const currentCard = (containerWidth - (observed - 1) * gap) / observed
    if (currentCard >= naturalCard * SHRINK_TOLERANCE) return null

    // ⚠️ **列が増えることはない**ので、上限で挟む必要は無い（挟んでも結果が変わらず、死んだコードになる）。
    //    `containerWidth + gap = observed × (currentCard + gap)` がちょうど成り立ち、
    //    `reserved > 0` なら必ず `naturalCard > currentCard` なので、`fit < observed` が保証される。
    //    下限だけは要る（器が本来のカード1枚より狭いと 0 になる）。
    const fit = Math.floor((containerWidth + gap) / (naturalCard + gap))
    const target = Math.max(1, fit)
    return target === observed ? null : target
}

/**
 * 当てるべき列数を決める。**DOM を触らないので検証から数値だけで呼べる。**
 *
 * @returns {{target:number|null, reason:string}}
 *   target が null なら**何もしない**（理解できていないか、変える必要が無い）。
 */
export function planGridColumns({ entries, observed, viewportWidth, effectiveWidth, measured = null }) {
    // ── ① CSS から読めるなら、そちらが正確（Kick 独自の折り返し点も条件もそのまま効く）
    const why = cssPlan()
    if (why.target !== null) return why

    // ── ② 読めない／読み違えた時は実測から推定する。
    //    🔴 **「変える必要が無い」だけは逃げ道へ回さない。** あれは正しく読めた上での結論なので、
    //       推定で上書きすると、触らなくてよい相手を動かしてしまう。
        if (why.reason === '変える必要が無い') return why
    if (measured) {
        const target = planFromMeasurement(measured, observed)
        if (target !== null) return { target, reason: `実測から推定（${why.reason}）${observed}列 → ${target}列` }
    }
    return why

    function cssPlan() {
        if (!entries || !entries.length) return { target: null, reason: 'CSS から列数の指定を読めない' }
        // 🔴 **答え合わせ。** 今の画面幅で出した答えが、実際に効いている列数と合っているか。
        //    合っていなければ、こちらの読み方がこの要素には通用していない。
        const atViewport = pickColumns(entries, viewportWidth)
        if (atViewport === null) return { target: null, reason: '画面幅で効く指定が無い' }
        if (atViewport !== observed) {
            return { target: null, reason: `読み違い（予測${atViewport}列 / 実際${observed}列）` }
        }
        const atEffective = pickColumns(entries, effectiveWidth)
        if (atEffective === null) return { target: null, reason: '使える幅で効く指定が無い' }
        if (atEffective === observed) return { target: null, reason: '変える必要が無い' }
        return { target: atEffective, reason: `CSS から（${observed}列 → ${atEffective}列）` }
    }
}

/** 今こちらが列数を当てている要素。連携を切る時に戻すため覚えておく。 */
const fixed = new Map() // el -> { cls, entries }

/** こちらが当てた指定を戻す。**印がある時だけ。** */
function clearOne(el) {
    if (!el || !el.style) return
    if (typeof el.hasAttribute === 'function' && !el.hasAttribute(GRID_ATTR)) return
    el.style.removeProperty('grid-template-columns')
    if (typeof el.removeAttribute === 'function') el.removeAttribute(GRID_ATTR)
}

/** 全部戻す。連携を切る時に呼ぶ。 */
export function clearAllGridFixes() {
    for (const el of fixed.keys()) clearOne(el)
    fixed.clear()
}

/** 検証用。今いくつ当てているか。 */
export function gridFixCount() {
    return fixed.size
}

/**
 * カードの並びを探して、列数を当て直す。
 *
 * ⚠️ 探すのは Kick 固有名ではなく汎用のユーティリティ名（`grid-cols-`）。
 * @returns {number} この回に書き換えた要素の数（検証用）
 */
export function applyGridColumnFix(reserved, {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    sidebarRootId = 'niconamasidebar-kick-root',
    onFix = null, // 当てた時の通知（診断用）。**この本体からは console へ出さない。**
} = {}) {
    if (!doc || !win) return 0
    if (!(reserved > 0)) { clearAllGridFixes(); return 0 }

    const viewportWidth = win.innerWidth || 0
    const effectiveWidth = viewportWidth - reserved
    if (!(effectiveWidth > 0)) return 0
    const rootFontSize = Number.parseFloat(
        win.getComputedStyle(doc.documentElement).fontSize,
    ) || 16

    let nodes = []
    try { nodes = [...doc.querySelectorAll('[class*="grid-cols-"]')] } catch (e) { return 0 }

    let acted = 0
    const seen = new Set()
    for (const el of nodes) {
        if (typeof el.closest === 'function' && el.closest('#' + sidebarRootId)) continue
        let cs
        try { cs = win.getComputedStyle(el) } catch (e) { continue }
        if (cs.display !== 'grid' && cs.display !== 'inline-grid') continue
        let rect
        try { rect = el.getBoundingClientRect() } catch (e) { continue }
        if (rect.width < MIN_CONTAINER_W) continue
        seen.add(el)

        const cls = typeof el.className === 'string' ? el.className : ''
        const cached = fixed.get(el)

        // 🔴 **答え合わせは「こちらが当てていない状態」でしかできない。**
        //    当てた後の computed はこちらの値なので、比べても意味が無い。
        //    クラスが変わった（＝Kick が状態を切り替えた）時は、いったん外して測り直す。
        const gap = Number.parseFloat(cs.columnGap) || 0
        if (cached && cached.cls === cls) {
            // 🔴 **Kick 自身と同じ答えになるなら、指定ごと外す。**
            //    同じ値を当て続けると列数を固定してしまい、向こうの CSS が変わっても追従しない。
            //    「余計なことをしない」を、書かないことで守る。
            const atEffective = cached.entries.length
                ? pickColumns(cached.entries, effectiveWidth)
                : planFromMeasurement({ containerWidth: rect.width, gap, reserved }, cached.observed)
            const atViewport = cached.entries.length ? pickColumns(cached.entries, viewportWidth) : cached.observed
            if (atEffective === null || atEffective === atViewport) {
                clearOne(el)
                fixed.delete(el)
            } else {
                applyOne(el, atEffective)
            }
            continue
        }
        clearOne(el)

        // 外した直後の実測。ここが Kick 本来の列数。
        let observed
        try {
            observed = (win.getComputedStyle(el).gridTemplateColumns || '')
                .trim().split(/\s+/).filter(Boolean).length
        } catch (e) { continue }
        if (observed < 1) continue

        const stats = {}
        const entries = collectColumnRules(el, doc, rootFontSize, stats)
        const { target, reason } = planGridColumns({
            entries, observed, viewportWidth, effectiveWidth,
            measured: { containerWidth: rect.width, gap, reserved },
        })
        fixed.set(el, { cls, entries, observed })
        if (target === null) { fixed.delete(el); if (onFix) safeCall(onFix, el, null, reason, observed, stats); continue }

        applyOne(el, target)
        acted++
        if (onFix) safeCall(onFix, el, target, reason, observed, stats)
    }

    // 消えた・対象外になったものを戻す。
    for (const el of [...fixed.keys()]) {
        if (seen.has(el)) continue
        clearOne(el)
        fixed.delete(el)
    }
    return acted

    function applyOne(node, cols) {
        node.style.setProperty('grid-template-columns', `repeat(${cols}, minmax(0, 1fr))`, 'important')
        node.setAttribute(GRID_ATTR, String(cols))
    }
    function safeCall(fn, ...args) {
        try { fn(...args) } catch (e) { /* 診断で本体を止めない */ }
    }
}
