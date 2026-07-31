/**
 * 最小のDOM実装。**本物の updateSidebar をそのまま走らせる**ための土台。
 *
 * これが無かった間、verify:loop は updateSidebar を丸ごとスタブに差し替えていた。
 * つまり「描画経路そのもの」は一度も自動検証されていなかった（差分更新・構造変化判定・
 * 削除検知・並べ替え・FLIP はすべて人間の目視頼み）。R-2 のように描画経路の内部構造を
 * 変える改修は、ここが埋まっていないと**回帰を検出できない**。
 *
 * 【方針】
 * jsdom を入れない。依存を増やさずに済むし、実装が読めない箱を挟むと
 * 「モックが悪いのか実装が悪いのか」の切り分けができなくなる。
 * 必要な API だけを、**中身が見える形で**用意する。
 *
 * 【意図的に本物と違うところ】
 * - レイアウトは「カードを縦に1枚100pxで積む」固定モデル。getBoundingClientRect は
 *   親の中での位置から計算する。FLIP は実測値の差分で動くので、これで並べ替え時に
 *   ちゃんと moved が埋まる（＝FLIP経路が実際に走る）。
 * - requestAnimationFrame は setTimeout(0)。
 */

const NOT_FOUND = null

/** data-api-index ⇄ dataset.apiIndex の変換 */
const toKebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
const toCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

/** セレクタ1ステップぶんの条件（`div.foo#bar` のような複合も受ける） */
function parseStep(step) {
    const cond = { tag: null, classes: [], id: null }
    const re = /([.#]?)([A-Za-z0-9_-]+)/g
    let m
    while ((m = re.exec(step))) {
        if (m[1] === '.') cond.classes.push(m[2])
        else if (m[1] === '#') cond.id = m[2]
        else cond.tag = m[2].toLowerCase()
    }
    return cond
}

function matchesStep(el, cond) {
    if (cond.tag && el.tag !== cond.tag) return false
    if (cond.id && el.id !== cond.id) return false
    const cls = (el.className || '').split(/\s+/).filter(Boolean)
    for (const c of cond.classes) if (!cls.includes(c)) return false
    return true
}

/** 子孫セレクタ（空白区切り）だけ対応。`>` や属性セレクタは使わない方針。 */
function select(roots, selector, all) {
    const steps = String(selector).trim().split(/\s+/).map(parseStep)
    let current = roots
    for (const cond of steps) {
        const next = []
        for (const r of current) {
            walk(r, (el) => { if (matchesStep(el, cond)) next.push(el) })
        }
        current = next
        if (current.length === 0) break
    }
    return all ? current : (current[0] || NOT_FOUND)
}

/** 自分を含まず子孫を前順で辿る */
function walk(node, fn) {
    for (const c of node.children) {
        fn(c)
        walk(c, fn)
    }
}

let uid = 0

export function createElement(tag = 'div') {
    const attrs = Object.create(null)

    const el = {
        _uid: ++uid,
        tag: String(tag).toLowerCase(),
        id: '',
        className: '',
        textContent: '',
        title: '',
        target: '',
        alt: '',
        children: [],
        parentElement: null,
        style: {},
        attrs,

        // makeProgramElement は src/href をプロパティで書き、
        // applyProgramInfoToCard は data-src を setAttribute で書く。両方を1つの表に集約する。
        get src() { return attrs.src || '' },
        set src(v) { attrs.src = String(v) },
        get href() { return attrs.href || '' },
        set href(v) { attrs.href = String(v) },

        getAttribute(k) { return k in attrs ? attrs[k] : NOT_FOUND },
        setAttribute(k, v) { attrs[k] = String(v) },
        removeAttribute(k) { delete attrs[k] },
        hasAttribute(k) { return k in attrs },

        appendChild(c) {
            if (c && c._isFragment) {
                // フラグメントは中身だけ移す（本物と同じく、フラグメント自体は空になる）
                const kids = c.children.slice()
                c.children.length = 0
                for (const k of kids) el.appendChild(k)
                return c
            }
            if (c.parentElement) c.parentElement.removeChild(c)
            el.children.push(c)
            c.parentElement = el
            return c
        },
        insertBefore(c, ref) {
            if (c.parentElement) c.parentElement.removeChild(c)
            const i = ref ? el.children.indexOf(ref) : 0
            el.children.splice(i < 0 ? el.children.length : i, 0, c)
            c.parentElement = el
            return c
        },
        removeChild(c) {
            const i = el.children.indexOf(c)
            if (i >= 0) { el.children.splice(i, 1); c.parentElement = null }
            return c
        },
        remove() { if (el.parentElement) el.parentElement.removeChild(el) },
        replaceChildren(...nodes) {
            for (const c of el.children) c.parentElement = null
            el.children.length = 0
            for (const n of nodes) el.appendChild(n)
        },
        contains(other) {
            let found = false
            walk(el, (x) => { if (x === other) found = true })
            return found || el === other
        },

        // イベント。カードのサムネ <img> は load/error を張るので必須。
        // 発火はテスト側から el.fire('error') で行う（実物のように自動では鳴らない）。
        _listeners: Object.create(null),
        addEventListener(type, fn) {
            (el._listeners[type] || (el._listeners[type] = [])).push(fn)
        },
        removeEventListener(type, fn) {
            const a = el._listeners[type]
            if (!a) return
            const i = a.indexOf(fn)
            if (i >= 0) a.splice(i, 1)
        },
        fire(type, ev) {
            for (const fn of (el._listeners[type] || []).slice()) fn(ev || { type, target: el })
        },

        querySelector(sel) { return select([el], sel, false) },
        querySelectorAll(sel) { return select([el], sel, true) },
        // サムネ更新ループが `img.closest('.program_container')` で自分のカードを辿るのに使う。
        // 単一ステップのセレクタのみ対応（`.class` / `#id` / `tag`）。子孫セレクタは想定しない。
        closest(sel) {
            const cond = parseStep(String(sel).trim())
            let n = el
            while (n) {
                if (matchesStep(n, cond)) return n
                n = n.parentElement
            }
            return NOT_FOUND
        },
        getElementsByClassName(cls) {
            const out = []
            walk(el, (x) => {
                if ((x.className || '').split(/\s+/).includes(cls)) out.push(x)
            })
            return out
        },

        get firstChild() { return el.children[0] || NOT_FOUND },
        get lastChild() { return el.children[el.children.length - 1] || NOT_FOUND },
        get childElementCount() { return el.children.length },

        // FLIP はこれで強制リフローする。値そのものは使われない。
        get offsetWidth() { return 300 },
        get offsetHeight() { return 100 },

        /**
         * カードを縦に1枚100pxで積む固定レイアウト。
         * **親の中での現在位置から計算する**ので、並べ替えれば戻り値が変わる
         * ＝ FLIP の First/Last の差分がちゃんと出る。
         */
        getBoundingClientRect() {
            const p = el.parentElement
            const i = p ? p.children.indexOf(el) : 0
            const top = (i < 0 ? 0 : i) * 100
            return { top, left: 0, bottom: top + 100, right: 300, width: 300, height: 100, x: 0, y: top }
        },
    }

    el.classList = {
        add(...cs) {
            const s = new Set((el.className || '').split(/\s+/).filter(Boolean))
            cs.forEach((c) => s.add(c))
            el.className = Array.from(s).join(' ')
        },
        remove(...cs) {
            const s = new Set((el.className || '').split(/\s+/).filter(Boolean))
            cs.forEach((c) => s.delete(c))
            el.className = Array.from(s).join(' ')
        },
        contains(c) { return (el.className || '').split(/\s+/).includes(c) },
        toggle(c, on) {
            const has = el.classList.contains(c)
            const want = on === undefined ? !has : !!on
            if (want) el.classList.add(c); else el.classList.remove(c)
            return want
        },
    }

    // dataset は attrs の data-* を見る「窓」。実体を二重に持たない
    // （持つと setAttribute('data-api-index') と dataset.apiIndex が食い違う）。
    el.dataset = new Proxy(Object.create(null), {
        get: (_t, k) => (typeof k === 'string' ? attrs['data-' + toKebab(k)] : undefined),
        set: (_t, k, v) => { attrs['data-' + toKebab(k)] = String(v); return true },
        has: (_t, k) => typeof k === 'string' && ('data-' + toKebab(k)) in attrs,
        deleteProperty: (_t, k) => { delete attrs['data-' + toKebab(k)]; return true },
        ownKeys: () => Object.keys(attrs).filter((a) => a.startsWith('data-')).map((a) => toCamel(a.slice(5))),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })

    return el
}

export function createDocumentFragment() {
    const f = createElement('#fragment')
    f._isFragment = true
    return f
}

/**
 * globalThis に document / requestAnimationFrame を用意する。
 * @returns {{root, container, getById, reset, restore}}
 */
export function installMockDom() {
    const prevDocument = globalThis.document
    const prevRaf = globalThis.requestAnimationFrame
    const prevCaf = globalThis.cancelAnimationFrame

    const root = createElement('body')
    root.id = 'root'

    const container = createElement('div')
    container.id = 'liveProgramContainer'
    root.appendChild(container)

    const programCount = createElement('div')
    programCount.id = 'program_count'
    root.appendChild(programCount)

    const getById = (id) => {
        if (root.id === id) return root
        let hit = NOT_FOUND
        walk(root, (x) => { if (hit === NOT_FOUND && x.id === id) hit = x })
        return hit
    }

    globalThis.document = {
        hidden: false,
        body: root,
        documentElement: root,
        createElement,
        createDocumentFragment,
        getElementById: getById,
        querySelector: (sel) => select([root], sel, false),
        querySelectorAll: (sel) => select([root], sel, true),
        getElementsByClassName: (cls) => root.getElementsByClassName(cls),
        addEventListener: () => {},
        removeEventListener: () => {},
    }

    const rafIds = new Set()
    globalThis.requestAnimationFrame = (fn) => {
        const t = setTimeout(() => { rafIds.delete(t); fn(Date.now()) }, 0)
        rafIds.add(t)
        return t
    }
    globalThis.cancelAnimationFrame = (t) => { clearTimeout(t); rafIds.delete(t) }

    return {
        root,
        container,
        getById,
        /** カードだけ消す（program_count などの器は残す） */
        reset() { container.replaceChildren() },
        /** 今コンテナに並んでいるカードの id を上から順に */
        ids() { return container.children.map((c) => c.id) },
        restore() {
            for (const t of rafIds) clearTimeout(t)
            rafIds.clear()
            globalThis.document = prevDocument
            globalThis.requestAnimationFrame = prevRaf
            globalThis.cancelAnimationFrame = prevCaf
        },
    }
}
