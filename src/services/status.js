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
	return !!guide.querySelector('[class*="satisfaction-level-enquete-panel"]')
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
		if (!detectProgramEndGuide()) {
			// ガイドが消えたら再武装（次の番組終了で即発火できるようにする）
			lastFiredAt = 0
			return
		}
		// ガイド表示中は最小間隔でのみ onEnded を再発火（自己駆動ループ・API暴走の防止）
		const now = Date.now()
		if (now - lastFiredAt < PROGRAM_END_RECHECK_MIN_INTERVAL_MS) return
		lastFiredAt = now
		onEnded()
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

export { observeProgramEnd }


