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

### 番組が終わる瞬間のフォローAPIを見張る（項目DD）

**貼る場所: `https://live.nicovideo.jp/follow` のコンソール。**
⚠️ **番組視聴ページでは貼らないこと。** 自動移動でページが変わるとその時点で止まる。

20秒ごとに最大20分。変化があった時だけ出る。やめる時は `__ddStop()`。
⚠️ 裏タブにするとブラウザがタイマーを間引く（最悪1分に1回）。**なるべく見える状態で放置する。**

```js
(()=>{const F='https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=0&limit=100',N='https://papi.live.nicovideo.jp/api/relive/notifybox.content.php?rows=100',D='https://api.cas.nicovideo.jp/v1/services/live/programs/',LIMIT=20*60*1000;const log=[],seen=new Map(),t0=Date.now();let t=0,hid=0;const el=()=>Math.round((Date.now()-t0)/1000)+'秒';const rec=(s)=>{log.push(el()+' '+s);console.log('[DD] '+el()+' '+s)};const fin=(why)=>{clearInterval(h);console.log('=== まとめ ここから ===');console.log('経過 '+el()+' / 観測 '+t+'回 / 裏タブ '+hid+'回 / 追跡 '+seen.size+'件 / 終了理由 '+why);console.log(log.length?log.join('\n'):'変化なし（この間どの番組も終わらなかった）');console.log('=== まとめ ここまで ===')};const tick=async()=>{t++;if(document.hidden)hid++;let ps=[],nb=new Set(),nbOk=false;try{const f=await (await fetch(F,{credentials:'include',cache:'no-store'})).json();ps=(f&&f.data&&f.data.programs)||[]}catch(e){rec('フォローAPI失敗 '+e.message);return}try{const n=await (await fetch(N,{credentials:'include',cache:'no-store'})).json();nb=new Set((n&&n.data&&n.data.notifybox_content||[]).map(r=>'lv'+String(r.id).replace(/^lv/,'')));nbOk=true}catch(e){rec('notifybox失敗 '+e.message)}const cur=new Map(ps.map(p=>[String(p.id),p]));for(const[id,p]of cur){const prev=seen.get(id);if(!prev){seen.set(id,{lc:p.liveCycle,nb:nb.has(id),gone:0});continue}if(prev.lc!==p.liveCycle){rec('★liveCycle変化 '+id+' '+prev.lc+' → '+p.liveCycle+' / notifybox='+(nb.has(id)?'居る':'居ない'));prev.lc=p.liveCycle}if(nbOk&&prev.nb!==nb.has(id)){rec('notifybox変化 '+id+' '+(prev.nb?'居た':'居ない')+' → '+(nb.has(id)?'居る':'居ない')+' / liveCycle='+p.liveCycle);prev.nb=nb.has(id)}}for(const[id,st]of seen){if(cur.has(id)){st.gone=0;continue}if(st.gone++)continue;let d='?',ms='?';try{const j=await (await fetch(D+id)).json();ms=j&&j.meta&&j.meta.status;d=(j&&j.data&&j.data.liveCycle)||'(data無し)'}catch(e){d='取得失敗'}rec('☆フォローAPIから消えた '+id+' / 詳細API liveCycle='+d+' meta='+ms+' / notifybox='+(nb.has(id)?'★まだ居る':'居ない'))}if(nbOk){const only=ps.filter(p=>!nb.has(String(p.id)));if(only.length)rec('notifyboxに居ない番組: '+only.map(p=>p.id+'('+p.liveCycle+')').join(' , '))}const own={};ps.forEach(p=>{const o=(p.programProvider&&p.programProvider.id)||(p.socialGroup&&p.socialGroup.id)||'?';(own[o]=own[o]||[]).push(p)});const dup=Object.entries(own).filter(([,v])=>v.length>1);if(dup.length)rec('★重複配信者: '+dup.map(([k,v])=>k+' → '+v.map(p=>p.id+'('+p.liveCycle+')').join(' , ')).join(' | '));if(Date.now()-t0>=LIMIT)fin('20分経過')};const h=setInterval(tick,20000);window.__ddStop=()=>fin('手動');tick();console.log('[DD] 見張り開始。20秒ごと・最大20分。やめる時は __ddStop()')})()
```

**見たいのはこの3つ。**

| 行 | 分かること |
|---|---|
| `★liveCycle変化` | フォローAPI が終了を旗で教える＝**その材料が使える** |
| `☆フォローAPIから消えた` | そこまでの時間が、kick.com でカードが残る時間 |
| `notifyboxに居ない番組` が一度も出ない | ニコ生側の終了確認は**発動していない** |
