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

// MutationObserver + 軽量ポーリングで終了を検出
function observeProgramEnd(onEnded) {
	const root = document.body
	if (!root || typeof onEnded !== 'function') return () => {}

	let stopped = false
	const checkNow = () => {
		if (stopped) return
		if (detectProgramEndGuide()) onEnded()
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


