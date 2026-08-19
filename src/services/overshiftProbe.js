/**
 * 【一時的な診断】固定要素の位置直しが行き過ぎていないかを見張り、出た時だけ1行残す。
 *
 * 🔴 **これは調査用の使い捨てコード。原因が確定したら丸ごと消すこと**（doc/09 項目DC）。
 *    消す時は「このファイルを削除」＋「kickPage.js の呼び出し1行を削除」＋
 *    「verify-sidebar-loop.mjs の overshiftProbeGroup を削除」の3箇所。
 *
 * ## 何を追っているか
 *
 * kick.com でレイドのモーダルが出た時に、**背景のコンテンツが帯の幅ぶん余計に右へ寄る**
 * という報告があった（2026-08-19）。読みで辿った筋は次のとおり。
 *
 *   `position: fixed` は普段ビューポート基準だが、祖先に `transform` / `filter` /
 *   `backdrop-filter` / `perspective` / `contain` があると**その祖先が基準になる。**
 *   こちらは kickPage.css で暗幕（親）に `left: 帯幅` を当てている。親が基準を作っていると、
 *   その中の要素に当てた `left: 帯幅` は**親の中での帯幅**になり、画面上は 2×帯幅 になる。
 *
 * ⚠️ **これはまだ仮説。** だからこの診断は仮説に寄せず、2方向から見る。
 *
 *   ① 原因側 … こちらの CSS が当たる要素に、基準を作る祖先がいるか
 *   ② 症状側 … こちらが位置を決めた要素が、決めたはずの場所にいるか
 *
 *   ①が出れば仮説どおり。①が空で②だけ出たら**仮説が外れている**ので、②の中身から出直す。
 *
 * ## 出し方の約束（doc/10）
 *
 * - 利用者にコマンドを打たせない。**自動で見張り、出た時だけ console に出す。**
 * - 同じ形は1回しか出さない。定期実行から呼ばれるので、抑えないと 500ms ごとに流れる。
 * - 例外を外へ出さない。診断でページを壊さない。
 */

/** こちらが CSS で位置を当てている2本。**kickPage.css と文字列を揃えること**（検証で固定）。 */
export const RULE_INSET0_SELECTOR = '[class~="fixed"][class~="inset-0"]'
export const RULE_CENTER_SELECTOR = '[class~="fixed"][class*="left-[50%]"]'

/** この幅までのズレは見逃す。小数の丸めや 1px の枠で鳴らないため。 */
export const PROBE_TOLERANCE_PX = 8

/** 1ページで出す上限。溢れさせない。 */
const MAX_REPORTS = 6

/** 祖先をたどる上限。深いページでも走査量を頭打ちにする。 */
const MAX_DEPTH = 40

/** クラス名は長いので切る。 */
const MAX_CLASS_CHARS = 200

/** 既に出した形。同じものを繰り返さない。 */
const reported = new Set()
let reportCount = 0
let announced = false

/** 検証用。出した回数と記憶を戻す。 */
export function resetProbe() {
    reported.clear()
    reportCount = 0
    announced = false
}

/**
 * この要素が、子孫の `position: fixed` の基準（包含ブロック）を作るか。
 *
 * 🔴 **`transform` だけではない。** ここを絞りすぎると、原因の要素を見逃して
 *    「①が空 ＝ 仮説が外れ」と誤って読むことになる。仕様で基準を作るものを全部見る。
 * ⚠️ `contain` は `paint` / `layout` / `strict` / `content` が該当。`size` だけは作らない。
 *
 * @returns {string[]} 該当した理由。空なら基準を作らない。
 */
export function containingBlockReasons(cs) {
    const out = []
    if (!cs) return out
    const has = (v) => typeof v === 'string' && v !== '' && v !== 'none'
    if (has(cs.transform)) out.push('transform')
    if (has(cs.perspective)) out.push('perspective')
    if (has(cs.filter)) out.push('filter')
    if (has(cs.backdropFilter) || has(cs.webkitBackdropFilter)) out.push('backdrop-filter')
    if (typeof cs.contain === 'string' && /\b(paint|layout|strict|content)\b/.test(cs.contain)) {
        out.push('contain:' + cs.contain)
    }
    // ⚠️ `will-change` は**予告だけで**基準を作る。実際の値が none でも該当する。
    if (typeof cs.willChange === 'string' && /\b(transform|perspective|filter)\b/.test(cs.willChange)) {
        out.push('will-change:' + cs.willChange)
    }
    return out
}

/**
 * ② 症状側の判定。**DOM を触らないので数値だけで検証できる。**
 *
 * こちらが位置を決めた要素は、決めたはずの場所にいるはず。ずれていれば返す。
 *
 * @param {string} kind 'body' | 'inset0' | 'nudged' | 'center'
 * @returns {null | {expected: number, actual: number, delta: number}}
 */
export function checkPlacement(kind, { reserved, viewportWidth, rect }) {
    if (!(reserved > 0) || !rect) return null

    // 中央寄せは「可視領域の中心に、中心が来る」。左端ではなく中心で見る
    // （`translate-x-[-50%]` のぶん、左端は幅によって変わるため）。
    if (kind === 'center') {
        if (!(viewportWidth > reserved)) return null
        const expected = reserved + (viewportWidth - reserved) / 2
        const actual = rect.left + rect.width / 2
        const delta = actual - expected
        return Math.abs(delta) > PROBE_TOLERANCE_PX ? { expected, actual, delta } : null
    }

    // 残りは全部「左端が帯の右端に来る」。
    //   body    … applyShift() の margin-left
    //   inset0  … kickPage.css の left
    //   nudged  … nudgeFixedOverlays() の margin-left
    const expected = reserved
    const actual = rect.left
    const delta = actual - expected
    return Math.abs(delta) > PROBE_TOLERANCE_PX ? { expected, actual, delta } : null
}

function clip(s) {
    const t = typeof s === 'string' ? s : ''
    return t.length > MAX_CLASS_CHARS ? t.slice(0, MAX_CLASS_CHARS) + '…' : t
}

function describe(el, win) {
    let rect = null
    let cs = null
    try { rect = el.getBoundingClientRect() } catch (e) { /* 測れなければ null のまま */ }
    try { cs = win.getComputedStyle(el) } catch (e) { /* 同上 */ }
    return {
        tag: el.tagName || '?',
        id: el.id || '',
        cls: clip(typeof el.className === 'string' ? el.className : ''),
        pos: cs ? cs.position : '?',
        // 🔴 **インラインの margin-left も出す。** こちらが押した量と CSS の left を
        //    後から見分けられないと、どちらが犯人か決まらない。
        inlineMarginLeft: (el.style && el.style.marginLeft) || '',
        inlineLeft: (el.style && el.style.left) || '',
        cssLeft: cs ? cs.left : '?',
        left: rect ? Math.round(rect.left) : null,
        top: rect ? Math.round(rect.top) : null,
        w: rect ? Math.round(rect.width) : null,
        h: rect ? Math.round(rect.height) : null,
    }
}

/**
 * 祖先をさかのぼって、基準を作っているものを全部拾う。
 * @returns {Array} body 側から順の一覧。`cb` が付いているものが基準を作っている。
 */
export function ancestorChain(el, win) {
    const chain = []
    let cur = el && el.parentElement
    let depth = 0
    while (cur && depth < MAX_DEPTH) {
        let cs = null
        try { cs = win.getComputedStyle(cur) } catch (e) { /* 読めなければ理由なし扱い */ }
        const cb = containingBlockReasons(cs)
        chain.push({ ...describe(cur, win), cb })
        cur = cur.parentElement
        depth++
    }
    return chain.reverse()
}

/**
 * 1周期ぶん。ずれていれば1回だけ出す。
 *
 * ⚠️ 呼び出し元（kickPage.js の定期の突き合わせ）は既に `extensionAlive()` を見ている。
 * @returns {number} この回に出した件数（検証用）
 */
export function probeOvershift(reserved, {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    sidebarRootId = 'niconamasidebar-kick-root',
    log = null,
} = {}) {
    if (!doc || !win) return 0
    if (!(reserved > 0)) return 0
    if (doc.hidden) return 0
    if (doc.fullscreenElement) return 0
    if (reportCount >= MAX_REPORTS) return 0

    const say = log || ((...a) => { try { console.warn(...a) } catch (e) { /* 出せなくてもよい */ } })

    // 🔴 **見張っていることを1回だけ知らせる。**
    //    これが無いと、レイドで何も出なかった時に「ずれなかった」のか
    //    「診断が載っていなかった」のかが**区別できない。** 無音の結果を読めるようにするための1行。
    //    ⚠️ 1ページ読み込みにつき1回だけ。定期の突き合わせから呼ばれるので抑えないと流れ続ける。
    if (!announced) {
        announced = true
        say('[ニコ生サイドバー 診断DC] 見張りを開始しました。'
            + 'レイドのモーダルでレイアウトがずれた時だけ、もう1行出ます。')
    }

    const viewportWidth = win.innerWidth || 0
    const findings = []

    const push = (kind, el, placement, cb) => {
        // 同じ形は1回だけ。位置は 20px 刻みに丸めて、1px の揺れで別物にしない。
        const info = describe(el, win)
        const sig = [kind, info.tag, info.cls, Math.round((info.left || 0) / 20)].join('|')
        if (reported.has(sig)) return
        reported.add(sig)
        const chain = ancestorChain(el, win)
        findings.push({
            kind,
            // 原因側: 基準を作っている祖先（無ければ空）
            containingBlock: cb && cb.length ? cb : chain.filter((a) => a.cb.length).map((a) => ({
                tag: a.tag, cls: a.cls, pos: a.pos, cb: a.cb, left: a.left, w: a.w,
            })),
            placement: placement
                ? { expected: Math.round(placement.expected), actual: Math.round(placement.actual), delta: Math.round(placement.delta) }
                : null,
            el: info,
            chain,
        })
    }

    // ── ② 症状側: body そのもの。ここがずれていれば、固定要素の話ではない。
    try {
        const bodyRect = doc.body && doc.body.getBoundingClientRect()
        const bad = checkPlacement('body', { reserved, viewportWidth, rect: bodyRect })
        if (bad) push('body', doc.body, bad, [])
    } catch (e) { /* 診断で本体を止めない */ }

    // ── こちらが位置を当てている要素を集める。
    // 🔴 **document 全体を毎周期走査しないこと。** portal は body の浅いところに出るので、
    //    そこだけ見る。深い場所に出たものは押し出し側（data-nns-nudge）で拾える。
    const targets = new Set()
    const addShallow = (root, depth) => {
        if (!root || !root.children || depth > 3) return
        for (const child of root.children) {
            targets.add(child)
            addShallow(child, depth + 1)
        }
    }
    try { addShallow(doc.body, 1) } catch (e) { /* 集められなければそこまで */ }
    try {
        for (const el of doc.querySelectorAll('[data-nns-nudge]')) targets.add(el)
    } catch (e) { /* 同上 */ }

    for (const el of targets) {
        try {
            if (!el || el.nodeType !== 1) continue
            if (el.id === sidebarRootId) continue
            if (typeof el.closest === 'function' && el.closest('#' + sidebarRootId)) continue

            const rect = el.getBoundingClientRect()
            // 小さいものは見ない。バッジやヘアラインで鳴らせない。
            if (!rect || rect.width < 60 || rect.height < 24) continue

            const isInset0 = typeof el.matches === 'function' && el.matches(RULE_INSET0_SELECTOR)
            const isCenter = typeof el.matches === 'function' && el.matches(RULE_CENTER_SELECTOR)
            const isNudged = typeof el.hasAttribute === 'function' && el.hasAttribute('data-nns-nudge')
            if (!isInset0 && !isCenter && !isNudged) continue

            // ── ① 原因側: 基準を作る祖先がいるか。**ずれていなくても記録する。**
            //    ずれる前に形が分かれば、それだけで直し方が決まる。
            const chain = ancestorChain(el, win)
            const cb = chain.filter((a) => a.cb.length).map((a) => ({
                tag: a.tag, cls: a.cls, pos: a.pos, cb: a.cb, left: a.left, w: a.w,
            }))

            // ── ② 症状側
            const kind = isInset0 ? 'inset0' : (isCenter ? 'center' : 'nudged')
            const bad = checkPlacement(kind, { reserved, viewportWidth, rect })

            if (cb.length || bad) push(kind, el, bad, cb)
        } catch (e) { /* 1件失敗しても残りを見る */ }
    }

    if (!findings.length) return 0

    reportCount++
    const payload = {
        版: '診断DC',
        帯幅: reserved,
        画面幅: viewportWidth,
        URL: (() => { try { return String(win.location && win.location.pathname) } catch (e) { return '?' } })(),
        件: findings,
    }
    say(
        '[ニコ生サイドバー 診断DC] 固定要素の位置ずれを検出しました。'
        + 'この行を丸ごとコピーして開発者へ渡してください。\n'
        + JSON.stringify(payload)
    )
    return findings.length
}
