/**
 * 実ブラウザでの検証（doc/10 ブロックD の D3 実機版・D7）
 *
 *   npm run verify:e2e
 *
 * 本物の Chrome に dist/ の拡張を読ませ、視聴ページとAPIの応答だけこちらで差し替える。
 * **niconico へのログインは不要**で、実サーバには一切アクセスしない。所要 約5分。
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
const NOTIFYBOX = {
    meta: { status: 200 },
    data: { notifybox_content: PROGRAMS.map((p) => ({ id: p.id.replace('lv', ''), title: p.title })) },
}
const FOLLOW = { data: { programs: PROGRAMS, total: PROGRAMS.length } }
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>テスト視聴ページ</title></head>
<body><div id="watchPage"><div id="root"><div style="height:100vh">プレイヤー相当</div></div></div></body></html>`
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64')

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
    if (u.includes('dlive.nicovideo.jp')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
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
await page.click('label[for="updateProgramsInterval1"]'); await page.waitForTimeout(500)
await page.click('#settings_close'); await page.waitForTimeout(500)
check('更新間隔を60秒に設定できた',
    await page.evaluate(() => !!document.querySelector('#updateProgramsInterval1')?.checked))

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

await browser.close()
try { child.kill() } catch (_) {}
setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }) } catch (_) {} }, 1500)

log(`\n${failures === 0 ? '全項目 合格' : `${failures} 項目が不合格`}`)
process.exit(failures === 0 ? 0 : 1)
