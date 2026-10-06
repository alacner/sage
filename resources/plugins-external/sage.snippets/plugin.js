const KEY='entries';
function read(raw){if(!raw)return [];let value;try{value=JSON.parse(raw)}catch{throw Error('Saved snippets are invalid JSON')}if(!Array.isArray(value))throw Error('Saved snippets are invalid');return value;}
function metadata(entries){return entries.map(({id,name,keyword,value})=>({id,name,keyword,hasValue:typeof value==='string'&&value.length>0}));}
function validate(entries,old){if(!Array.isArray(entries)||entries.length>200)throw Error('At most 200 snippets are allowed');const ids=new Set(),refs=new Map();return entries.map(item=>{const id=String(item.id||'').slice(0,100),name=String(item.name||'').trim(),keyword=String(item.keyword||'').trim();if(!id||ids.has(id)||!name||!keyword||/[{}\x00-\x1f]/.test(name+keyword)||name.length>128||keyword.length>128)throw Error('Snippet name or keyword is invalid');ids.add(id);for(const key of [name.toLocaleLowerCase(),keyword.toLocaleLowerCase()]){if(refs.has(key)&&refs.get(key)!==id)throw Error('Snippet names and keywords must be unique');refs.set(key,id);}const prior=old.find(x=>x.id===id),value=item.value||prior?.value;if(typeof value!=='string'||!value.trim()||value.length>16384)throw Error('Enter a value for every snippet');return {id,name,keyword,value};});}
function find(entries,reference){const key=String(reference||'').trim().toLocaleLowerCase();if(!key)throw Error('Snippet name or keyword is required');const item=entries.find(x=>x.name.toLocaleLowerCase()===key||x.keyword.toLocaleLowerCase()===key);if(!item)throw Error('No snippet matches that name or keyword');return item;}
globalThis.sagePlugin={services:{
 snippets:{
  list:async(_args,sdk)=>metadata(read(await sdk.settings.get(KEY))),
  fill:async(args,sdk)=>{const item=find(read(await sdk.settings.get(KEY)),args.reference);await sdk.call('sage.browser','automation','fill',{id:args.browserId,selector:args.selector,text:item.value});return {ok:true,filled:true};}
 },
 config:{
  list:async(_args,sdk)=>metadata(read(await sdk.settings.get(KEY))),
  save:async(args,sdk)=>{const old=read(await sdk.settings.get(KEY));const entries=validate(args.entries,old);await sdk.settings.set(KEY,JSON.stringify(entries));return {saved:entries.length};}
 }
}};
