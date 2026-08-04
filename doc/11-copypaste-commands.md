# コピペ用コマンド（ホワイトボード）

**どのタブでも可**（ニコ生の視聴ページ / kick.com のどちらでも）。
Kick のカードがサイドバーに出ている状態で実行してください。

配信者名はサイドバーの Kick カードのリンクから拾います。Kick は任意のオリジンからの取得を
許可しているので、ニコ生のページからでも調べられます。**落ちません。**

```js
(async()=>{const dump=(label,obj)=>{console.log('=== '+label+' ===');console.log('キー:',Object.keys(obj||{}).join(', '));for(const[k,v]of Object.entries(obj||{})){if(v&&typeof v==='object'){console.log('  '+k+': {'+Object.keys(v).join(', ')+'}')}else{console.log('  '+k+' =',typeof v==='string'?v.slice(0,100):v)}}};const img=(o)=>{const hit=JSON.stringify(o||{}).match(/"[a-z_]*(pic|image|avatar|photo|thumb)[a-z_]*":"https?:[^"]{6,140}"/gi)||[];console.log('画像らしきフィールド:',hit.length);hit.slice(0,12).forEach(h=>console.log('  '+h))};let slug='';if(location.hostname.endsWith('kick.com'))slug=location.pathname.split('/')[1]||'';if(!slug){const a=[...document.querySelectorAll('#liveProgramContainer a')].map(x=>x.href||'').find(h=>/^https:\/\/kick\.com\/[^/]+$/.test(h));if(a)slug=a.split('/').pop()}if(!slug){console.log('Kickの配信者が見つからない。Kickのカードが見えている状態で実行するか、kick.com/<配信者> を開いてください');return}console.log('対象の配信者:',slug);try{const ch=await fetch('https://kick.com/api/v2/channels/'+slug,{headers:{Accept:'application/json'}}).then(r=>r.json());dump('channel',ch);dump('channel.user',ch.user);img(ch)}catch(e){console.log('取得に失敗:',e.name,e.message)}})();
```

`=== channel.user ===` のキーと値、`画像らしきフィールド` の一覧を貼ってください。
