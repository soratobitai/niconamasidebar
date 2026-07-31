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
await bs.send('Extensions.loadUnpacked', { path: EXT.replace(/\/$/, '') })
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

// 更新間隔を最短の60秒に（既定120秒だと検証が長くなりすぎる）
await page.click('#setting_options'); await page.waitForTimeout(500)
await page.click('label[for="updateProgramsInterval60"]'); await page.waitForTimeout(500)
await page.click('#settings_close'); await page.waitForTimeout(500)
check('更新間隔を60秒に設定できた',
    await page.evaluate(() => !!document.querySelector('#updateProgramsInterval60')?.checked))

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

hits = []
log('   閉じたまま 90秒 観測中…')
await page.waitForTimeout(90000)
check('D3-a 閉じている間はリスト取得をしない', hits.length === 0, `リスト取得 ${hits.length} 回`)

await page.click('#sidebar_button')          // 開く
await page.waitForTimeout(3000)
hits = []                                     // 開いた瞬間の手動更新ぶんを除外
log('   開いてから 150秒 観測中（60秒周期なら2回前後）…')
await page.waitForTimeout(150000)
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

await browser.close()
try { child.kill() } catch (_) {}
setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }) } catch (_) {} }, 1500)

log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
