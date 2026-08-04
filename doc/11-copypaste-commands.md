# コピペ用コマンド（ホワイトボード）

**kick.com** のサイドバーに**ニコ生の番組が見えている状態**で実行。
ニコ生のサムネが kick.com 上でちゃんと読めているかを調べます（クロスフェードが出ない原因の切り分け）。

⚠️ タブで分けている場合は**ニコ生側のタブを表示してから**実行してください。

```js
(async()=>{const cards=[...document.querySelectorAll('#liveProgramContainer .program_container')].filter(c=>c.getAttribute('data-service')!=='kick');console.log('ニコ生カード数:',cards.length);if(!cards.length){console.log('ニコ生のカードが見えていません');return}let shown=0;for(const c of cards.slice(0,5)){const i=c.querySelector('.program_thumbnail_img');if(!i)continue;shown++;console.log(`  #${c.id} complete=${i.complete} naturalWidth=${i.naturalWidth} thumbLive=${i.dataset.thumbLive} errors=${i.dataset.errors||0} src=${(i.currentSrc||i.src||'').slice(0,80)}`)}const img0=cards.map(c=>c.querySelector('.program_thumbnail_img')).find(i=>i&&(i.currentSrc||i.src));if(!img0){console.log('判定できる画像がありません');return}const url=(img0.currentSrc||img0.src).split('?')[0];console.log('検証URL:',url);const t=(label,co)=>new Promise(ok=>{const im=new Image();if(co)im.crossOrigin='anonymous';const to=setTimeout(()=>ok(label+': タイムアウト'),8000);im.onload=()=>{clearTimeout(to);ok(label+': 成功 '+im.naturalWidth+'px')};im.onerror=()=>{clearTimeout(to);ok(label+': 失敗')};im.src=url+'?probe='+Date.now()});console.log(await t('[A] 平文で読み込み',false));console.log(await t('[B] crossOriginで読み込み',true))})();
```

`ニコ生カード数` 以下の一覧と、`[A]` `[B]` の2行を貼ってください。
