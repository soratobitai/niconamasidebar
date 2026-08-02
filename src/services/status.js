// 【診断コード】原因が分かったら import ごと消す
import { diagFail, diagEvent } from '../utils/diag.js'

/**
 * 番組終了を検知したら呼ばれる。
 * @callback OnProgramEnded
 * @param {boolean} firstSinceArmed 再武装してから最初の検知か（＝リストを取り直してよい回か）
 */

/**
 * 視聴中の番組が終了したか（ニコ生の「番組終了ガイド」が出ているか）を判定する。
 *
 * ニコ生側の実装（2026-07-31 に `nicolib` / `pc-watch` バンドルから復元）:
 *
 * ```jsx
 * <div class="…program-end-guide…">
 *   {enquete && <UserCommunicationSatisfactionLevelEnquetePanel/>}   // これが出る時は下は出ない
 *   {!enquete && <>
 *     <div class="…announcement…"/>                                  // 「この番組は終了しました」＝無条件
 *     <div class="…next-action-area…">                               // 無条件
 *       {(l||c) && <div class="menu-area">
 *         {c && <BroadcastRequestEnlightenmentSection/>}             // ← リクエストボタンはこの中だけ
 *       </div>}
 *     </div>
 *   </>}
 * </div>
 * ```
 *
 * 🔴 **`button[class*="broadcast-request-send-button"]` を条件に戻さないこと。**
 * その欄（`BroadcastRequestEnlightenmentSection`）の表示条件は
 * `visualProviderTypeIsCommunity && !isBroadcaster && (!isLoggedIn || broadcasterBroadcastRequest.isEnabled)`
 * であり、**チャンネル/公式番組では常に出ず**、ユーザー生放送でも**配信者が放送リクエストを
 * 無効にしていれば出ない**。これを必須にしていたため、自動移動が「番組によっては毎回不発」
 * という形で壊れていた（doc/09 項目AU）。エラーもログも出ないので気付けない。
 *
 * 判定は「視聴者が見る形（announcement ＋ next-action-area）」か
 * 「配信者本人に出る満足度アンケート」のどちらかが揃っていること。ガイド枠だけで判定しないのは、
 * 中身が組み上がる前の一瞬で誤爆しないようにするため。
 *
 * @returns {boolean}
 */
function detectProgramEndGuide() {
	// ハッシュ付きクラスのため部分一致で検出
	const guide = document.querySelector('[class*="program-end-guide"]')
	if (!guide) return false

	// 通常（視聴者が見る形）。この2つは番組種別・配信者設定によらず無条件に描画される。
	const hasAnnouncement = !!guide.querySelector('[class*="announcement"]')
	const hasNextActionArea = !!guide.querySelector('[class*="next-action-area"]')
	if (hasAnnouncement && hasNextActionArea) return true

	// 配信者本人が満足度アンケートを出された時は、上の2つの代わりにこれだけが描画される。
	if (guide.querySelector('[class*="satisfaction-level-enquete-panel"]')) return true

	// 【診断コード】関門2。終了ガイドの枠はあるのに中身が想定と違う＝ニコ生側の作りが
	// 変わって終了に気づけない状態。**この時は何も起きないので、記録が無いと分からない。**
	// 中身が組み上がる前の一瞬でも通るため、同じ枠につき1回だけ出す。
	if (!guide.__diagWarned) {
		guide.__diagWarned = true
		diagFail(
			'終了ガイドの枠はあるが中身が想定と違う（終了に気づけない）'
			+ ` / announcement=${hasAnnouncement ? 'あり' : 'なし'}`
			+ ` / next-action-area=${hasNextActionArea ? 'あり' : 'なし'}`
			+ ` / 中の class: ${Array.from(guide.querySelectorAll('*')).slice(0, 8).map((e) => e.className).join(' | ') || '(空)'}`
		)
	}
	return false
}

/**
 * 「開いた時点でもう終わっていたページ」かどうか（doc/09 項目BI-2）。
 *
 * 🔴 **終了ガイドは「見ている番組が終わった瞬間」にしか出ない。**
 * 最初から終わっている番組を開くと、ニコ生はタイムシフトの案内画面を出す。
 * 2026-08-02 に本物のChromeで実測（タイムシフト公開・非公開の両方）:
 *
 *     status=ENDED  program-end-guide: **なし**  画面「タイムシフト非公開番組です」
 *     status=ENDED  program-end-guide: **なし**  画面「タイムシフト公開中です」
 *
 * つまり `detectProgramEndGuide` だけでは、**自動移動で終了済みの番組へ飛んだ時に
 * そこで止まってしまう**（モーダルも出ず、終了画面のまま）。これが
 * 「気づいたら終了画面のままだった」の正体。
 *
 * 代わりに **ページのHTMLに最初から入っている `program.status`** を見る。
 * サーバが返す時点で `ENDED` / `ON_AIR` が確定しており、JSの描画を待つ必要がない。
 *
 * ⚠️ **自動移動で飛んできた時だけ有効にする。** タイムシフトを見ようとして自分で開いた番組まで
 *    「終了している」と判断すると、**見始めた瞬間に別の番組へ連れて行かれる**。
 *    移動する側が印を置き、飛んだ先でその印を確認した時だけ、この判定を使う。
 */
const AUTO_NEXT_HOP_KEY = 'nicosidebar_autonext_hop'
const AUTO_NEXT_HOP_VALID_MS = 3 * 60 * 1000 // 印の有効期限（移動は10秒後なので十分長い）

/** 移動する直前に印を置く（AutoNextManager から呼ぶ）。 */
function markAutoNextHop() {
	try { sessionStorage.setItem(AUTO_NEXT_HOP_KEY, String(Date.now())) } catch (_e) {}
}

/**
 * このページが「自動移動で飛んできた、かつ最初から終了していた」かを1回だけ判定する。
 *
 * 🔴 **印はここで消し、結果はページが生きている間ずっと保持する。**
 * 消さないと、後から利用者が自分で開いたタイムシフトにまで印が効いてしまう。
 * 保持しないと、最初の1回で判定が消費され、その時たまたまサイドバーが未完成だと二度と拾えない。
 */
let loadedEndedCache = null
function wasLoadedAlreadyEnded() {
	if (loadedEndedCache !== null) return loadedEndedCache
	loadedEndedCache = false
	try {
		const at = Number(sessionStorage.getItem(AUTO_NEXT_HOP_KEY))
		sessionStorage.removeItem(AUTO_NEXT_HOP_KEY) // 印は1回で使い切る
		if (!Number.isFinite(at) || Date.now() - at > AUTO_NEXT_HOP_VALID_MS) return loadedEndedCache

		const el = document.getElementById('embedded-data')
		const props = el && el.dataset ? el.dataset.props : ''
		if (!props) return loadedEndedCache
		const status = JSON.parse(props).program.status
		loadedEndedCache = status === 'ENDED'
		if (loadedEndedCache) {
			diagEvent('自動移動: 飛んだ先は最初から終了していた（program.status=ENDED）→ そのまま次を探す')
		}
	} catch (_e) {
		// 読めなければ「終了していない」扱い。**判断材料が無い時は動かさない。**
	}
	return loadedEndedCache
}

// 終了ガイド表示中に onEnded を再発火してよい最小間隔（ミリ秒）。
// onEnded → updateSidebar は replaceChildren で body 配下に大量の変異を撒くため、
// スロットルが無いと「変異 → onEnded → updateSidebar → さらに変異」の自己駆動ループになり
// リスト取得(フォローAPI) が暴走する（1分に数十回）。ガイド表示中はこの間隔でのみ再チェックする。
const PROGRAM_END_RECHECK_MIN_INTERVAL_MS = 20000

// MutationObserver + 軽量ポーリングで終了を検出
function observeProgramEnd(onEnded) {
	const root = document.body
	if (!root || typeof onEnded !== 'function') return () => {}

	let stopped = false
	let lastFiredAt = 0
	const checkNow = () => {
		if (stopped) return
		// 終了ガイド（＝見ている番組が終わった）か、最初から終了していたページ（＝自動移動の飛び先）。
		if (!detectProgramEndGuide() && !wasLoadedAlreadyEnded()) {
			// ガイドが消えたら再武装（次の番組終了で即発火できるようにする）
			lastFiredAt = 0
			return
		}
		// ガイド表示中は最小間隔でのみ onEnded を再発火（自己駆動ループ・API暴走の防止）
		const now = Date.now()
		if (now - lastFiredAt < PROGRAM_END_RECHECK_MIN_INTERVAL_MS) return
		// **今回が「再武装してから最初の検知」か**を呼び出し側へ伝える（doc/09 項目BI-3）。
		// 受け手はこれを見て、リストの強制取り直しを1回だけに絞る。
		// 2回目以降まで取り直すと、移動先が見つからないページで 20秒ごとの取得が止まらない。
		const firstSinceArmed = lastFiredAt === 0
		lastFiredAt = now
		onEnded(firstSinceArmed)
	}

	// 即時チェック
	checkNow()

    const mo = new MutationObserver(() => {
        checkNow()
    })
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })

	return () => {
		stopped = true
		try { mo.disconnect() } catch (_e) {}
	}
}

export { observeProgramEnd, markAutoNextHop }


