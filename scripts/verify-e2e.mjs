/**
 * 実ブラウザでの検証（doc/10 ブロックD の D3 実機版・D7）
 *
 *   npm run verify:e2e
 *
 * 本物の Chrome に dist/ の拡張を読ませ、視聴ページとAPIの応答だけこちらで差し替える。
 * **niconico へのログインは不要**で、実サーバには一切アクセスしない。所要 約9分。
 * 検証用の一時プロファイルで起動するので、普段使いの Chrome には影響しない。
 *
 * 【前提】`npm i` 済み（playwright-core）＋ `npm run build` 済み（dist/ が最新であること）。
 *
 * 【Chrome 150 以降の注意】`--load-extension` は無視される（セキュリティ強化で無効化された）。
 * 回避フラグ（--disable-features=DisableLoadExtensionCommandLineSwitch /
 * --enable-unsafe-extension-debugging）も効かない。後継の CDP `Extensions.loadUnpacked` を使う。
 *
 * 【D6 がここに無い理由】CDP で操作しているページを Chrome は常に visible 扱いにするため、
 * 自動化から本物の「裏タブ」状態を作れない（別タブ前面化・ウィンドウ最小化・
 * Page.setWebLifecycleState('frozen') を試して全滅。Emulation.setPageVisibilityOverride は
 * 現行 Chrome に存在しない）。D6 は `npm run verify:loop` のソース検査で代替している。
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { deflateSync } from 'zlib'

let chromium
try {
    ({ chromium } = await import('playwright-core'))
} catch (_) {
    console.error('playwright-core が見つかりません。`npm i` を実行してください。')
    process.exit(2)
}

const CHROME_CANDIDATES = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
    console.error('Chrome が見つかりません。CHROME_CANDIDATES にパスを追加してください。')
    process.exit(2)
}

const EXT = new URL('../dist/', import.meta.url).pathname.replace(/^\//, '')
if (!existsSync(join(EXT, 'manifest.json'))) {
    console.error(`dist/manifest.json がありません（${EXT}）。先に npm run build を実行してください。`)
    process.exit(2)
}

const PORT = 9334
const WATCH = 'https://live.nicovideo.jp/watch/lv100000001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
let failures = 0
const check = (label, ok, detail) => {
    log(`${ok ? '  OK  ' : '  NG  '} ${label}`)
    if (detail) log(`       ${detail}`)
    if (!ok) failures++
}

// ---- 差し替える応答 -------------------------------------------------------
const PROGRAMS = Array.from({ length: 4 }, (_, i) => ({
    id: `lv20000000${i + 1}`, title: `テスト番組${i + 1}`, providerType: 'community',
    listingThumbnail: `https://dlive.nicovideo.jp/thumb/lv2000000${i + 1}.jpg`,
    programProvider: { id: `${1000 + i}`, name: `配信者${i + 1}`, icon: '' },
    statistics: { watchCount: 10 * (i + 1), commentCount: i },
    beginAt: Date.now() - 600000, isFollowerOnly: false, liveCycle: 'ON_AIR',
    watchPageUrl: `https://live.nicovideo.jp/watch/lv20000000${i + 1}`,
}))
// notifybox の1行は id/title だけではない（実測のキー名に合わせる）。
// community_name / thumbnail_url は**コミュニティ廃止後もキー名だけ残っているレガシー名**で、
// 中身は配信者名と配信者アイコン。新着カードはこれで名前・アイコンを出す（doc/09 項目AT）。
const NOTIFYBOX = {
    meta: { status: 200 },
    data: {
        notifybox_content: PROGRAMS.map((p, i) => ({
            id: p.id.replace('lv', ''),
            title: p.title,
            community_name: p.programProvider.name,
            thumbnail_url: `https://secure-dcdn.cdn.nimg.jp/nicoaccount/usericon/10/${1000 + i}.jpg`,
            provider_type: 'community',
            elapsed_time: 600,
        })),
    },
}
const FOLLOW = { data: { programs: PROGRAMS, total: PROGRAMS.length } }
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>テスト視聴ページ</title></head>
<body><div id="watchPage"><div id="root"><div style="height:100vh">プレイヤー相当</div></div></div></body></html>`
// ---- ライブサムネの差し替え画像 ----
// 「どのコマがどの取得に対応するか」を見分けられるよう、取得ごとに違う単色PNGを返す。
// ⚠️ **同じURLでも2回目の取得には別の色を返す**。①がプリロードと表示で別々にダウンロードしていた頃は、
//    この2枚が食い違うと「画面に出ている絵がアニメのどのコマにも無い」状態になった（doc/09 項目AV）。
//    今は静止サムネにも給餌したコマそのものを出すので2回目の取得自体が起きない＝この仕掛けに引っかからない。
const crcTable = (() => {
    const t = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
    return t
})()
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
const pngChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
}
function solidPng(r, g, b, size = 32) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
    const raw = Buffer.alloc(size * (size * 3 + 1))
    for (let y = 0; y < size; y++) {
        const off = y * (size * 3 + 1)
        raw[off] = 0
        for (let x = 0; x < size; x++) { raw[off + 1 + x * 3] = r; raw[off + 2 + x * 3] = g; raw[off + 3 + x * 3] = b }
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
const colorOf = new Map()   // "<cache値>|<何回目>" -> 色
const thumbHits = []        // 画像取得のログ（1URLあたり何回取ったかの検証に使う）
const urlSeen = new Map()
let colorCounter = 0
function colorFor(key) {
    if (!colorOf.has(key)) {
        colorCounter++
        colorOf.set(key, { r: (colorCounter * 37) % 200 + 20, g: (colorCounter * 91) % 200 + 20, b: (colorCounter * 53) % 200 + 20, n: colorCounter })
    }
    return colorOf.get(key)
}

// ---- 起動 -----------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'nnsb-e2e-'))
const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', 'about:blank',
], { stdio: 'ignore' })

for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break } catch (_) {}
    await sleep(250)
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
const bs = await browser.newBrowserCDPSession()
const loaded = await bs.send('Extensions.loadUnpacked', { path: EXT.replace(/\/$/, '') })
const EXT_ID = loaded && loaded.id
log('拡張を読み込みました（CDP Extensions.loadUnpacked）')

const ctx = browser.contexts()[0]
let hits = []           // リスト取得（フォローAPI）の到達時刻
let notifyboxHits = 0   // notifybox の呼び出し回数（和集合方式なので呼ばれるのが正常）
let slow = false   // 応答を遅らせるか（D7用）

const page = await ctx.newPage()
await page.route('**/*', async (route) => {
    const u = route.request().url()
    if (u.includes('notifybox.content.php')) {
        // 和集合方式（doc/09 項目AD）。notifybox は「早さ」担当として併用している。
        notifyboxHits++
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NOTIFYBOX) })
    }
    if (u.includes('/front/api/pages/follow/v1/programs')) {
        hits.push(Date.now())   // リスト取得の回数＝フォローAPIの呼び出し回数
        if (slow) await sleep(6000)
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FOLLOW) })
    }
    if (u.includes('dlive.nicovideo.jp')) {
        const m = /[?&]cache=(\d+)/.exec(u)
        const cache = (m ? m[1] : 'none') + '@' + u.replace(/[?&]cache=\d+/, '')
        const seen = (urlSeen.get(cache) || 0) + 1
        urlSeen.set(cache, seen)
        const c = colorFor(cache + '|' + seen)
        thumbHits.push({ url: cache, n: c.n, seen })
        // crossOrigin='anonymous' の給餌が通るよう ACAO を返す（本番の dlive も返している）
        return route.fulfill({
            status: 200, contentType: 'image/png',
            headers: { 'access-control-allow-origin': '*' },
            body: solidPng(c.r, c.g, c.b),
        })
    }
    if (u.startsWith('https://live.nicovideo.jp/watch/')) {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML })
    }
    return route.fulfill({ status: 204, body: '' })
})

await page.goto(WATCH, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#sidebar', { state: 'attached', timeout: 20000 })
const isOpen = () => page.evaluate(() => (document.getElementById('sidebar')?.getBoundingClientRect().width ?? 0) > 50)
if (!(await isOpen())) await page.click('#sidebar_button')
await page.waitForTimeout(3000)
const cards = await page.locator('#liveProgramContainer > *').count()
check('拡張が実際に動作し、差し替えたAPIの内容でカードを描画する', cards === PROGRAMS.length,
    `カード ${cards} 件（期待 ${PROGRAMS.length} 件）`)

// 更新間隔を最短の30秒に（既定120秒だと検証が長くなりすぎる。観測時間はこの値から逆算している）
await page.click('#setting_options'); await page.waitForTimeout(500)
await page.click('label[for="updateProgramsInterval30"]'); await page.waitForTimeout(500)
await page.click('#settings_close'); await page.waitForTimeout(500)
check('更新間隔を30秒に設定できた',
    await page.evaluate(() => !!document.querySelector('#updateProgramsInterval30')?.checked))

// ============================================================
// D3（実機版）: 閉じた状態で起動 → 開くと定期取得が動き出すか
// ============================================================
log('\n=== D3: 閉じた状態で起動 → 開くと定期取得が復活するか ===')
await page.click('#sidebar_button')          // 閉じる（この状態が chrome.storage に残る）
await page.waitForTimeout(1000)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#sidebar', { state: 'attached', timeout: 20000 })
await page.waitForTimeout(2000)
check('D3 前提: 再読み込み後はサイドバーが閉じている', !(await isOpen()))

// 観測時間は更新間隔（30秒）から逆算した値。60秒設定だった頃は 90秒/150秒 待っていた。
//   - 閉じている間: 壊れていれば30秒間隔で1〜2回飛ぶので、45秒あれば「0回」で捕まえられる。
//   - 開いた後: 開いた直後の手動更新のあと、およそ32秒後・64秒後に定期取得が走る（周期は
//     「作業完了後に30秒」なので少し後ろへずれる）。80秒待てば2回そろい、余裕は約16秒。
// ⚠️ ここを縮めるなら、必ず「何秒後に何回走るか」を数えてからにすること。余裕を削りすぎると
//    実装は正しいのに落ちる「偽のNG」になり、検証への信頼が下がる。
hits = []
log('   閉じたまま 45秒 観測中…')
await page.waitForTimeout(45000)
check('D3-a 閉じている間はリスト取得をしない', hits.length === 0, `リスト取得 ${hits.length} 回`)

await page.click('#sidebar_button')          // 開く
await page.waitForTimeout(3000)
hits = []                                     // 開いた瞬間の手動更新ぶんを除外
log('   開いてから 80秒 観測中（30秒周期なら2回前後）…')
await page.waitForTimeout(80000)
check('D3-b 開いた後に定期取得が動き出す（最重要）', hits.length >= 2,
    `開いた後の定期取得 ${hits.length} 回。ここが0だとループが死んでいる（例外もログも出ないので、この項目でしか気付けない）`)

// ============================================================
// D7: 取得中に閉じてもスピナーが固着しないか
// ============================================================
log('\n=== D7: 取得中にサイドバーを閉じてもスピナーが固着しないか ===')
if (!(await isOpen())) { await page.click('#sidebar_button'); await page.waitForTimeout(2000) }
slow = true
await page.click('#reload_programs')
await page.waitForTimeout(1500)
check('D7 前提: 更新ボタンがスピナー状態になる',
    (await page.locator('#reload_programs.loading').count()) === 1)
await page.click('#sidebar_button')          // 取得中に閉じる
await page.waitForTimeout(800)
await page.click('#sidebar_button')          // すぐ開き直す
await page.waitForTimeout(1000)
slow = false
await page.waitForTimeout(15000)             // 遅延6秒＋最低表示1秒 を十分に超えて待つ

check('D7-a 取得中に閉→開してもスピナーが固着しない',
    (await page.locator('#reload_programs.loading').count()) === 0)
const pe = await page.evaluate(() => document.getElementById('reload_programs')?.style.pointerEvents ?? '')
check('D7-b 更新ボタンが押せる状態に戻る', pe !== 'none', `pointerEvents="${pe}"`)

check('notifybox とフォローAPIの両方を叩いている（和集合方式）', notifyboxHits > 0 && hits.length > 0,
    `notifybox ${notifyboxHits} 回 / フォローAPI ${hits.length} 回`)

// ============================================================
// AU: 終了ガイドの「形」が違っても自動移動が発火するか
//
// 旧実装は `broadcast-request-send-button` を必須にしていた。この欄はニコ生側で
// 「ユーザー生放送 かつ 配信者が放送リクエストを有効」の時しか描画されないため、
// チャンネル/公式番組や、リクエストを無効にしている配信者では**毎回不発**だった。
// 番組終了を待たずに検証できるよう、実測のクラス名で終了ガイドをDOMへ流し込む。
// ============================================================
log('\n=== AU: 終了ガイドの形が違っても自動移動が発火するか ===')

await page.click('#setting_options'); await page.waitForTimeout(500)
await page.click('label[for="autoNextProgramOn"]'); await page.waitForTimeout(500)
await page.click('#settings_close'); await page.waitForTimeout(500)
check('AU 前提: 自動移動をONにできた',
    await page.evaluate(() => !!document.querySelector('#autoNextProgramOn')?.checked))

// クラス名は 2026-07-31 に nicolive のバンドルから採取した実物（ハッシュ付き）。
// 部分一致セレクタで拾えるかまで含めて検証するため、実物の形のまま使う。
const GUIDE = {
    // 視聴者が見る通常の形。リクエスト欄が無い＝旧実装が落ちていたケース
    viewer: '<div class="___announcement___m1Lwh"></div>'
        + '<div class="___next-action-area___BviiO"></div>',
    // リクエスト欄まで出る形（ユーザー生放送＋リクエスト有効）。旧実装でも通っていたケース
    withRequest: '<div class="___announcement___m1Lwh"></div>'
        + '<div class="___next-action-area___BviiO"><div class="___menu-area___RvqMA">'
        + '<section class="___broadcast-request-enlightenment-section___pMG8b ga-ns-broadcast-request-enlightenment-section">'
        + '<button class="___broadcast-request-send-button___pO4YE"></button></section></div></div>',
    // 配信者本人に出る満足度アンケート。この時 announcement / next-action-area は描画されない
    enquete: '<div class="___user-communication-satisfaction-level-enquete-panel___ThZVv '
        + 'ga-ns-user-communication-satisfaction-level-enquete-panel"></div>',
    // 中身が組み上がる前の一瞬。ここで発火すると「まだ終わっていないのに移動する」誤爆になる
    partial: '<div class="___announcement___m1Lwh"></div>',
}

async function endGuideCase(label, inner, expected) {
    // 毎回リロードしてから試す（scheduled / selectingNext / カウントダウンをまっさらに戻す）
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#sidebar', { state: 'attached', timeout: 20000 })
    if (!(await isOpen())) { await page.click('#sidebar_button') }
    await page.waitForTimeout(3000)   // カードが描画されるまで（移動先が無いと発火しない）
    await page.evaluate((html) => {
        const g = document.createElement('div')
        g.className = '___program-end-guide___vJfD8'
        g.innerHTML = html
        document.body.appendChild(g)
    }, inner)

    let shown = false
    const deadline = Date.now() + (expected ? 8000 : 5000)
    while (Date.now() < deadline) {
        if ((await page.locator('#auto_next_modal.show').count()) === 1) { shown = true; break }
        await page.waitForTimeout(250)
    }
    check(label, shown === expected, `モーダル ${shown ? '出た' : '出ない'}（期待 ${expected ? '出る' : '出ない'}）`)
    // カウントダウン(10秒)で実際に遷移してしまう前に止める
    if (shown) { try { await page.click('#auto_next_cancel', { timeout: 2000 }) } catch (_) {} }
}

await endGuideCase('AU 🔴 リクエストボタンが無い終了ガイドでも発火する（本命の回帰テスト）', GUIDE.viewer, true)
await endGuideCase('AU リクエストボタンがある従来の形でも発火する', GUIDE.withRequest, true)
await endGuideCase('AU 配信者本人の満足度アンケート表示でも発火する', GUIDE.enquete, true)
await endGuideCase('AU 中身が揃っていないガイドでは発火しない（誤爆防止）', GUIDE.partial, false)

// ============================================================
// AV: 動くサムネに「今表示している絵」が必ず含まれるか
//
// 以前は①がプリロードと表示で**同じURLを2回**ダウンロードしており、その2枚が食い違うと
// 画面に出ている絵がアニメのどのコマにも無い状態になった。しかも末尾スロットの判定が
// URL文字列比較だったため、URLが同一のこのケースだけ構造的にすり抜けていた。
// 今は静止サムネにも給餌したコマそのものを出す＝食い違いが起こりようがない。
// ここでは「2回目の取得には別の色を返す」意地悪な差し替えのまま、症状が出ないことを確かめる。
// ============================================================
log('\n=== AV: 動くサムネに「今表示している絵」が含まれるか ===')
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#sidebar', { state: 'attached', timeout: 20000 })
// ⚠️ `#sidebar` が現れた直後はまだ幅が入っていない。そこで isOpen() を見ると「閉じている」と誤判定し、
// 開いているサイドバーをこちらのクリックで**閉じてしまう**。落ち着くまで待ってから、開くまで押す。
await page.waitForTimeout(1500)
for (let i = 0; i < 3 && !(await isOpen()); i++) {
    await page.click('#sidebar_button')
    await page.waitForTimeout(1200)
}
check('AV 前提: サイドバーが開いている（閉じているとサムネ更新は動かない）', await isOpen())
await page.waitForTimeout(1000)

// ===== BJ ライブサムネ差し替え時のクロスフェード ==============================
// 動くサムネはまだOFF（AVで後からONにする）＝ここで見るのは素のURL表示経路。
//
// 【なぜ requestAnimationFrame で覗くか】フェードは0.5秒ほどしかない。外から page.evaluate を
// 連打すると往復の遅れで山場を跨いでしまうので、ページ側に観測を置いて毎フレーム記録させ、
// 終わってからまとめて回収する。
//
// 【何を「本物」として見ているか】getComputedStyle の opacity。Web Animations が走っている間は
// **実際に合成に使われている値**がここに出る。自前のフラグではなくブラウザの合成状態を読む。
{
    // サムネ更新ループは document.hidden で素通りする。ここを忘れると1回もフェードが起きず、
    // 「観測できなかった」なのか「壊れている」なのか区別が付かなくなる。
    await page.bringToFront()
    const v = await page.evaluate(() => document.visibilityState)
    check('BJ 前提: タブが可視（サムネ更新は背景タブでは動かない）', v === 'visible', `visibilityState=${v}`)

    await page.evaluate(() => {
        window.__fadeLog = []
        window.__fadeWatch = true
        const tick = () => {
            if (!window.__fadeWatch) return // 観測は BJ の窓だけ。AV の計測に余計な負荷を残さない
            const cards = document.querySelectorAll('#liveProgramContainer .program_container')
            for (const card of cards) {
                const layer = card.querySelector('.thumb_fade_layer')
                if (!layer) continue
                const im = card.querySelector('.program_thumbnail_img')
                window.__fadeLog.push({
                    t: performance.now(),
                    id: card.id,
                    op: parseFloat(getComputedStyle(layer).opacity),
                    layerSrc: layer.getAttribute('src') || '',
                    baseSrc: im ? im.src : '',
                })
            }
            requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
    })
    log('   サムネの差し替えを 45秒 観測中（サムネ周期20秒）…')
    await page.waitForTimeout(45000)
    const fadeLog = await page.evaluate(() => { window.__fadeWatch = false; return window.__fadeLog })

    // カードごとに「覆いが立ってから消えるまで」を1回のフェードとして切り出す。
    // op が 0 から上がった所を始まり、0 に戻った所を終わりとみなす。
    const fades = []
    const open = new Map()
    for (const s of fadeLog) {
        const cur = open.get(s.id)
        if (s.op > 0) {
            if (cur) { cur.samples.push(s) } else { open.set(s.id, { id: s.id, samples: [s] }) }
        } else if (cur) {
            cur.endT = s.t
            fades.push(cur)
            open.delete(s.id)
        }
    }

    // 空振り防止。1件も観測できていないなら以下の合格は全て無意味なので、まずそこを落とす。
    check('BJ 前提: 観測期間中に実際にフェードが起きた', fades.length > 0,
        `フェード ${fades.length} 回 / 記録 ${fadeLog.length} フレーム`)

    // ① 覆いは「古い絵」で、その時すでに下は「新しい絵」。これがクロスフェードの実体。
    //    ここが崩れる＝同じ絵を重ねているだけ（＝見た目が変わらない）か、覆う前に切り替わっている。
    const sameSrc = fades.filter((f) => f.samples.some((s) => !s.layerSrc || s.layerSrc === s.baseSrc))
    check('BJ 上に載っているのは古い絵で、下はもう新しい絵になっている',
        fades.length > 0 && sameSrc.length === 0,
        `重なりが同じ絵だったフェード ${sameSrc.length} / ${fades.length} 回`)

    // ② 立ち上がりは不透明。ここが 1 に届いていないと、切り替わりの瞬間に下の絵が透けて見える。
    const weak = fades.filter((f) => Math.max(...f.samples.map((s) => s.op)) < 0.98)
    check('BJ 差し替えの瞬間は古い絵が完全に覆っている（下の絵が透けない）',
        fades.length > 0 && weak.length === 0,
        `最大不透明度が足りないフェード ${weak.length} / ${fades.length} 回`)

    // ③ 中間の値を通っている＝本当に薄れている（0→1の瞬間切替ではない）。
    const noMid = fades.filter((f) => !f.samples.some((s) => s.op > 0.05 && s.op < 0.95))
    check('BJ 途中の濃さを通っている（瞬時に消えるのではなく薄れている）',
        fades.length > 0 && noMid.length === 0,
        `中間値が無かったフェード ${noMid.length} / ${fades.length} 回`)

    // ④ 目で見て「ふわっと」と感じる長さに収まっているか。
    //    🔴 期待値を thumbnailCrossfadeMs から作らないこと。実装を書き換えても一緒に動いてしまい、
    //       「一瞬で消える」「いつまでも残る」のどちらも検出できなくなる。人が見て妥当な幅で固定する。
    const durs = fades.map((f) => f.endT - f.samples[0].t)
    const bad = durs.filter((d) => d < 200 || d > 2000)
    check('BJ フェードの長さが 0.2〜2.0 秒に収まっている',
        fades.length > 0 && bad.length === 0,
        `長さ: ${durs.map((d) => Math.round(d)).join(', ')} ms`)

    // ⑤ 固着しないこと。最後は必ず透明に戻り、抱えた画像も手放している。
    //    ここが壊れると古い絵で覆ったまま止まる＝「サムネが更新されない」に見える（最悪の壊れ方）。
    const stuck = await page.evaluate(() => {
        const out = { opaque: 0, holding: 0, layers: 0 }
        for (const l of document.querySelectorAll('.thumb_fade_layer')) {
            out.layers++
            if (parseFloat(getComputedStyle(l).opacity) > 0.01) out.opaque++
            if (l.hasAttribute('src')) out.holding++
        }
        return out
    })
    check('BJ フェード後に覆いが残らない（古い絵で固まらない）',
        stuck.layers > 0 && stuck.opaque === 0,
        `不透明のまま ${stuck.opaque} / レイヤー ${stuck.layers} 枚`)
    check('BJ フェード後は画像を手放している（カードの数だけ抱え込まない）',
        stuck.layers > 0 && stuck.holding === 0,
        `src を持ったまま ${stuck.holding} / レイヤー ${stuck.layers} 枚`)

    // ⑥ 回帰テスト: 覆いが番組リンクのクリックを奪っていないか。
    //    透明でも要素はヒットテストに残るので、pointer-events:none が抜けると常時押せなくなる。
    const hit = await page.evaluate(() => {
        const t = document.querySelector('#liveProgramContainer .program_container .program_thumbnail')
        if (!t) return null
        const r = t.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) return null
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { cls: el ? el.className : '(なし)', inLink: !!(el && el.closest('.program_thumbnail a')) }
    })
    check('BJ 🔴 覆いが番組リンクのクリックを奪っていない',
        !!(hit && hit.inLink), hit ? `当たった要素: "${hit.cls}"` : '(サムネが見えていない)')
}

// この節の操作は全て JS クリックで行う。設定パネルはサイドバー内にあり、項目によっては
// viewport の外に出て Playwright の click が「outside of the viewport」で通らないため。
await page.evaluate(() => document.getElementById('setting_options').click()); await page.waitForTimeout(400)
await page.evaluate(() => document.getElementById('animatedThumbnailOn').click()); await page.waitForTimeout(300)
await page.evaluate(() => document.getElementById('settings_close').click()); await page.waitForTimeout(400)
check('AV 前提: 動くサムネをONにできた',
    await page.evaluate(() => !!document.querySelector('#animatedThumbnailOn')?.checked))

// ⚠️ サムネ更新ループは `document.hidden` を見て素通りする（リスト更新と違って背景タブでは動かない）。
// 別ウィンドウに隠れているとChromeが hidden 扱いにするため、前面に出してから観測する。
// これを忘れると「取得0回」でこの節だけが謎に落ちる。
await page.bringToFront()
const vis = await page.evaluate(() => document.visibilityState)
check('AV 前提: タブが可視（サムネ更新は背景タブでは動かない）', vis === 'visible', `visibilityState=${vis}`)

const CARD = PROGRAMS[0].id.replace('lv', '')
thumbHits.length = 0
urlSeen.clear()
log('   コマが貯まるまで 70秒 観測中（サムネ周期20秒）…')
await page.waitForTimeout(70000)

const st = await page.evaluate((num) => {
    const card = document.getElementById(num)
    const im = card ? card.querySelector('.program_thumbnail_img') : null
    if (!im) return null
    let rgb = null
    try {
        const c = document.createElement('canvas'); c.width = 1; c.height = 1
        const cx = c.getContext('2d'); cx.drawImage(im, 0, 0, 1, 1)
        const d = cx.getImageData(0, 0, 1, 1).data
        rgb = [d[0], d[1], d[2]]
    } catch (_e) { rgb = null } // クロスオリジンURLを表示中なら読めない（＝給餌が効いていない）
    return { isBlob: im.src.indexOf('blob:') === 0, seq: im.dataset.thumbSeq || '', rgb }
}, CARD)

const perUrl = {}
for (const h of thumbHits) perUrl[h.url] = Math.max(perUrl[h.url] || 0, h.seen)
const maxPerUrl = Object.values(perUrl).length ? Math.max(...Object.values(perUrl)) : 0
check('AV 同じURLを2回ダウンロードしていない（静止サムネは給餌したコマを出す）',
    maxPerUrl === 1, `1URLあたり最大 ${maxPerUrl} 回 / 取得 ${thumbHits.length} 回`)
check('AV 静止サムネがコマそのものを表示している（blob＋コマ番号つき）',
    !!(st && st.isBlob && st.seq), st ? `blob=${st.isBlob} seq="${st.seq}"` : '(カードが無い)')

const nearest = (rgb) => {
    let best = -1; let bd = 1e9
    for (const c of colorOf.values()) {
        const d = Math.abs(c.r - rgb[0]) + Math.abs(c.g - rgb[1]) + Math.abs(c.b - rgb[2])
        if (d < bd) { bd = d; best = c.n }
    }
    return bd <= 12 ? best : -1
}
// ホバーも合成イベントで送る（同上の理由。動くサムネは委譲リスナなので実ホバーと同じ経路を通る）
await page.evaluate((num) => {
    const t = document.getElementById(num).querySelector('.program_thumbnail')
    t.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}, CARD)
const seen = []
for (let i = 0; i < 60; i++) {
    const s = await page.evaluate((num) => {
        const card = document.getElementById(num)
        if (!card) return null
        const layers = Array.prototype.slice.call(card.querySelectorAll('.anim_thumb_layer'))
        const shown = layers.filter((l) => l.classList.contains('show'))
        const top = shown[shown.length - 1] || layers[0]
        if (!top || !top.src || !top.complete || !top.naturalWidth) return null
        try {
            const c = document.createElement('canvas'); c.width = 1; c.height = 1
            const cx = c.getContext('2d'); cx.drawImage(top, 0, 0, 1, 1)
            const d = cx.getImageData(0, 0, 1, 1).data
            return [d[0], d[1], d[2]]
        } catch (_e) { return null }
    }, CARD)
    if (s) { const n = nearest(s); if (seen[seen.length - 1] !== n) seen.push(n) }
    await page.waitForTimeout(150)
}
const staticN = st && st.rgb ? nearest(st.rgb) : -1
check('AV アニメが再生されている（2コマ以上めくれた）', new Set(seen).size >= 2, `コマ列: ${seen.join(' → ')}`)
check('AV 🔴 今表示している絵がアニメのコマに含まれる（最新欠落の回帰テスト）',
    staticN >= 0 && seen.indexOf(staticN) >= 0,
    `静止=色${staticN} / コマ列: ${seen.join(' → ')}`)

// ===== BK 拡張が無効化されたら、取り残されたページが自分で止まること ==================
// 🔴 **必ず最後に置くこと。** 拡張を消すので、これ以降どの項目も動かない。
//
// 【なぜ実ブラウザで見るか】これは「本物の無効化」でしか起きない状態で、
// `verify:loop` は chrome.runtime.id を差し替えて論理だけを見ている。
// 実測（2026-08-02・修正前）: 無効化後60秒で **サムネ+9回**・別の回で follow+1 / notifybox+1、
// さらに `Uncaught Error: Extension context invalidated` が2件（doc/09 項目BK）。
{
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)))
    await page.bringToFront()
    await page.waitForTimeout(3000)

    // 空振り防止: 消す前に「本当に取得が動いている」ことを確かめる。
    // ここが0なら以下の「0回になった」は何も証明しない。
    const t0 = { thumb: thumbHits.length, follow: hits.length, notify: notifyboxHits }
    await page.waitForTimeout(25000)
    const alive = thumbHits.length - t0.thumb
    check('BK 前提: 消す前はサムネ取得が動いている', alive > 0, `25秒で ${alive} 回`)

    let removed = false
    try {
        await bs.send('Extensions.uninstall', { id: EXT_ID })
        removed = true
    } catch (e) {
        log(`  （Extensions.uninstall が使えないためBKは飛ばす: ${e.message}）`)
    }
    if (removed) {
        pageErrors.length = 0
        const t1 = { thumb: thumbHits.length, follow: hits.length, notify: notifyboxHits }
        await page.waitForTimeout(45000)
        const after = {
            thumb: thumbHits.length - t1.thumb,
            follow: hits.length - t1.follow,
            notify: notifyboxHits - t1.notify,
        }
        check('BK 🔴 無効化した後はニコ生への取得が止まる（取り残されたタブが叩き続けない）',
            after.thumb === 0 && after.follow === 0 && after.notify === 0,
            `45秒で サムネ${after.thumb} / follow${after.follow} / notifybox${after.notify}`)
        check('BK 無効化した後に Uncaught を出さない',
            pageErrors.length === 0, pageErrors.slice(0, 3).join(' / ') || 'なし')
    }
}

await browser.close()
try { child.kill() } catch (_) {}
setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }) } catch (_) {} }, 1500)

log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
