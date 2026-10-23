import { endCheckMaxPerCycle } from '../config/constants.js'

/**
 * 【終了した番組をリストから外す】ニコ生ページと kick.com の**両方がこれを使う**（doc/09 項目BF-2・DE）。
 *
 * 🔴 **各ページに写さないこと。** 以前はニコ生ページ（UpdateManager）にしか無く、
 *    kick.com では終わった番組がフォローAPIの手放すまで（実測 40〜240秒）残っていた（項目DD・DE）。
 *    ページごとに違うのは「詳細APIの聞き方」だけなので、それを `fetchStatus` で受け取る:
 *      ニコ生ページ … 自分で叩く（同一オリジン扱いで CORS が通る）
 *      kick.com     … SW に中継してもらう（CORS が live.nicovideo.jp にしか開いていない）
 *
 * 【考え方】**notifybox の不在は「疑い」でしかない。終了かどうかは本人に聞いて確かめる。**
 *
 *   1. notifybox から消えた番組を「終わったかもしれない」とみなす（＝疑い）
 *   2. その番組だけ番組詳細API に問い合わせ、`liveCycle` を見る
 *   3. `ended` なら消す。`on_air` なら残す。**答えが得られなければ消さない**
 *   4. **404（＝その番組は存在しない）も「消す」**。放送中なら必ず 200 が返るため
 *      （2026-08-17 実測）。ただし**全員404の周期は1件も消さない**
 *
 * 🔴 **これは推測ではなく確認なので、notifybox が何件返そうと放送中の番組は消えない。**
 * 2026-08-01 の事故（rows=500 を要求したら5件しか返らず、放送中16件が「終了した」と
 * 誤判定されてカードが消えた）は、この形なら起きない。16件すべてに問い合わせが飛び、
 * すべて `on_air` が返り、1件も消えない。
 *
 * 【なぜ件数で守るのをやめたか】2026-08-01 に件数で守ろうとして3回失敗した:
 *   - 「要求数ぴったり／実績値ちょうど」→ 5件の応答が素通りして事故が起きた
 *   - 「フォローAPIより少なければ怪しい」→ notifybox が先に落とすのが前提なので常に止まる
 *   - 「notifybox が返した範囲より古い番組は触らない」→ **いちばん古い番組が終わると、
 *     基準がそれより新しい番組へ繰り上がり、自分が自動的に範囲の外になる。永久に消えない**
 *     （2026-08-02 に実コードで再現。長時間放送の番組ほど当たる）
 * **不在から終了を導こうとする限り、この手の穴は塞ぎきれない。だから導くのをやめた。**
 *
 * 【速さ】実測 2026-08-02: 詳細APIは番組終了の **0.5〜1.0秒後**には `ended` を返す
 * （応答 約31ms・約2KB）。問い合わせるのは疑いが出た番組だけなので、普段は1周期に0〜数件。
 */

/**
 * 終了と**確認して**消した番組が notifybox に戻ってきた時に1回だけ警告する（鳴る罠）。
 *
 * 🔴 **この判断が誤っていた時の症状は「放送中の番組が黙って画面から消える」で、
 * エラーは一切出ない。** 利用者からは「たまに番組が消える拡張」にしか見えず、原因に辿り着けない。
 *
 * 詳細APIが `ended` と答えた番組しか消さないので、ここが鳴るなら
 * **詳細APIと notifybox が食い違っている**＝前提の作り直しが要る（doc/09 項目BF-2）。
 */
let notifyboxResurrectionWarned = false
function warnNotifyboxResurrection(id) {
    if (notifyboxResurrectionWarned) return
    notifyboxResurrectionWarned = true
    console.warn(
        `[リスト] ${id} を詳細APIで「終了した」と確認して外しましたが、`
        + 'notifybox に戻ってきました。詳細API(`liveCycle`)と notifybox が食い違っています。'
        + '番組終了の確認（doc/09 項目BF-2）を見直してください。'
    )
}

/**
 * 疑いをかけた番組が**全員 404** だった時に1回だけ警告する（鳴る罠）。
 *
 * 🔴 **これが鳴る時、こちらが壊れている可能性のほうが高い**（id の作り方・APIのパスが変わった等）。
 * 404 を「終了した」と読む以上、全員404を素直に信じると**カードが一斉に消える**。
 * その形だけは避ける（doc/09 項目BF-2）。鳴ったら詳細APIのURLと id の正規化を先に見ること。
 */
let allSuspectsNotFoundWarned = false
function warnAllSuspectsNotFound(count) {
    if (allSuspectsNotFoundWarned) return
    allSuspectsNotFoundWarned = true
    console.warn(
        `[終了確認] 問い合わせた${count}件が全部 404 でした。番組が揃って消えたのではなく、`
        + '詳細APIのURLか番組idの作り方が変わった可能性があります。'
        + 'この周期は1件も消していません（doc/09 項目BF-2）。'
    )
}

export class EndedProgramFilter {
    /**
     * @param {{fetchStatus: (liveId: string) => Promise<{data: any|undefined, metaStatus: number}>}} deps
     *   `liveId` は **lv を外した数字**。答えが得られない時は `{data: undefined, metaStatus: 0}` を返すこと
     *   （throw しない）。読み方は api.js の `interpretProgramInfoResponse` に揃える。
     */
    constructor({ fetchStatus }) {
        this._fetchStatus = fetchStatus
        // 番組詳細API に問い合わせて `liveCycle: 'ended'` と**確認できた**番組id。
        // 🔴 **推測で入れないこと。** ここに入れてよいのは詳細APIが終了と答えた番組だけ。
        //    ここに入った番組は聞き直さず、フォローAPIが手放すまで消したままにする。
        //    notifybox に戻ってきたら警告を鳴らして印を落とす（＝食い違いに気付ける）。
        this.confirmed = new Set()
    }

    /**
     * @param {Array<object>} programs 並べる候補（ニコ生ページは和集合、kick.com はフォローAPIの結果）
     * @param {Array<any>|false} notifyList notifybox の生応答（失敗時・権限が無い時は false）
     * @param {(id: string) => boolean} [isKnownEnded] 聞くまでもなく終了と分かっている番組
     *   （自動移動で離れた番組・doc/09 項目CS）。**鳴る罠の対象外**なので `confirmed` には入れない
     * @returns {Promise<Array<object>>} 終了と**確認できた**番組を除いたリスト
     */
    async apply(programs, notifyList, isKnownEnded = () => false) {
        // 消したままにする（＝終了と分かっている番組を落とす）。理由は2つあり、扱いが違う:
        //   `confirmed`     … 詳細APIが ended と答えた。鳴る罠の対象
        //   `isKnownEnded`  … 自動移動が終了を見て離れた。期限つき・鳴る罠の対象外
        const dropConfirmed = (list) => list.filter((p) => {
            const id = p && p.id ? String(p.id) : ''
            return !(id && (this.confirmed.has(id) || isKnownEnded(id)))
        })

        // notifybox の取得に失敗した周期は**新たな疑いを立てない**（通信断で全部消えるのが最悪の壊れ方）。
        // ⚠️ ただし**確認済みの番組は消したままにする**。ここで戻すと、notifybox が不安定な間
        //    「終わった番組が出たり消えたり」を繰り返す。推測で消したのなら戻す価値があるが、
        //    確認して消した番組を notifybox の不調で戻す理由は無い。
        // ⚠️ kick.com で権限がまだ無い利用者もここを通る（false が来る）。**従来どおりの動き**になる。
        if (!Array.isArray(notifyList)) return dropConfirmed(programs)

        const live = new Set()
        for (const row of notifyList) {
            if (row && row.id != null) live.add('lv' + String(row.id).replace(/^lv/, ''))
        }

        // 消した番組が notifybox に戻ってきた＝詳細APIと notifybox が食い違っている。鳴る罠。
        for (const id of live) {
            if (this.confirmed.has(id)) {
                this.confirmed.delete(id)
                warnNotifyboxResurrection(id)
            }
        }

        // 疑い＝notifybox に居ない番組。既に `ended` と確認済みの番組は聞き直さない。
        const suspects = []
        for (const p of programs) {
            const id = p && p.id ? String(p.id) : ''
            // 自動移動で離れた番組は聞くまでもない（聞いても一覧より詳細のほうが遅いことがある）
            if (!id || live.has(id) || this.confirmed.has(id) || isKnownEnded(id)) continue
            suspects.push(id)
        }

        // 1周期の問い合わせ数に上限を置く（notifybox が壊れて大量に疑いが出た時の暴走止め）。
        // ⚠️ あぶれた番組は**次の周期に回るだけ**。消えるのが遅れることはあっても、
        //    間違って消えることはない（確認できていない番組は消さないため）。
        const batch = suspects.slice(0, endCheckMaxPerCycle)
        if (suspects.length > batch.length) {
            console.warn(
                `[終了確認] 疑いが ${suspects.length}件あるため、この周期は ${batch.length}件だけ確認します`
                + '（残りは次の周期）。notifybox の応答が異常に少ない可能性があります。'
            )
        }
        const answers = await Promise.all(batch.map(async (id) => {
            let res
            try {
                res = await this._fetchStatus(String(id).replace(/^lv/, ''))
            } catch (_e) {
                res = null
            }
            // ⚠️ 聞き方が壊れた時も「答えが無い」に倒す（＝消さない）
            const data = res ? res.data : undefined
            const metaStatus = res && Number.isFinite(res.metaStatus) ? res.metaStatus : 0
            return { id, data, metaStatus }
        }))

        // 🔴 **全員が 404 なら、番組ではなくこちらを疑う。**
        //    id の作り方が変わる／APIのパスが変わると、全部が揃って 404 になる。それを
        //    「全部終わった」と読むと**カードが一斉に消える**。失敗の方向は非対称
        //    （消しすぎ ≫ 消し足りない）なので、ここは疑う側に倒す。
        //    ⚠️ 3件未満では判定しない。番組が1〜2件だけ終わって消えるのは普通に起きる。
        const all404 = answers.length >= 3 && answers.every((a) => a.metaStatus === 404)
        if (all404) warnAllSuspectsNotFound(answers.length)

        for (const a of answers) {
            // ⚠️ **答えが得られなかった時（通信断・想定外の応答＝metaStatus 0）は消さない。**
            //    「判断の材料が無い時は消さない」を守る。次の周期にまた聞く。
            if (a.data && a.data.liveCycle === 'ended') { this.confirmed.add(a.id); continue }
            // 🔴 **404 は「答えが無い」ではなく「その番組は存在しない」という答え**（doc/09 項目BF-2）。
            //    放送中の番組は必ず 200 を返す（2026-08-17 実測: 放送中70件すべて 200）ので、
            //    404 なら放送していない。ここを「消さない」に倒していたのが誤りだった。
            //    ⚠️ 見ているのは応答 JSON の `meta.status`。通信断やHTMLの404は metaStatus 0 で来る
            //       ので混ざらない（api.js の interpretProgramInfoResponse）。
            if (a.metaStatus === 404 && !all404) this.confirmed.add(a.id)
        }

        const kept = dropConfirmed(programs)

        // 掃除: 今回のリストにも居ない番組の印は落とす（集合が青天井にならないように）。
        // ⚠️ **消した番組の印は残る**（フォローAPIがまだ返している＝`programs` に居るため）。
        //    それでよい。印が消えるのはフォローAPIもその番組を手放した時＝本当に用が済んだ時。
        //    印を早く落とすと、フォローAPIが返し続けている間ずっと問い合わせ直すことになる。
        const stillRelevant = new Set()
        for (const p of programs) if (p && p.id) stillRelevant.add(String(p.id))
        for (const id of this.confirmed) {
            if (!stillRelevant.has(id)) this.confirmed.delete(id)
        }
        return kept
    }
}
