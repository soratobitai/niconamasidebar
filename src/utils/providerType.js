/**
 * 配信主体の種別を内部モデル（`'user'` | `'channel'`）へ写像する。
 *
 * ニコ生側の観測値（2026-07-31 実測）:
 *   - フォローAPI `providerType`  : `'community'` / `'channel'`
 *   - notifybox   `provider_type` : `'community'` / `'channel'` / `'official'`
 *   - 詳細API     `providerType`  : `'user'` / `'channel'`
 *
 * `'community'` は旧コミュニティ時代の名残で、実体は**ユーザー生放送**である
 * （コミュニティ機能自体はニコ生から廃止済み。API の語彙だけが残っている）。
 *
 * 取得元が3つあっても語彙は同じなので**写像は1つ**にする。取得元ごとに書き直さないこと
 * （doc/02 設計原則 1-b「同じ事実を2箇所に置かない」）。
 *
 * @param {string|undefined} pt 取得元が返す種別文字列
 * @returns {'user'|'channel'}
 */
export function mapProviderType(pt) {
    if (pt === 'channel' || pt === 'official') return 'channel'
    // community / user / 未知 は user 扱い（ライブサムネは liveScreenshotThumbnailUrls 経路で拾う）
    return 'user'
}
