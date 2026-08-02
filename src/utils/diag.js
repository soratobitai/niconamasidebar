/**
 * 【診断コード】原因が分かったらこのファイルごと消す。
 *
 * 今の調査対象は**自動移動だけ**。「気づいたら終了画面のままで、移動モーダルも出ていない」
 * がどの関門で止まっているのかを知るためのもの。
 *
 * 🔴 **正常に動いている間はコンソールに何も出さない。**
 *    起きたことは黙って localStorage に貯め、**失敗した時にだけ**それまでの記録ごと出す。
 *    毎回出していると、いざ失敗した時に何行も遡ることになって読めない（利用者指摘）。
 *
 * localStorage に貯めるのは、自動移動が**ページを移る**ため。飛ぶ前の記録が残っていないと、
 * 飛んだ先で何が起きたか分からない。
 */

const KEY = 'nicosidebar_diag_autonext'
const MAX = 200                       // 貯める件数の上限
const RETAIN_MS = 6 * 60 * 60 * 1000  // これより古い記録は自動で捨てる（6時間）
const SHOW = 25                       // 失敗時に出す行数
const TAG = '[自動移動診断]'

// このページで失敗の全文をもう出したか。2回目以降は1行だけにする
// （終了ガイドが出ている間は20秒ごとに再検知するので、毎回全文だと逆に読めなくなる）。
let dumpedOnce = false

function load() {
    try {
        const v = JSON.parse(localStorage.getItem(KEY))
        return Array.isArray(v) ? v : []
    } catch (_e) {
        return []
    }
}

/**
 * 保存する。**古い記録はここで自動的に捨てる。**
 * 手で消さなくても溜まり続けないようにするため（利用者要望）。
 *  - 6時間より古いもの … 落とす。失敗を読むのに何時間も前の記録は要らない
 *  - それでも多い時    … 新しい方から MAX 件だけ残す
 * 書き込みのたびに通るので、掃除のためのタイマーは要らない。
 */
function save(list) {
    const limit = Date.now() - RETAIN_MS
    const fresh = list.filter((r) => r && typeof r.t === 'number' && r.t >= limit)
    try {
        localStorage.setItem(KEY, JSON.stringify(fresh.slice(-MAX)))
    } catch (_e) {
        /* 保存できなくても失敗時の出力は続ける */
    }
}

const hhmmss = (t) => {
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function push(text) {
    const now = Date.now()
    const list = load()
    list.push({ t: now, text })
    save(list)
    return now
}

/** 起きたこと。**コンソールには出さない。** 失敗した時にまとめて出すための材料。 */
export function diagEvent(text) {
    push(text)
}

/** 1行だけコンソールに出す。監視が動いていることを知らせる用（ページごとに1回）。 */
export function diagNote(text) {
    const t = push(text)
    console.log(`${TAG} ${hhmmss(t)} ${text}`)
}

/**
 * 失敗。**ここでだけコンソールに出す。**
 * 初回はそれまでの記録ごと、2回目以降は1行だけ。
 */
export function diagFail(text) {
    const t = push(text)
    console.log(`${TAG} ★ ${hhmmss(t)} ${text}`)
    if (dumpedOnce) return
    dumpedOnce = true
    const list = load().slice(0, -1).slice(-SHOW) // 今の失敗行は上で出したので除く
    if (list.length === 0) return
    console.log(`${TAG} ── ここまでの記録（${list.length}件・前のページ分を含む）──`)
    for (const r of list) console.log(`${TAG} ${hhmmss(r.t)} ${r.text}`)
    console.log(`${TAG} ── ここまで ──`)
}

/** 記録を消す。 */
export function diagClear() {
    save([])
    dumpedOnce = false
    console.log(`${TAG} 記録を消した`)
}

/** 貯まっている記録を手で出す（任意）。 */
export function diagDump() {
    const list = load()
    if (list.length === 0) { console.log(`${TAG} 記録なし`); return }
    for (const r of list) console.log(`${TAG} ${hhmmss(r.t)} ${r.text}`)
}

// 実ページのコンソールから手で触れるようにしておく（打たなくてもよい）
if (typeof window !== 'undefined') {
    window.__diagClear = diagClear
    window.__diagDump = diagDump
}
