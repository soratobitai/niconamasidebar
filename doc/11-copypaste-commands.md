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

🔴 **どちらも「ニコ生の視聴ページ」の DevTools コンソール**へ貼ること。
ログイン Cookie と、`live.nicovideo.jp` オリジンからの CORS 許可が要るため、他のページでは動かない。

### ① live2 の watchCount は一覧APIより早いか（15秒ごと×20回＝5分）

若い番組を1つ選んで、live2 と一覧APIの watchCount を並べて出す。**0 を抜ける時刻を比べる。**

```
(async()=>{const R='https://live.nicovideo.jp/front/api/pages/recent/v1/programs?status=onair&offset=0&limit=100';const j=await fetch(R).then(r=>r.json());const a=((j.data.programs||j.data)).map(p=>({p,age:Date.now()-p.beginAt})).filter(x=>x.age<80000).sort((x,y)=>x.age-y.age)[0];if(!a)return console.log('若い番組が無い。1分ほど置いて再実行');const id=a.p.id;console.log('対象',id);for(let i=0;i<20;i++){const age=Math.round((Date.now()-a.p.beginAt)/1000);const s=await fetch('https://live2.nicovideo.jp/watch/'+id+'/statistics',{credentials:'include'}).then(r=>r.json()).catch(e=>null);const l=await fetch(R).then(r=>r.json()).then(x=>{const f=((x.data.programs||x.data)).find(p=>p.id===id);return f?f.statistics.watchCount:'一覧から消えた'}).catch(()=>null);console.log(age+'s live2='+(s&&s.data?s.data.watchCount:JSON.stringify(s))+' 一覧='+l);await new Promise(z=>setTimeout(z,15000))}})()
```
