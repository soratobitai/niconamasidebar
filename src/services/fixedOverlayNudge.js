/**
 * 【サイドバーの帯に潜り込む `position: fixed` 要素を、実測して右へ押す】
 *
 * 🔴 **なぜ CSS だけでは足りないのか。**
 *    `position: fixed` はビューポート基準なので、`body` に `margin-left` を当てても届かない。
 *    そのため Kick のモーダル・番組視聴中の小窓などがサイドバーの下に隠れる。
 *    これまではクラス名ごとに CSS を1本ずつ足していたが（`kickPage.css` の `fixed inset-0` /
 *    `left-[50%]`）、**新しい固定要素が出るたびに増える。**
 *    ここは「隠れているかどうか」を実測して押すので、**クラス名を知らなくてよい。**
 *
 * 🔴 **包含ブロックを作る方式（`body` に `transform` / `contain`）は採れない。**
 *    1行で全部直る代わりに、**固定要素がページと一緒にスクロールするようになる。**
 *    スクロールした先でモーダルを開くと画面の外に描かれる。フォローページは縦に長いので必ず踏む。
 *    （2026-08-04 に `transform` を計測して外した記録が doc/09 にあるが、
 *      仮にあれが動いていたとしても、この理由で不採用。）
 *
 * ⚠️ **`left` ではなく `margin-left` で押す。** どの寄せ方をしていても「右へ N だけずらす」に
 *    なるため、`left-0` / `inset-0` / `left-4` / `left-[50%]` を区別しなくてよい。
 *      - `left:0; right:0`（引き伸ばし）→ 幅が N 縮んで左端が N になる（望みどおり）
 *      - `left:0; width:固定`          → そのまま N 右へ動く
 *      - `left:auto; right:0`（右寄せ）→ auto の left が吸収して**見た目は変わらない**（触る必要が無い）
 *
 * ⚠️ **既存の CSS 2本とは競合しない。** あちらで直っているモーダルは帯に食い込まないので、
 *    そもそもここの対象にならない。片方を消す必要は無い。
 *
 * ⚠️ **分かっている限界**（どれも実害が小さいので手当てしていない）:
 *    - `pointer-events: none` の固定要素は当たり判定で拾えない（body 直下なら①で拾える）
 *    - 幅60px 未満の固定要素は対象外。小さなバッジ類が隠れたら個別に CSS を足す
 *    - **入れ子の固定要素で、親が包含ブロックを作っている場合**、同じ周期で親子とも押すと
 *      子が二重に動く。ただし毎周期その場で測り直すので**次の周期で必ず戻る**（1周期だけ跳ねる）。
 *      親が包含ブロックかどうかを見分ける処理は、当たる確率に対して割に合わないので入れない。
 */

/** 押した量を記録する属性。**これが付いていない要素の `margin-left` は絶対に触らない。** */
export const NUDGE_ATTR = 'data-nns-nudge'

/** この幅までのズレは無視する。1px 単位で押し合うと毎周期書き込みが走る。 */
const TOLERANCE_PX = 2

/** これより小さいものは対象外（計測用の不可視要素・ヘアラインを拾わないため）。 */
const MIN_W = 60
const MIN_H = 24

/**
 * 🔴 これより左に居るものは**触らない。**
 *    画面外へ退避している引き出し（`left: -300px` で待機し、開く時に 0 へ来る類）を
 *    無理やり画面内へ引きずり出さないための線引き。左端ぴったり（0）は対象に含める。
 */
const PARKED_LEFT_PX = -8

/** 今こちらが押している要素。開閉・全画面・番組移動のときに戻すため覚えておく。 */
const nudged = new Set()

/**
 * 前回の周期で見た「押す前の左端」。**動いている最中かどうかの判定に使う。**
 * 🔴 掴んで動かしている最中や、他所が座標を計算し直している最中に押すと、
 *    要素がカーソルから飛ぶ／向こうと押し合いになる。動きが止まってから押す。
 * ⚠️ 初めて見た相手は「動いていない」扱いにする。そうしないと**最初の1周期（最悪500ms）、
 *    小窓が隠れたまま**になる。
 *
 * 🔴 **裏を返すと「初めて帯に入ってきた相手が動いている最中か」は判別できない。**
 *    採取は帯の近くしか見ていないので、遠くから運ばれてきた相手には前回の位置が無い。
 *    掴んで運ぶ場合を守っているのは `pointerActive` のほう。**この判定だけに頼らないこと。**
 */
const lastNatural = new WeakMap()

/**
 * 押すべき量を決める。**DOM を一切触らないので、検証から数値だけで呼べる。**
 * @param {number} reserved 確保している帯の幅（px）
 * @param {number} rectLeft いま実測した左端（既に押した量を含む）
 * @param {number} applied  こちらが今あてている量
 * @returns {number} あてるべき量（0 なら不要）
 */
export function computeNudge(reserved, rectLeft, applied) {
    const natural = rectLeft - applied
    // 画面外へ退避しているものは現状維持。
    if (natural < PARKED_LEFT_PX) return applied
    if (natural >= reserved - TOLERANCE_PX) return 0
    return Math.round(reserved - natural)
}

/**
 * こちらが今この要素にあてている量を読む。
 * ⚠️ React の再描画で **`style` だけ剥がされる**ことがある。属性の値と実際に効いている値が
 *    食い違ったら「剥がされた」とみなして 0 を返す。ここを 0 にしないと、
 *    次の計算で `natural` を実際より小さく見積もって**二重に押してしまう。**
 */
export function readApplied(el) {
    const declared = Number.parseFloat(el.getAttribute ? el.getAttribute(NUDGE_ATTR) : '')
    if (!Number.isFinite(declared)) return 0
    const actual = Number.parseFloat(el.style && el.style.marginLeft)
    if (!Number.isFinite(actual)) return 0
    if (Math.abs(actual - declared) > 1) return 0
    return declared
}

/**
 * 押してよい相手かどうか。
 *
 * 🔴 **「インラインで座標を持つものは触らない」は誤りだった**（2026-08-07・実機で発覚）。
 *    小窓は**掴んで動かせる。** 掴んだ瞬間に Kick がインラインの座標を書くので、
 *    その時点でこちらが管理を手放し、**サイドバーの裏へ置かれると二度と出てこなかった。**
 *    裏に居る間は掴むこともできないので、自力で戻す手段が無い＝行き止まり。
 *
 * ⚠️ 元の意図（Floating UI・Radix のポップオーバーと喧嘩しない）は、
 *    **「食い込んでいるかどうか」の実測**が既に果たしている。呼び出し元は可視領域に居るので、
 *    そこから計算されたポップオーバーは帯に食い込まない＝そもそも対象にならない。
 *    食い込むのは向こうが可視領域の外へはみ出させた時だけで、その時は**押すのが正しい**
 *    （少しずれても、隠れて操作できないよりよい）。
 *
 * 🔴 代わりに「**動いている間は触らない**」で身を守る（`nudgeFixedOverlays` 側）。
 *    掴んで動かしている最中に押すと、小窓がカーソルから 360px 飛ぶ。
 */
export function isNudgeCandidate(el, cs, rect, sidebarRootId) {
    if (!el || el.nodeType !== 1) return false
    if (!cs || cs.position !== 'fixed') return false
    if (el.id === sidebarRootId) return false
    if (typeof el.closest === 'function' && el.closest('#' + sidebarRootId)) return false
    if (!rect || rect.width < MIN_W || rect.height < MIN_H) return false
    return true
}

/**
 * 帯のあたりに実際に見えている要素を集める。
 *
 * 🔴 **`elementFromPoint`（単数）では駄目。** 帯の上にはサイドバー自身が乗っているので、
 *    単数版はサイドバーしか返さない。**隠れている当人が取れない。**
 *    複数版は重なり順のすべてを返すので、下敷きになっているものまで届く。
 *
 * 🔴 **`reserved` より右にも採取点を置くこと。** 押し終えた要素は左端が `reserved` に来るため、
 *    帯の中だけを見ていると**次の周期で見失って押し戻し、500ms ごとに往復する。**
 *
 * ⚠️ 全要素の走査はしない。①は body の直下2階層だけ、②は採取点が固定数（帯 360px で 8×7＝56 点）。
 *    どちらもページの要素数にも深さにも比例しない。
 * ⚠️ `pointer-events: none` の要素は複数版でも返らない。暗幕がそれだと拾えないが、
 *    暗幕は既に CSS 側で直っている。
 */
export function collectFixedNearStrip(reserved, doc, win) {
    const found = new Set()
    if (!(reserved > 0)) return found

    // ── ① body の浅いところ。
    // 🔴 **これが主。** React（Next.js）のモーダル・小窓は portal で body 直下へ差し込まれる。
    //    位置に関係なく確実に拾えるので、格子の目から漏れても届く。
    const body = doc.body
    if (body && body.children) {
        for (const a of body.children) {
            found.add(a)
            if (a.children) for (const b of a.children) found.add(b)
        }
    }

    // ── ② 帯のあたりの当たり判定。①で届かない深い場所に差し込まれた時の保険。
    if (typeof doc.elementsFromPoint !== 'function') return found
    const vh = win.innerHeight || 0
    if (vh <= 0) return found

    const r = Math.round(reserved)
    // 🔴 **列の間隔は拾う下限の幅（MIN_W）より狭くすること。** そうして初めて
    //    「MIN_W 以上あって帯に重なっているものは、必ずどれかの列に当たる」が言える。
    //    端2本だけだと、左に 16px の余白を置いた小窓（left=16）を x=4 が外す。
    const xs = []
    for (let x = 4; x < r; x += MIN_W - 4) xs.push(x)
    xs.push(r + 4) // 🔴 押し終えた要素（左端が r）を見失わないための1本。往復を防ぐ。

    // ⚠️ 縦は同じ密度にすると点が増えすぎる（1080px を 24px 刻みで 45 行）。
    //    ①があるので粗くてよいが、**上下の端は厚めに取る**（小窓は下の角に出る）。
    const ys = [...new Set([
        10, Math.round(vh * 0.12), Math.round(vh * 0.3), Math.round(vh * 0.5),
        Math.round(vh * 0.7), Math.round(vh * 0.88), Math.max(10, vh - 10),
    ])]

    for (const x of xs) {
        for (const y of ys) {
            let stack
            try { stack = doc.elementsFromPoint(x, y) } catch (e) { continue }
            if (!stack) continue
            // 複数版は祖先も含めて返すので、親をたどり直す必要は無い。
            for (const el of stack) found.add(el)
        }
    }
    return found
}

function applyNudge(el, px) {
    el.style.setProperty('margin-left', px + 'px', 'important')
    el.setAttribute(NUDGE_ATTR, String(px))
}

/**
 * 🔴 **押していない相手の `margin-left` を奪わないこと。**
 *    守りは2枚ある。呼び出し側の `applied > 0 || nudged.has(el)` と、ここの印の判定。
 *    ⚠️ **冗長なので、片方だけ消しても検証は通ってしまう**（実測済み）。
 *    どちらかを外す時は、必ず「押していない相手の margin-left を奪わない」を手で確かめること。
 * ⚠️ `owned` は「`nudged` に入っている」場合に立てる。React が**属性だけ**剥がして
 *    style を残した時、印だけを頼りにすると戻せず、連携を切った後も押した値が残る。
 */
function clearNudge(el, owned = false) {
    if (!el || !el.style) return
    if (!owned && (typeof el.hasAttribute !== 'function' || !el.hasAttribute(NUDGE_ATTR))) return
    el.style.removeProperty('margin-left')
    if (typeof el.removeAttribute === 'function') el.removeAttribute(NUDGE_ATTR)
}

/** 押しているものを全部戻す。連携を切る時・全画面に入る時に呼ぶ。 */
export function clearAllNudges() {
    for (const el of nudged) clearNudge(el, true)
    nudged.clear()
}

/** 検証用。今いくつ押しているか。 */
export function nudgedCount() {
    return nudged.size
}

/**
 * 1周期ぶん。帯に食い込んでいる固定要素を測って押し、外れたものは戻す。
 * @returns {number} この回に書き換えた要素の数（検証用）
 */
export function nudgeFixedOverlays(reserved, {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    sidebarRootId = 'niconamasidebar-kick-root',
    onNudge = null, // 押した時の通知（診断用）。**この本体からは console へ出さない。**
    // 🔴 ボタンを押している間（＝小窓を掴んでいる可能性がある間）は押さない。
    //    掴んでいる最中に押すと、小窓がカーソルから離れて 360px 飛ぶ。
    //    ⚠️ **戻しもしない。** 掴んだ瞬間に元へ戻ると、それはそれで飛ぶ。
    pointerActive = false,
    // 🔴 「動いている最中」の判定を今回だけ無視する。**離した直後の呼び出し専用。**
    //    離した時点で移動は終わっているが、前回の周期に記録した位置は移動の途中なので、
    //    そのまま比べると必ず「移動中」と出て素通りする。**離してもその場では出てこない。**
    ignoreMoving = false,
} = {}) {
    if (!doc || !win) return 0

    // 🔴 全画面表示の間は一切触らない。全画面の要素は最前面レイヤーに居てビューポート基準が正しく、
    //    ここで押すと画面が右にずれて欠ける。
    if (doc.fullscreenElement) { clearAllNudges(); return 0 }
    if (!(reserved > 0)) { clearAllNudges(); return 0 }
    // 裏タブでは測らない。見えていない間に採取しても意味が無く、
    // ⚠️ **戻しはしない**（戻すと表に返った瞬間に潜り込んだ状態が見える）。
    if (doc.hidden) return 0

    // 今見えているもの＋**既に押しているもの**。後者を足さないと、押して帯から出た瞬間に
    // 見失って戻し、また押す、を繰り返す。
    const toCheck = collectFixedNearStrip(reserved, doc, win)
    for (const el of [...nudged]) {
        if (el.isConnected === false) { nudged.delete(el); continue }
        toCheck.add(el)
    }

    let acted = 0
    for (const el of toCheck) {
        let cs, rect
        try { cs = win.getComputedStyle(el) } catch (e) { continue }
        try { rect = el.getBoundingClientRect() } catch (e) { continue }

        if (!isNudgeCandidate(el, cs, rect, sidebarRootId)) {
            if (nudged.has(el)) { clearNudge(el, true); nudged.delete(el); acted++ }
            continue
        }

        const applied = readApplied(el)
        const natural = rect.left - applied

        // 動いている最中は触らない。掴んで移動中の小窓、位置を計算し直しているポップオーバー、
        // スライドイン中の引き出しがここに落ちる。
        // ⚠️ **初めて見た相手は「動いていない」扱い。** そうしないと最初の1周期ぶん隠れたままになる。
        const prev = lastNatural.get(el)
        lastNatural.set(el, natural)
        const moving = !ignoreMoving && prev !== undefined && Math.abs(prev - natural) > TOLERANCE_PX
        if (moving || pointerActive) continue

        const want = computeNudge(reserved, rect.left, applied)

        if (want > 0) {
            if (Math.abs(want - applied) > TOLERANCE_PX) {
                applyNudge(el, want)
                acted++
                if (onNudge) { try { onNudge(el, want, rect) } catch (e) { /* 診断で本体を止めない */ } }
            }
            nudged.add(el)
        } else if (applied > 0 || nudged.has(el)) {
            clearNudge(el, nudged.has(el))
            nudged.delete(el)
            acted++
        }
    }
    return acted
}
