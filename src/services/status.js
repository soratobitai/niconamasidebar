function detectProgramEndGuide() {
	// ハッシュ付きクラスのため部分一致で検出
	const guide = document.querySelector('[class*="program-end-guide"]')
	if (!guide) return false

	// 子要素の構造を確認（テキストは見ない）
	const hasAnnouncement = !!guide.querySelector('[class*="announcement"]')
	const hasNextActionArea = !!guide.querySelector('[class*="next-action-area"]')
	const hasRequestButton = !!guide.querySelector('button[class*="broadcast-request-send-button"]')

	return hasAnnouncement && hasNextActionArea && hasRequestButton
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


