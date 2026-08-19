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

### 終了した番組がリストに残る件（項目DD の調査）

**`live.nicovideo.jp` のページを開いて、そのページのコンソールに貼る。**
拡張のコンソールではない（Cookie が要るため）。**症状が出ていない時に貼っても意味がある。**

見るもの3つ。

- `liveCycle の内訳` … `ended` が1件でもあれば、**フォローAPIは終了した番組を旗つきで返している**
- `notifybox` 列 … `ended` の番組が notifybox に `居る` なら、終了確認が走らない理由がそれ
- `重複している配信者` … 症状が出ている時、ここに新旧2件が並ぶ

```js
(async()=>{const f=await (await fetch('https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=0&limit=100',{credentials:'include'})).json();const n=await (await fetch('https://papi.live.nicovideo.jp/api/relive/notifybox.content.php?rows=100',{credentials:'include'})).json();const nb=new Set((n&&n.data&&n.data.notifybox_content||[]).map(r=>'lv'+String(r.id).replace(/^lv/,'')));const ps=(f&&f.data&&f.data.programs)||[];const own={};ps.forEach(p=>{const o=(p.programProvider&&p.programProvider.id)||(p.socialGroup&&p.socialGroup.id)||'?';(own[o]=own[o]||[]).push(p)});const rows=ps.map(p=>({id:p.id,配信者:(p.programProvider&&p.programProvider.name)||'',配信者id:(p.programProvider&&p.programProvider.id)||(p.socialGroup&&p.socialGroup.id)||'?',liveCycle:p.liveCycle,notifybox:nb.has(String(p.id))?'居る':'居ない',開始:new Date(p.beginAt).toLocaleTimeString()}));console.table(rows);console.log('liveCycle の内訳:',rows.reduce((a,r)=>(a[r.liveCycle]=(a[r.liveCycle]||0)+1,a),{}));console.log('notifybox に居ない番組:',rows.filter(r=>r.notifybox==='居ない').map(r=>r.id+'('+r.liveCycle+')'));console.log('重複している配信者:',Object.entries(own).filter(([,v])=>v.length>1).map(([k,v])=>k+' → '+v.map(p=>p.id+'('+p.liveCycle+')').join(' , ')));})()
```

貼ったら、`console.table` の表と、その下の3行をそのまま貼り返してください。
