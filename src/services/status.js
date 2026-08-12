
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

// オリジンをまたぐ移動用の印。
// 🔴 **`sessionStorage` はオリジンごと。**ニコ生 ⇄ kick.com を行き来する自動移動では
//    飛んだ先で読めない（2026-08-07 に Kick 対応を入れる時に気付いた）。
//    拡張のストレージにも同じ印を置き、**飛び先の識別子つき**で持つ。
//    識別子で照合するので、読まれずに残った古い印が別のページで誤って効くことはない。
const AUTO_NEXT_HOP_STORE_KEY = 'autoNextHop'

/**
 * 自動移動で**離れる**番組の印（doc/09 項目CS・2026-08-12）。
 *
 * 【なぜ要るか】終了検知は「一覧APIに載っていない番組を詳細APIに聞く」形なので、
 * **一覧APIがまだその番組を載せている間は疑いにすらならない。**
 * 2026-08-12 の実測: 番組が `ended` になった時点で一覧APIはまだ載せており、
 * 消えるのはその後（15秒刻みで測って2件とも1周ぶん＝0〜30秒）。
 * 自動移動が一覧を取りに行くのは「終了 → 10秒カウント → 遷移 → 300ms」で**約15〜20秒後**。
 * **窓が重なっているので、終わった番組のカードが次の定期更新まで残ることがある。**
 *
 * 🔴 **推測ではない。** 自動移動は「その番組が終わった」のを自分で見ており、それが移動の
 *    きっかけである。持ち越していなかったのは、ページを移ると記憶が消えるからでしかない。
 *    ここで持ち越せば、ニコ生側の反映が何秒かかろうと関係なくなる。
 *
 * ⚠️ **hop の印（`autoNextHop`）に相乗りさせないこと。** あちらは
 *    `consumeAutoNextHopMark` が**1回で使い切って消す**（視聴回数を数えるために早い段階で
 *    呼ばれる）。同じ器に入れると、リスト側が読む前に消える。
 */
const AUTO_NEXT_ENDED_STORE_KEY = 'autoNextEnded'

/**
 * `nico:lv123` → `lv123`。それ以外は空文字。
 *
 * ⚠️ **ニコ生だけを対象にする。** Kick は「今回のリストに居ない＝終了」で判定でき、
 *    詳細APIに聞く仕組み自体が無い（doc/09 項目BX）。
 */
function nicoProgramIdOf(targetId) {
	const m = /^nico:(lv\d+)$/.exec(String(targetId || ''))
	return m ? m[1] : ''
}

/**
 * 移動する直前に印を置く（AutoNextManager から呼ぶ）。
 *
 * 🔴 **2つの印を1回の呼び出しで書く。** 呼び出し側は2箇所（カウントダウン満了・サムネクリック）
 *    あり、別々の関数にすると片方だけ足し忘れる。書き込みも1回の `set` にまとめてある
 *    （直後に `location.assign` するので、往復は少ないほうがよい）。
 *
 * @param {string} [targetId] 飛び先の識別子（`watchTargetIdOf` の形）。オリジンをまたぐ時に使う
 * @param {string} [endedTargetId] **今いる（＝終わった）**番組の識別子。飛び先でリストから外すのに使う
 */
function markAutoNextHop(targetId, endedTargetId) {
	try { sessionStorage.setItem(AUTO_NEXT_HOP_KEY, String(Date.now())) } catch (_e) {}
	const at = Date.now()
	const endedId = nicoProgramIdOf(endedTargetId)
	try {
		chrome.storage.local.set({
			[AUTO_NEXT_HOP_STORE_KEY]: { at, to: String(targetId || '') },
			...(endedId ? { [AUTO_NEXT_ENDED_STORE_KEY]: { at, id: endedId } } : {}),
		})
	} catch (_e) { /* 拡張が無効化されていれば置けないだけ */ }
}

/**
 * 「自動移動で離れた番組」を1回だけ受け取る（飛び先のページが起動時に呼ぶ）。
 *
 * 🔴 **読んだら消す。** 残すと、あとで利用者が自分でその番組を開き直した時にも効いてしまう。
 * ⚠️ 期限切れ（`AUTO_NEXT_HOP_VALID_MS`）は無視する。放置された古い印で番組を隠さない。
 *
 * @returns {Promise<string>} `lv123` 形式。無ければ空文字
 */
async function takeEndedByAutoNext() {
	try {
		const got = await chrome.storage.local.get(AUTO_NEXT_ENDED_STORE_KEY)
		const mark = got && got[AUTO_NEXT_ENDED_STORE_KEY]
		if (!mark || typeof mark !== 'object') return ''
		try { chrome.storage.local.remove(AUTO_NEXT_ENDED_STORE_KEY) } catch (_e) {}
		if (!Number.isFinite(mark.at) || Date.now() - mark.at > AUTO_NEXT_HOP_VALID_MS) return ''
		return /^lv\d+$/.test(String(mark.id)) ? String(mark.id) : ''
	} catch (_e) {
		return ''
	}
}

/**
 * このページが「自動移動で飛んできた先」かを1回だけ判定して、印を消す。
 * **オリジンをまたいでも読める版**（kick.com 側が使う）。
 *
 * 🔴 **飛び先の識別子が一致する時だけ true。** 一致で縛らないと、読まれずに残った印が
 *    「あとから利用者が自分で開いたページ」にまで効いてしまい、
 *    **見始めた瞬間に別の配信へ連れて行かれる。**
 *
 * @param {string} currentId 今いるページの識別子（`watchTargetIdOf(location.href)`）
 * @returns {Promise<boolean>}
 */
async function consumeAutoNextHopMark(currentId) {
	if (!currentId) return false
	try {
		const got = await chrome.storage.local.get(AUTO_NEXT_HOP_STORE_KEY)
		const mark = got && got[AUTO_NEXT_HOP_STORE_KEY]
		if (!mark || typeof mark !== 'object') return false
		// 印は1回で使い切る。残すと次に開いたページでも効いてしまう。
		try { chrome.storage.local.remove(AUTO_NEXT_HOP_STORE_KEY) } catch (_e) {}
		if (!Number.isFinite(mark.at) || Date.now() - mark.at > AUTO_NEXT_HOP_VALID_MS) return false
		return mark.to === currentId
	} catch (_e) {
		return false
	}
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

export { observeProgramEnd, markAutoNextHop, consumeAutoNextHopMark, takeEndedByAutoNext }


