/**
 * 見た配信者の回数を数える。「おすすめ順」の材料。
 *
 * 【方針】
 * 数えるのは**配信者**であって番組ではない。ニコ生は放送ごとに lv 番号が変わるので、
 * 番組で数えても次回の放送には効かない。
 *
 * 🔴 **保存は `chrome.storage.local`。`localStorage` を使わないこと。**
 *    あちらはオリジンごとに分かれるので、**ニコ生ページと kick.com で履歴が別々**になる。
 *    視聴履歴は両方で共有すべきもの。
 *
 * 【数える契機】
 * 番組ページを開いた時に1回。**滞在時間は問わない**（利用者判断・2026-08-10。
 * 「3分以内に移動しても興味はある」ため）。ただし次の2つは数えない:
 *   - **自動移動で飛んできた時** … 自分で選んでいない
 *   - **リロード** … 同じ視聴を2回にしない（`isPageReload`）
 *
 * 🔴 **「そのタブで既に見た相手を弾く」にしないこと**（2026-08-10 に一度そうして戻した）。
 *    同じ配信者を続けて開いた時まで弾かれ、**何回開いても回数が増えない**ように見える。
 *
 * 【外へ出さない】
 * この記録は端末内に留まる。送信も同期もしない。
 */

import { watchHistoryMaxOwners, watchPointIntervalMs, watchPointMaxPerVisit } from '../config/constants.js'

/** chrome.storage.local のキー。 */
const STORE_KEY = 'watchCounts'

/** ownerKey -> { points, lastAt } */
let counts = new Map()
let loaded = false

/** 拡張が無効化された後もコンテンツスクリプトは動き続ける。触る前に確かめる。 */
function storageAlive() {
    try {
        return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id
            && !!chrome.storage && !!chrome.storage.local
    } catch (_e) {
        return false
    }
}

/**
 * programInfo から履歴のキーを作る。**この対応はここだけに書く。**
 *
 * 🔴 記録する側（視聴ページ）とカード側で**同じ文字列**にならないと、数えても順位に出ない。
 *    しかも**エラーもログも出ない**（ただ全部0のまま並ぶ）ので気付けない。
 *
 * @param {object} info programInfo
 * @returns {string} 例 `nico:10856175` / `kick:someone`。作れなければ空文字
 */
export function ownerKeyOf(info) {
    if (!info) return ''
    const id = info.contentOwner && info.contentOwner.id
    if (!id) return ''
    return (info.service === 'kick' ? 'kick:' : 'nico:') + String(id)
}

/**
 * 保存済みの履歴を読み込む。**描画より前に1回呼ぶこと。**
 * 読めなくても実害は無い（全部0として並ぶ＝実質いまの人気順）。
 */
export async function loadWatchHistory() {
    if (loaded) return
    loaded = true
    if (!storageAlive()) return
    try {
        const got = await chrome.storage.local.get(STORE_KEY)
        const raw = got && got[STORE_KEY]
        if (raw && typeof raw === 'object') {
            for (const [key, v] of Object.entries(raw)) {
                // ⚠️ 旧版は回数を count で持っていた。**1回＝1点として引き継ぐ**
                //    （移行を書かないと、貯まっていた記録がゼロに戻る）。
                const points = Number(v && (v.points != null ? v.points : v.count))
                if (!key || !Number.isFinite(points) || points <= 0) continue
                counts.set(key, { points, lastAt: Number(v.lastAt) || 0 })
            }
        }
    } catch (_e) { /* 読めなければ 0 件で始める */ }
}

/**
 * その配信者の点数。**同期で返す**（並び替えの最中に呼ぶため）。
 * @param {string} key
 * @returns {number}
 */
export function getWatchPoints(key) {
    if (!key) return 0
    const rec = counts.get(key)
    return rec ? rec.points : 0
}

/**
 * このページ読み込みが「リロード」か。
 *
 * 🔴 **二重計上を防ぐのはこれだけでよい**（2026-08-10・利用者が実機で発見）。
 *    以前は sessionStorage に「直前に数えた相手」を置いて弾いていたが、それだと
 *    **同じ配信者を続けて開いた時**（別の番組でも、開き直しでも）まで弾かれ、
 *    「何回開いても回数が増えない」ように見える。
 *    ブラウザは遷移とリロードを区別できるので、そちらを使えば取りこぼしが無い。
 *
 * @returns {boolean} 判定できなければ false（＝数える側に倒す）
 */
export function isPageReload() {
    try {
        const nav = performance.getEntriesByType('navigation')[0]
        return !!nav && nav.type === 'reload'
    } catch (_e) {
        return false
    }
}

/**
 * 別のタブで数えた分をこのタブへも反映する。
 *
 * 🔴 **これが無いと、開きっぱなしのタブは古い回数のまま並ぶ。** 履歴は起動時に1回しか
 *    読まないので、別タブで視聴して増えても気付けない（2026-08-10・利用者が実機で発見）。
 *
 * @param {() => void} [onChanged] 反映後に呼ぶ（並べ替え直しに使う）
 */
let syncWired = false
export function startWatchHistorySync(onChanged) {
    if (syncWired) return
    syncWired = true
    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes || !changes[STORE_KEY]) return
            const raw = changes[STORE_KEY].newValue
            const next = new Map()
            if (raw && typeof raw === 'object') {
                for (const [key, v] of Object.entries(raw)) {
                    const points = Number(v && (v.points != null ? v.points : v.count))
                    if (!key || !Number.isFinite(points) || points <= 0) continue
                    next.set(key, { points, lastAt: Number(v.lastAt) || 0 })
                }
            }
            counts = next
            if (typeof onChanged === 'function') onChanged()
        })
    } catch (_e) { /* 拡張が無効化されていれば張れないだけ */ }
}

/**
 * 点数を加える。
 *
 * @param {string} key `ownerKeyOf` が作ったキー
 * @param {number} [amount] 加える点数
 * @param {number} [now] 現在時刻(ms)
 * @returns {Promise<boolean>} 加えたか
 */
export async function recordWatch(key, amount = 1, now = Date.now()) {
    if (!key || !(amount > 0)) return false

    await loadWatchHistory()

    if (!storageAlive()) {
        // 保存できない状況（拡張が無効化された等）。このタブの表だけ進めておく。
        const rec = counts.get(key)
        counts.set(key, { points: (rec ? rec.points : 0) + amount, lastAt: now })
        return true
    }

    // 🔴 **メモリ上の表を丸ごと保存しないこと**（2026-08-10・利用者が「点数が減る」と報告）。
    //    サイドバーはニコ生ページと kick.com の**両方**に居て、タブの数だけ書き手が居る。
    //    自分の表を丸ごと書くと、**他のタブが直前に足した点を消す**（lost update）。
    //    増えるはずの数字が減るので、見ればすぐ分かるのに原因は分かりにくい。
    //
    //    直前に保存を読み直し、**その相手の1件だけ**を足して書き戻す。
    //    サムネの `patchProgramThumbnail` が同じ理由で同じ形になっている。
    try {
        const got = await chrome.storage.local.get(STORE_KEY)
        const raw = (got && got[STORE_KEY] && typeof got[STORE_KEY] === 'object')
            ? { ...got[STORE_KEY] } : {}
        const prev = raw[key]
        const prevPoints = Number(prev && (prev.points != null ? prev.points : prev.count)) || 0
        raw[key] = { points: prevPoints + amount, lastAt: now }

        // ⚠️ **上限を設けること。** フォローが入れ替わっても記録だけが増え続ける。
        //    落とすのは**最後に見たのが古い順**（点数が高くても何年も見ていない相手は落ちてよい）。
        const keys = Object.keys(raw)
        if (keys.length > watchHistoryMaxOwners) {
            const sorted = keys.sort((a, b) => (raw[a].lastAt || 0) - (raw[b].lastAt || 0))
            for (const k of sorted.slice(0, keys.length - watchHistoryMaxOwners)) delete raw[k]
        }

        await chrome.storage.local.set({ [STORE_KEY]: raw })

        // 書けた内容をこのタブの表にも反映する（onChanged を待たずに画面へ出せる）。
        counts = new Map(Object.entries(raw).map(([k, v]) => [k, {
            points: Number(v.points != null ? v.points : v.count) || 0,
            lastAt: Number(v.lastAt) || 0,
        }]))
    } catch (_e) { /* 保存できなくてもこのタブの間は効く */ }
    return true
}

/**
 * 見続けている間、一定時間ごとに加点する。**両ページ共通。**
 *
 * 🔴 **上限を必ず設けること**（`watchPointMaxPerVisit`）。付けっぱなしのタブが一晩で
 *    何十点も稼ぐと、一度も見ていない配信者が上位に居座る。
 *
 * ⚠️ **裏タブでも加点する**（利用者判断・2026-08-10）。ニコ生は音声だけ聞く使い方があり、
 *    裏に置いている時間も視聴のうち。放置されたタブと区別は付かないが、
 *    1回の視聴の上限（`watchPointMaxPerVisit`）があるので稼ぎ続けることはない。
 *
 * ⚠️ 呼ぶのは**開いた分を記録した後**。止めるのはページの破棄任せでよい
 *    （タイマーはページと一緒に消える）。同じページで2回呼んでも二重にならない。
 *
 * @param {string} key `ownerKeyOf` が作ったキー
 * @returns {() => void} 止める関数（連携解除など、ページより先に止めたい時用）
 */
let dwellTimer = null
export function startDwellPoints(key) {
    if (!key) return () => {}
    if (dwellTimer !== null) return () => stopDwellPoints()
    let given = 0
    dwellTimer = setInterval(() => {
        if (given >= watchPointMaxPerVisit) return stopDwellPoints()
        given++
        recordWatch(key, 1)
    }, watchPointIntervalMs)
    return () => stopDwellPoints()
}

export function stopDwellPoints() {
    if (dwellTimer === null) return
    clearInterval(dwellTimer)
    dwellTimer = null
}

/** 履歴に載っている配信者の数。リセットの確認文で「何人ぶん消えるか」を出すのに使う。 */
export function watchHistorySize() {
    return counts.size
}

/**
 * 履歴を全部消す（設定「よく見る順の履歴」のリセット）。
 *
 * 🔴 **消した後の並べ替えをここから呼ばないこと。** `chrome.storage.local.remove` は
 *    **自分のタブを含む全コンテキスト**で `storage.onChanged` を起こす（削除は
 *    `newValue` が undefined で通知される）。`startWatchHistorySync` が既にそれを受けて
 *    メモリを空にし、並べ替え直しまでやる。ここで別に呼ぶと、
 *    **自分のタブだけ2回走る**うえ「同じことをする道が2本」になる。
 * ⚠️ 拡張が無効化されている時は storage を触れないので通知も起きない。
 *    その場合はメモリだけ空にして黙って戻る（次に開けば storage 側は残っている）。
 */
export async function clearWatchHistory() {
    counts = new Map()
    if (!storageAlive()) return
    try {
        await chrome.storage.local.remove(STORE_KEY)
    } catch (_e) { /* 消せなくてもメモリ上は空 */ }
}

/**
 * いま開いているニコ生の視聴ページの配信者キー。
 *
 * 🔴 **詳細APIを叩かないこと。** 視聴ページのHTMLに最初から入っている
 *    `embedded-data` から取れる（2026-08-10 実測）。フォローしていない番組でも取れる。
 *      user 番組    … `program.supplier.pageUrl` の `/user/<数字>`
 *      channel 番組 … `socialGroup.id`（`ch...`）
 *    どちらも `contentOwner.id` と同じ文字列になる（カード側と突き合うのはここ）。
 *
 * @returns {string} 取れなければ空文字
 */
export function currentOwnerKeyOnNicoPage() {
    try {
        const el = document.getElementById('embedded-data')
        const props = el && el.dataset ? el.dataset.props : ''
        if (!props) return ''
        const data = JSON.parse(props)
        const supplier = (data.program && data.program.supplier) || {}
        if (supplier.supplierType === 'user') {
            const m = String(supplier.pageUrl || '').match(/\/user\/(\d+)/)
            return m ? 'nico:' + m[1] : ''
        }
        const social = data.socialGroup || {}
        return social.id ? 'nico:' + String(social.id) : ''
    } catch (_e) {
        return ''
    }
}

/**
 * いま開いている kick.com のチャンネルの配信者キー。
 * URL の1階層目が slug（`kick.com/<slug>`）。一覧ページ等は空文字を返す。
 * @param {string} [href]
 * @returns {string}
 */
export function currentOwnerKeyOnKickPage(href = location.href) {
    try {
        const u = new URL(href)
        if (!/(^|\.)kick\.com$/i.test(u.hostname)) return ''
        const seg = u.pathname.split('/').filter(Boolean)
        // 1階層目だけがチャンネル。`/browse` `/categories/...` などは対象外。
        if (seg.length !== 1) return ''
        const slug = seg[0].toLowerCase()
        if (!slug || /^(browse|categories|category|search|following|subscriptions|clips)$/.test(slug)) return ''
        return 'kick:' + slug
    } catch (_e) {
        return ''
    }
}
