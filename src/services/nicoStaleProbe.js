/**
 * 【一時的な診断】kick.com で「ニコ生の取得だけ失敗して据え置きが続いている」ことを捕まえる。
 *
 * 🔴 **これは調査用の使い捨てコード。原因が確定したら丸ごと消すこと**（doc/09 項目DD）。
 *    消す時は「このファイルを削除」＋「kickPage.js の呼び出し1行と import を削除」＋
 *    「verify-sidebar-loop.mjs の nicoStaleProbeGroup を削除」の3箇所。
 *
 * ## 何を追っているか
 *
 * kick.com のリスト作りはこうなっている（`kickPage.js`）。
 *
 *     const nicoPrograms = dropEndedByAutoNext(nicoRes.ok ? nicoRes.programs : lastNicoPrograms)
 *
 * 🔴 **据え置き（`lastNicoPrograms`）に期限が無い。** ニコ生の取得が失敗し続ける限り、
 *    ニコ生のカードは前回の姿のまま固定される。**しかも何も知らせない** —
 *    案内は `bothFailed`（Kick も同時に失敗）でしか出ないため、Kick が生きていれば黙る。
 *
 * これで利用者の報告4点がすべて説明できる（2026-08-19）:
 *   ずっと残る／更新ボタンが効かない／他のカードは動いている／リロードで直る
 *
 * ⚠️ **まだ「失敗しているか」を見ていない。** 失敗していなければこの筋は外れなので、
 *    **理由つきで**記録する。理由が分かるまで直しに入らない。
 *
 * ## 出し方の約束（doc/10）
 *
 * - 利用者にコマンドを打たせない。**自動で見張り、状態が変わった時だけ出す。**
 * - 毎周期は出さない。失敗の入り口・長引いた時・回復した時の3回だけ。
 */

/** 失敗が続いている時に、途中経過を出す間隔（回）。20秒周期なら約3分ごと。 */
const REPEAT_EVERY = 10

/** 新しい見張り状態を作る。**呼び出し側が1つだけ持つ。** */
export function createNicoStaleState() {
    return { failingSince: 0, cycles: 0, lastReason: '', staleCount: 0, announced: false }
}

/**
 * 1周期ぶんの判定。**DOM も console も触らないので、数値だけで検証できる。**
 *
 * @param {object} state `createNicoStaleState()` の戻り値。**破壊的に更新する。**
 * @param {object} input
 *   - `ok`        … ニコ生の取得に成功したか
 *   - `reason`    … 失敗の理由（`fetchNicoPrograms` / SW が返す文字列）
 *   - `now`       … 現在時刻（ms）。**呼び出し側から渡す**（検証で時刻を固定するため）
 *   - `staleCount`… 据え置きで表示することになる番組数
 *   - `kickOk`    … Kick 側は成功しているか。**両方失敗なら案内が出るので、ここでは騒がない**
 * @returns {null|string} 出すべき1行。出さないなら null
 */
export function noteNicoFetch(state, { ok, reason, now, staleCount = 0, kickOk = true }) {
    if (!state) return null

    if (ok) {
        // 🔴 **回復も出すこと。** 失敗の入り口だけだと「いつまで続いたか」が分からない。
        if (!state.failingSince) return null
        const secs = Math.round((now - state.failingSince) / 1000)
        const cycles = state.cycles
        state.failingSince = 0
        state.cycles = 0
        state.lastReason = ''
        state.staleCount = 0
        state.announced = false
        return `[ニコ生サイドバー 診断DD] ニコ生の取得が回復しました（${secs}秒・${cycles}周期ぶん据え置いていました）。`
    }

    state.cycles++
    state.lastReason = String(reason || 'unknown')
    state.staleCount = staleCount

    // ⚠️ **両方失敗している間は黙る。** その時は画面に案内が出ており、
    //    利用者から見て「黙って古いまま」ではない。追いたいのは**ニコ生だけ落ちる**形。
    if (!kickOk) {
        if (!state.failingSince) state.failingSince = now
        return null
    }

    // 🔴 **「初回の失敗」ではなく「初めて黙っていられなくなった時」に出すこと。**
    //    Kick も落ちていた間は黙っていたので、Kick だけ先に戻ると
    //    `failingSince` は既に立っている。そこで「初回か」で判定すると、
    //    **画面から案内が消えたのに10周期ぶん黙り続ける**（検査 DD で実際に落ちた）。
    if (!state.failingSince) state.failingSince = now
    if (!state.announced) {
        state.announced = true
        const el = Math.round((now - state.failingSince) / 1000)
        return `[ニコ生サイドバー 診断DD] ニコ生の取得だけ失敗しました（理由 ${state.lastReason}`
            + `${el > 0 ? `・${el}秒経過` : ''}）。`
            + `ニコ生のカード ${staleCount}件 を前回の内容のまま表示しています。`
            + 'この状態が続くと、終了した番組が残り続けます。'
    }

    if (state.cycles % REPEAT_EVERY === 0) {
        const secs = Math.round((now - state.failingSince) / 1000)
        return `[ニコ生サイドバー 診断DD] ニコ生の取得が ${secs}秒（${state.cycles}周期）失敗し続けています`
            + `（理由 ${state.lastReason}）。ニコ生のカード ${staleCount}件 は据え置きのままです。`
    }

    return null
}
