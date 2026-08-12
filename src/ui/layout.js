import { cardSizes, defaultCardSize } from '../config/constants.js'

export function adjustWatchPageChild(elems) {
	if (!elems || !elems.root) return

	let maxWidth = 1024 + 'px'
	let minWidth = 1024 + 'px'
	let width = 1024 + 'px'
	const watchPageChildren = [
		elems.playerSection,
		elems.programInformationBodyArea,
		elems.siteFooterUtility,
		elems.gaNsProgramSummary,
		elems.enquetePlaceholder,
	]

	const watchPageWidth = elems.watchPage ? elems.watchPage.clientWidth : 0

	if (isScreenSizeAuto()) {
		if (watchPageWidth > 1152 && watchPageWidth < 1500) {
			maxWidth = watchPageWidth - 128 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 3.55556 + 'px'
		}
		if (watchPageWidth > 1500 && watchPageWidth < 1792) {
			maxWidth = watchPageWidth - 128 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 220.44444 + 'px'
		}
		if (watchPageWidth > 1792) {
			maxWidth = 1664 + 'px'
			minWidth = 1024 + 'px'
			width = window.innerHeight * 1.777778 - 220.44444 + 'px'
		}
	}

	if (isFullScreen()) {
		maxWidth = '100%'
		minWidth = '100%'
		width = '100%'
	}

	watchPageChildren.forEach((elem) => {
		if (!elem) return
		elem.style.maxWidth = maxWidth
		elem.style.minWidth = minWidth
		elem.style.width = width
	})

	if (elems.watchPage && elems.watchPage.hasAttribute('data-player-layout-mode') && isScreenSizeAuto()) {
		if (elems.playerSection) {
			elems.playerSection.style.maxWidth = 'none'
			elems.playerSection.style.width = 'auto'
		}
		if (elems.leoPlayer && elems.root) {
			elems.leoPlayer.style.height = elems.root.clientWidth * 0.5625 - 164 + 'px'
		}
	} else {
		if (elems.leoPlayer) elems.leoPlayer.style.height = 'auto'
	}

	const playerDisplay = document.querySelector('[class*="_player-display_"]')
	if (playerDisplay) playerDisplay.removeAttribute('style')
}

// いま選ばれているカードの大きさ。**設定は各ページの初期化と storage.onChanged から流し込む。**
// ⚠️ 引数で渡す形にしなかったのは、setProgramContainerWidth の呼び出しが10箇所あり、
//    片方のページで1つ渡し忘れると**そこだけ既定に戻る**という無言の壊れ方をするため
//    両ページが setCardSize を呼ぶことは検査で縛っている。
let currentCardSize = defaultCardSize

/** 設定「カードの大きさ」を反映する。次に描画/幅計算した時から効く。 */
export function setCardSize(size) {
	currentCardSize = cardSizes[size] ? size : defaultCardSize
}

/** いまのカードの大きさの定義。知らない値なら既定へ落とす（NaN を外へ出さない）。 */
function cardSizeDef() {
	return cardSizes[currentCardSize] || cardSizes[defaultCardSize]
}

/**
 * サイドバー幅と「カードの大きさ」から列数を出す。**副作用なし。**
 *
 * サイドバー幅が各しきい値を超えるごとに列数を +1（既定で 300px以下=1列 … 1500px超=8列）。
 * しきい値に `columnFactor` を掛けることで、同じ幅でも列の増え方を変える。
 *   倍率が大きい＝しきい値が遠い＝**列が増えにくい＝1枚が広い**
 *
 * ⚠️ `medium`（倍率1）の結果は従来の式と**完全に同じ**でなければならない。既定値なので、
 *    ここがずれると全利用者のレイアウトが黙って変わる。
 *
 * @param {number} sidebarWidth サイドバーの幅(px)
 * @param {string} [size] 'small' | 'medium' | 'large'。省略時は setCardSize で設定した値
 * @returns {number} 列数（1以上）
 */
export function columnsForWidth(sidebarWidth, size) {
	const def = size === undefined ? cardSizeDef() : (cardSizes[size] || cardSizes[defaultCardSize])
	const columnBreakpoints = [300, 500, 700, 900, 1100, 1300, 1500]
	// ⚠️ NaN や 0 のガードは要らない。columns は 1 から始めて増やすだけで、
	//    NaN との比較はすべて false になるので、壊れた入力でも 1 に落ち着く。
	//    （ガードを置いていたが、外しても結果が変わらない＝死んだコードだったので消した）
	const w = Number(sidebarWidth)
	let columns = 1
	for (const bp of columnBreakpoints) {
		if (w > bp * def.columnFactor) columns++
	}
	return columns
}

export function setProgramContainerWidth(elems, sidebarWidth) {
	const columns = columnsForWidth(sidebarWidth)
	const programContainerWidth = 100 / columns + '%'

	// カードの中身（アイコン・文字）の倍率。列数が変わらない幅でも見た目が変わるようにする。
	// ⚠️ 変数を置くのはカードの親。カード側は継承で受ける。
	//    JS が入れなくても CSS 側の既定 1 が効くので、呼ばれなくても今までどおりになる。
	const container = document.getElementById('liveProgramContainer')
	if (container) container.style.setProperty('--nns-card-scale', String(cardSizeDef().contentScale))

	// カード幅のみ設定する。サムネ幅は CSS の `.program_thumbnail { width: 100% }` でカードいっぱいになる。
	// （旧コードは thumbnail に `programContainerWidth + 'px'`＝例 '50%px' という無効値を代入しており、
	//  ブラウザに無視されて実質何もしていなかった＝バグ。有効値 '50%' にすると逆にサムネがカードの半分に
	//  縮む回帰になるため、正しい挙動＝CSSの100%を保つべく当該行を削除した。）
	document.querySelectorAll('.program_container').forEach((element) => {
		element.style.width = programContainerWidth
	})
}

function isScreenSizeAuto() {
	const value = localStorage.getItem('LeoPlayer_ScreenSizeStore_kind')
	if (!value) return true
	return value.includes('auto')
}

function isFullScreen() {
	const htmlTag = document.getElementsByTagName('html')[0]
	return htmlTag.hasAttribute('data-browser-fullscreen')
}


