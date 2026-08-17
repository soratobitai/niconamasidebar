/**
 * 【Kick連携のお知らせ】設定アイコンの下に、機能が増えたことを1回だけ知らせる小さな案内。
 *
 * 【なぜ要るか】Kick連携は 1.13.0 で入ったが、導線が
 * 「サイドバーを開く → 設定を開く → 下までスクロール → 拡張の設定ページへ移動」の4手あり、
 * **下まで見た人しか存在を知り得ない。** 既に使っている利用者に気付いてもらう手段が無かった。
 *
 * 🔴 **既定値を変えて知らせることはできない**（doc/06）。`getOptions` が
 *    `{...defaults, ...stored}` を書き戻すので、既存利用者の storage には既に既定が焼き付いている。
 *    **届いてほしい人にだけ届かない。** だから画面に出す。
 *
 * 🔴 **保存キーを `optionKeys` に入れないこと。** これは「設定」ではなく一度きりのUI状態。
 *    入れると `getOptions` が毎回書き戻す対象になり、`saveOptions` の巻き添えも受ける。
 *    **キーが在る＝消した**、無ければ未読。既定値を持たせる必要がそもそも無い。
 *
 * ⚠️ **ニコ生ページだけに出す。** kick.com のサイドバーは連携が有効な時しか出ないので、
 *    あちらに出す意味が無い（両ページへ配線する決まりの、意図的な例外。検査 DA で固定）。
 */

/** 消したことを覚えるキー。**`optionKeys` には入れない**（上記）。 */
export const KICK_INTRO_KEY = 'kickIntroDismissed'

/**
 * 案内を出してよいか。
 *
 * 🔴 **Kick を既に有効にしている人には出さない。** 知っている人に知らせても邪魔なだけ。
 * ⚠️ **判断できない時は出さない。** storage が読めない・SW が答えない場合に出すと、
 *    一度消したはずの案内が復活する（消したことを確かめられないため）。壊れ方は「出ない」側へ倒す。
 *
 * @param {{dismissed: boolean, kickGranted: boolean}} state
 * @returns {boolean}
 */
export function shouldShowKickIntro(state) {
    if (!state) return false
    return state.dismissed === false && state.kickGranted === false
}

/**
 * 消したかどうかを読む。**キーが在れば消した**。
 * @returns {Promise<boolean>} 読めなければ true（＝出さない側へ倒す）
 */
export function readKickIntroDismissed() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(KICK_INTRO_KEY, (res) => {
                if (chrome.runtime.lastError) { resolve(true); return }
                resolve(!!(res && res[KICK_INTRO_KEY]))
            })
        } catch (e) {
            resolve(true) // 拡張が無効化済み
        }
    })
}

/**
 * Kick連携が有効か（SW に聞く。`chrome.permissions` が唯一の真実）。
 * ⚠️ **答えが得られない時は true を返す**（＝出さない側へ倒す）。SW が寝ている・拡張が
 *    無効化された、といった状況で「まだ知らない人」と決めつけて出すほうが害が大きい。
 * @returns {Promise<boolean>}
 */
export function readKickGranted() {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: 'kick:status' }, (res) => {
                if (chrome.runtime.lastError) { resolve(true); return }
                resolve(!!(res && res.granted))
            })
        } catch (e) {
            resolve(true)
        }
    })
}

/**
 * 消したことを保存する。**別タブへは `storage.onChanged` が伝える**（自前で配らない）。
 * @returns {Promise<void>}
 */
export function saveKickIntroDismissed() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.set({ [KICK_INTRO_KEY]: true }, () => {
                // lastError を読んでおかないと未処理エラーとして残る。保存できなくても画面は閉じる。
                void chrome.runtime.lastError
                resolve()
            })
        } catch (e) {
            resolve()
        }
    })
}
