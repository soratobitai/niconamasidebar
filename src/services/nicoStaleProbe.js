/**
 * 【一時的な診断】kick.com の「同じ配信者の新旧2番組が残る」（doc/09 項目DD）を捕まえる。
 *
 * 🔴 **これは調査用の使い捨てコード。原因が確定したら丸ごと消すこと**（doc/09 項目DD）。
 *    消す時は「このファイルを削除」＋「kickPage.js の呼び出しと import を削除」＋
 *    「verify-sidebar-loop.mjs の nicoStaleProbeGroup を削除」＋「manifest.json の version_name」の4箇所。
 *
 * ## 🔴 2周目である。1周目（2026-08-19〜27）は何も取れずに終わった
 *
 * 1周目は下の `noteNicoFetch` だけだった。**1行も出ないまま撤去した。**
 * ⚠️ そして「症状が出なかった」のか「診断が載っていなかった／動いていなかった」のかを
 *    **区別できなかった。** 正常時に完全に無音だったので、沈黙が何も意味しない。
 *    これは項目DC で踏んだのと同じ形（doc/09・「仮説の周りしか見ない診断」）。
 *
 * 2周目では口を3つに増やした。**それぞれ独立に鳴る**（1つが黙っても他は鳴る）。
 *
 * | 口 | 何を見るか | いつ鳴るか |
 * |---|---|---|
 * | `probeStartupLine()` | 診断が載っていること自体 | **起動時に必ず1回** |
 * | `noteDuplicateOwners()` | **症状そのもの**（同じ配信者が2枚並ぶ） | 症状が出た時 |
 * | `noteNicoFetch()` | **仮説**（ニコ生の取得だけ失敗して据え置きが続く） | 仮説どおりの時 |
 *
 * 🔴 **`noteDuplicateOwners` が本命になった。** 1周目は仮説の口しか無く、
 *    仮説が外れていた場合に何も残らなかった。症状を直接見る口があれば、
 *    **原因が想定の外にあっても記録が残る。**
 *
 * ## 何を確かめたいのか
 *
 * kick.com のリスト作りはこうなっている（`kickPage.js`）。
 *
 *     const nicoPrograms = dropEndedByAutoNext(nicoRes.ok ? nicoRes.programs : lastNicoPrograms)
 *
 * 仮説: **据え置き（`lastNicoPrograms`）に期限が無い。** ニコ生の取得が失敗し続ける限り、
 * ニコ生のカードは前回の姿のまま固定される。**しかも何も知らせない** —
 * 案内は `bothFailed`（Kick も同時に失敗）でしか出ないため、Kick が生きていれば黙る。
 *
 * 🔴 **仮説を殺せる観測が `fresh` である。** 重複が「取得に成功した周期」に出ていたら、
 *    据え置きは無関係＝**フォローAPI が新旧2番組を返している**ということ。直し方が全く変わる。
 *    1周目に足りなかったのはこの1ビット。
 *
 * ## 出し方の約束（doc/10）
 *
 * - 利用者にコマンドを打たせない。**自動で見張り、状態が変わった時だけ出す。**
 * - 毎周期は出さない。入り口・長引いた時・戻った時の3回だけ。
 */

/** 失敗や重複が続いている時に、途中経過を出す間隔（回）。20秒周期なら約3分ごと。 */
const REPEAT_EVERY = 10

/**
 * 🔴 **起動時に1回だけ出す。これが無いと沈黙が読めない。**
 *
 * 1周目はこの行が無かったので、「症状が出ていない」のか「そもそも診断が載っていない」のかを
 * 最後まで切り分けられなかった。**この行が出ていれば、以降の沈黙は「症状が出ていない」と読める。**
 */
export function probeStartupLine() {
    return '[ニコ生サイドバー 診断DD] 見張りを開始しました（同じ配信者の新旧2番組・ニコ生の取得失敗）。'
        + 'この行が出ていれば診断は動いています。**以降なにも出なければ、症状が起きていないということです。**'
}

// ---------------------------------------------------------------------------
// 口①（本命）: 症状そのもの — 同じ配信者のニコ生番組が2枚以上並んでいないか
// ---------------------------------------------------------------------------

/** 重複の見張り状態を作る。**呼び出し側が1つだけ持つ。** */
export function createDupOwnerState() {
    return { groups: new Map(), cycles: 0 }
}

/**
 * 1周期ぶんの判定。**DOM も console も触らないので、数値だけで検証できる。**
 *
 * @param {object} state `createDupOwnerState()` の戻り値。**破壊的に更新する。**
 * @param {object} input
 *   - `entries` … `[{ key, id, beginMs }]`。`key` は `ownerKeyOf()` が作った配信者キー、
 *                 `id` は番組ID（lv…）、`beginMs` は開始時刻（ms・無ければ NaN/0）
 *   - `now`     … 現在時刻（ms）。**呼び出し側から渡す**（検証で時刻を固定するため）
 *   - `fresh`   … 🔴 **このリストが「取得に成功した周期」のものか。** 仮説を殺せる唯一の材料
 * @returns {null|string} 出すべき1行。出さないなら null
 */
export function noteDuplicateOwners(state, { entries, now, fresh = true }) {
    if (!state || !Array.isArray(entries)) return null

    state.cycles++

    // --- 配信者ごとに束ねて、2枚以上のものを拾う ---
    const byOwner = new Map()
    for (const e of entries) {
        if (!e || !e.key) continue // キーを作れない番組は数えない（判定できないので黙る）
        const list = byOwner.get(e.key) || []
        list.push(e)
        byOwner.set(e.key, list)
    }
    const dup = new Map()
    for (const [key, list] of byOwner) {
        // ⚠️ **同じ番組IDが2回入っているのは重複ではない**（描画側の取り違え）。番組IDで数え直す。
        const ids = [...new Set(list.map((e) => String(e.id || '')))].filter(Boolean)
        if (ids.length >= 2) dup.set(key, list)
    }

    // --- 消えた重複を報告する（「いつ直ったか」が分かると原因が絞れる） ---
    for (const [key, g] of [...state.groups]) {
        if (dup.has(key)) continue
        state.groups.delete(key)
        if (!g.announced) continue
        const secs = Math.round((now - g.since) / 1000)
        return `[ニコ生サイドバー 診断DD] 重複が解消しました（配信者 ${key}・${secs}秒続きました）。`
    }

    if (!dup.size) return null

    // --- 新しく出た重複を1回だけ報告する ---
    for (const [key, list] of dup) {
        const g = state.groups.get(key)
        if (g) continue
        // 🔴 **`cycles` は 1 から始める。** 鳴らせた周期も1周期として数えないと、
        //    途中経過が10周期目ではなく11周期目にずれる（検査で実際に落ちた）。
        state.groups.set(key, { since: now, announced: true, cycles: 1 })
        return `[ニコ生サイドバー 診断DD] 🔴 同じ配信者の番組が ${list.length}件 並んでいます`
            + `（配信者 ${key}）。${describe(list, now)}`
            // 🔴 ここが仮説の生死を決める。**据え置きなら fresh=false、取れているなら fresh=true。**
            + ` ニコ生の取得は${fresh ? '**成功しています（据え置きではありません）**' : '失敗していて据え置き中です'}。`
    }

    // --- 続いている間の途中経過（毎周期は出さない） ---
    for (const [key, g] of state.groups) {
        g.cycles++
        if (g.cycles % REPEAT_EVERY !== 0) continue
        const secs = Math.round((now - g.since) / 1000)
        const list = dup.get(key) || []
        return `[ニコ生サイドバー 診断DD] 重複が ${secs}秒（${g.cycles}周期）続いています`
            + `（配信者 ${key}・${list.length}件）。${describe(list, now)}`
            + ` ニコ生の取得は${fresh ? '成功しています' : '失敗していて据え置き中です'}。`
    }

    return null
}

/** 番組ごとに「ID と、始まってからの経過分」を並べる。**新旧どちらが残っているかを見るため。** */
function describe(list, now) {
    const parts = list.map((e) => {
        const ms = Number(e.beginMs)
        if (!ms || Number.isNaN(ms)) return `${e.id}(開始時刻なし)`
        return `${e.id}(開始から${Math.round((now - ms) / 60000)}分)`
    })
    return parts.join(' / ')
}

// ---------------------------------------------------------------------------
// 口②: 仮説 — ニコ生の取得だけ失敗して据え置きが続いていないか
// ---------------------------------------------------------------------------

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
