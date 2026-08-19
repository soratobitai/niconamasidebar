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
拡張のコンソールではない（Cookie が要るため）。

**番組が終わる瞬間を見張る。** 20秒ごとに 15分間。放送中が20件あれば数件は終わるので、
その場に居なくても結果が残る。**貼ったらタブを開いたまま放置してよい。**
途中でやめたい時は `__ddStop()` と打つ。

出るのは変化があった時だけ。終わったら `=== まとめ ===` が出るので、**その行から下を全部**貼り返す。

```js
(()=>{const F='https://live.nicovideo.jp/front/api/pages/follow/v1/programs?status=onair&offset=0&limit=100',N='https://papi.live.nicovideo.jp/api/relive/notifybox.content.php?rows=100',D='https://api.cas.nicovideo.jp/v1/services/live/programs/';const log=[],seen=new Map();let t=0;const now=()=>new Date().toLocaleTimeString();const rec=(s)=>{log.push(now()+' '+s);console.log('[DD] '+now()+' '+s)};const tick=async()=>{let ps=[],nb=new Set();try{const f=await (await fetch(F,{credentials:'include'})).json();ps=(f&&f.data&&f.data.programs)||[]}catch(e){rec('フォローAPI失敗 '+e.message);return}try{const n=await (await fetch(N,{credentials:'include'})).json();nb=new Set((n&&n.data&&n.data.notifybox_content||[]).map(r=>'lv'+String(r.id).replace(/^lv/,'')))}catch(e){rec('notifybox失敗 '+e.message)}const cur=new Map(ps.map(p=>[String(p.id),p]));for(const[id,p]of cur){const prev=seen.get(id);if(!prev){seen.set(id,{lc:p.liveCycle,nb:nb.has(id),gone:0});continue}if(prev.lc!==p.liveCycle){rec('★liveCycle変化 '+id+' '+prev.lc+' → '+p.liveCycle+' / notifybox='+(nb.has(id)?'居る':'居ない'));prev.lc=p.liveCycle}if(prev.nb!==nb.has(id)){rec('notifybox変化 '+id+' '+(prev.nb?'居た':'居ない')+' → '+(nb.has(id)?'居る':'居ない')+' / liveCycle='+p.liveCycle);prev.nb=nb.has(id)}}for(const[id,st]of seen){if(cur.has(id)){st.gone=0;continue}if(st.gone++)continue;let d='?',ms='?';try{const r=await fetch(D+id);const j=await r.json();ms=j&&j.meta&&j.meta.status;d=(j&&j.data&&j.data.liveCycle)||'(data無し)'}catch(e){d='取得失敗'}rec('☆フォローAPIから消えた '+id+' / 詳細API liveCycle='+d+' meta='+ms+' / notifybox='+(nb.has(id)?'★まだ居る':'居ない'))}const only=ps.filter(p=>!nb.has(String(p.id)));if(only.length)rec('notifyboxに居ない番組（終了確認が走る対象）: '+only.map(p=>p.id+'('+p.liveCycle+')').join(' , '));const own={};ps.forEach(p=>{const o=(p.programProvider&&p.programProvider.id)||(p.socialGroup&&p.socialGroup.id)||'?';(own[o]=own[o]||[]).push(p)});const dup=Object.entries(own).filter(([,v])=>v.length>1);if(dup.length)rec('★重複配信者: '+dup.map(([k,v])=>k+' → '+v.map(p=>p.id+'('+p.liveCycle+')').join(' , ')).join(' | '));if(++t>=45){clearInterval(h);console.log('=== まとめ ===');console.log('観測 '+t+'回 / 追跡した番組 '+seen.size+'件');console.log(log.length?log.join('\n'):'変化なし（何も終わらなかった）')}};const h=setInterval(tick,20000);window.__ddStop=()=>{clearInterval(h);console.log('=== まとめ ===');console.log('観測 '+t+'回 / 追跡した番組 '+seen.size+'件');console.log(log.length?log.join('\n'):'変化なし（何も終わらなかった）')};tick();console.log('[DD] 見張り開始。20秒ごと・15分。やめる時は __ddStop()')})()
```

**見たいのはこの3つ。**

| 行 | 分かること |
|---|---|
| `★liveCycle変化` | フォローAPI が終了を旗で教えてくれる＝**その材料が使える** |
| `☆フォローAPIから消えた … notifybox=★まだ居る` | notifybox のほうが遅い＝**終了確認が走らない**理由 |
| `notifyboxに居ない番組` が一度も出ない | 現行の終了確認は**そもそも発動していない** |
