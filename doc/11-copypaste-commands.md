# コピペ用コマンド

**ホワイトボード。毎回まるごと書き換える。**

ターミナルやコンソールへ手で貼るコマンドを、**今必要なぶんだけ**ここに置く。
チャットに直接書くと折り返しで壊れてコピペできないため。

## 書き方の約束

- **1コマンド＝1行。** 折り返さない。複数行に分けない。
- **用が済んだら消す。** 溜めない。**ここは記録ではない。**
- 説明はコマンドの直前に1〜2行だけ。長い説明は別のファイルへ。

## ここに書かないもの

| 内容 | 置き場所 |
|---|---|
| 診断コードの型・撤去手順 | `doc/10-verification-playbook.md` |
| 不具合の原因と直し方 | `doc/09-gotchas-and-techdebt.md` |
| 実機での検証手順 | `doc/10-verification-playbook.md` |
| 機能と設定の対応 | `doc/06-features.md` |

---

## 今のコマンド

### 消えないカードの正体を掴む（2026-08-17）

**終わっているのに消えないカードが出ている、その場で**ニコ生ページのコンソールへ貼る。
今サイドバーに出ているカードを1枚ずつ「notifybox に居るか」「詳細APIは何と答えるか」で照合する。
拡張は変更しない・読み取りのみ。**ページを更新する前に**実行すること（更新すると証拠が消える）。

```js
(async()=>{const c=document.getElementById('liveProgramContainer');if(!c)return console.log('サイドバーが見つかりません（開いてから実行）');const ids=[...c.children].filter(e=>e.id&&e.getAttribute('data-service')!=='kick').map(e=>'lv'+String(e.id).replace(/^lv/,''));const A=new Set();try{const nb=await(await fetch('https://papi.live.nicovideo.jp/api/relive/notifybox.content.php?rows=100',{credentials:'include'})).json();(nb.data.notifybox_content||[]).forEach(x=>A.add('lv'+String(x.id).replace(/^lv/,'')))}catch(e){console.log('notifybox が読めなかった（この場合はどのカードも疑いにならない）')}const out=[];for(const id of ids){let s=0,m='-',lc='(応答なし)';try{const r=await fetch('https://api.cas.nicovideo.jp/v1/services/live/programs/'+id);s=r.status;const j=await r.json();m=j&&j.meta?j.meta.status:'-';lc=j&&j.data&&j.data.liveCycle?j.data.liveCycle:'(data無し)'}catch(e){}out.push({id:id,notifybox:A.has(id)?'居る':'居ない',http:s,meta:m,liveCycle:lc})}console.table(out);const bad=out.filter(x=>x.liveCycle!=='on_air');console.log(bad.length?'⚠️ 放送中でないのにカードが在る: '+bad.length+'件 → '+bad.map(x=>x.id+'('+x.liveCycle+'/meta'+x.meta+'/notifybox'+x.notifybox+')').join(' , '):'カードは全部 on_air（＝APIはまだ放送中と言っている）')})()
```

**読み方**

| 出た形 | 意味 |
|---|---|
| 全部 `on_air` | 拡張は正しい。ニコ生のAPIがまだ「放送中」と答えている（消さないのが仕様） |
| `liveCycle=ended` かつ `notifybox=居ない` | **消えるはずのものが消えていない。拡張側の不具合** |
| `liveCycle=ended` かつ `notifybox=居る` | notifybox と詳細APIが食い違っている。疑いが立たないので永久に消えない |
| `meta=404` / `(data無し)` | ~~本命候補~~ **2026-08-17 に修正済み。** 404 は「終了」として消すようになった |

### サムネがアイコンのまま／ホバーで過去サムネが動く（2026-08-17）

**その症状が出ているカードを見ている状態で**ニコ生ページのコンソールへ貼る。
カードの dataset と storage の記録を突き合わせる。**リロードする前に**実行すること。

```js
(async()=>{const c=document.getElementById('liveProgramContainer');if(!c)return console.log('サイドバーが見つかりません');let store={};try{store=JSON.parse(localStorage.getItem('programInfos')||'[]').reduce((a,x)=>(a[x.id]=x,a),{})}catch(e){console.log('storage が読めず')}const short=(u)=>!u?'(空)':String(u).replace(/^https?:\/\//,'').slice(0,52);const out=[...c.children].filter(e=>e.id&&e.getAttribute('data-service')!=='kick').map(e=>{const i=e.querySelector('img.program_thumbnail,.program_thumbnail img,img');const d=i?i.dataset:{};const s=store['lv'+String(e.id).replace(/^lv/,'')]||{};const ss=s.liveScreenshotThumbnailUrls&&s.liveScreenshotThumbnailUrls.middle;return{id:e.id,表示中:short(i&&i.src),戻り先:short(i&&i.getAttribute('data-src')),thumbLive:d.thumbLive===undefined?'(未設定)':d.thumbLive,seq:d.thumbSeq||'-',err:d.errors||'0',backoff:d.nextTryAt&&Number(d.nextTryAt)>Date.now()?Math.round((Number(d.nextTryAt)-Date.now())/1000)+'秒':'-',保存スクショ:short(ss),保存サムネ:short(s.thumbnailUrl)}});console.table(out);const bad=out.filter(x=>x.表示中.includes('usericon')||x.表示中.includes('channel-icon')||x.表示中.includes('loading'));console.log(bad.length?'⚠️ アイコン/ローディングを出しているカード: '+bad.map(x=>x.id).join(','):'アイコンのままのカードは無い')})()
```

**読み方**

| 出た形 | 意味 |
|---|---|
| `保存スクショ` にURLが有るのに `表示中` がアイコン、`thumbLive=1` | **本命。** 復帰経路は `thumbLive==='0'` の時しか動かない（`sidebar.js:289`）ので、`1` のまま固まると永久に戻らない |
| 同上で `thumbLive=0`、`backoff` が残っている | バックオフが延び続けて復帰できていない |
| `保存スクショ` が `(空)` | 詳細APIでの補完が続けて失敗している（doc/09 項目CJ の経路） |
| `戻り先` がアイコン | `applyProgramInfoToCard` に空のレコードが渡っている |
