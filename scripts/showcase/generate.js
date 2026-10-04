// Local documentation renderer: current WXML/WXSS + fictional data, never a cloud call.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'output/playwright/showcase')
const assets = path.join(root, 'docs/assets/food')
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(assets, { recursive: true })
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))

// Original small food illustrations. They replace all private photos in these documentation images.
function food(kind) {
  let shape = ''
  if (kind === 'pasta') {
    for (let i=0; i<11; i++) shape += `<path d="M${63+i*6} 79 Q ${137-i*3} ${85+i*5} ${68+i*5} ${139-i*3}" stroke="#D8B568" stroke-width="7" fill="none" stroke-linecap="round"/>`
    shape += '<circle cx="88" cy="105" r="13" fill="#B86349"/><circle cx="125" cy="111" r="10" fill="#B86349"/><path d="M98 85 Q126 58 124 90 Q110 105 98 85" fill="#6B8A59"/>'
  } else if (kind === 'salmon') {
    shape = '<path d="M60 104 Q82 78 139 90 L144 129 Q101 146 64 132 Z" fill="#D79371" stroke="#B37653" stroke-width="3"/><path d="M74 100 L83 134 M92 94 L104 138 M115 93 L128 136" stroke="#F5D2AD" stroke-width="4" fill="none"/>'
    for (let i=0;i<5;i++) shape += `<path d="M${62+i*15} 76 q-5 -19 9 -24 q17 15 -4 27" fill="${i%2?'#7E9560':'#9CAD75'}"/>`
  } else if (kind === 'salad') {
    for (let i=0;i<10;i++) { const x=70+(i*23)%73,y=69+(i*17)%65; shape+=`<ellipse cx="${x}" cy="${y}" rx="17" ry="12" transform="rotate(${i*32} ${x} ${y})" fill="${i%2?'#8DA577':'#AABC8E'}"/>` }
    shape+='<circle cx="83" cy="99" r="12" fill="#C87557"/><circle cx="129" cy="117" r="11" fill="#C87557"/><ellipse cx="112" cy="86" rx="18" ry="14" fill="#EFE4C8"/><circle cx="112" cy="86" r="9" fill="#D9AF5E"/>'
  } else {
    shape = '<ellipse cx="101" cy="104" rx="54" ry="38" fill="#D4A66B"/><ellipse cx="101" cy="101" rx="49" ry="33" fill="#E3B884"/><path d="M68 91 q18 -18 35 2 q15 12 31 -3 M65 116 q24 -22 39 1 q14 11 29 -4" fill="none" stroke="#ECD3A8" stroke-width="9"/><circle cx="83" cy="107" r="7" fill="#AB6749"/><circle cx="123" cy="100" r="8" fill="#AB6749"/><path d="M93 91 q-7 -17 9 -14 q10 17 -9 14 M113 118 q-7 -17 9 -14 q10 17 -9 14" fill="#719565"/>'
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><defs><radialGradient id="paper"><stop stop-color="#F6F0E0"/><stop offset="1" stop-color="#E4EADB"/></radialGradient><filter id="shadow"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="200" height="200" fill="url(#paper)"/><ellipse cx="101" cy="118" rx="73" ry="53" fill="#71816C" opacity=".13" filter="url(#shadow)"/><ellipse cx="100" cy="102" rx="75" ry="61" fill="#FAF7EB" stroke="#CDD5C5" stroke-width="3"/><ellipse cx="100" cy="103" rx="61" ry="47" fill="#F0EBDD"/>${shape}</svg>`
}
for (const kind of ['pasta','salmon','salad','soup']) fs.writeFileSync(path.join(assets, `${kind}.svg`), food(kind))
const url = kind => `../../../docs/assets/food/${kind}.svg`
const categories = [{id:'all',name:'全部'},{id:'staple',name:'主食'},{id:'meat',name:'肉肉'},{id:'vegetable',name:'蔬菜'},{id:'soup',name:'汤羹'}]
const recipes = [
  {id:'demo-r1',name:'番茄意面',category:'主食',metaLabel:'主食 · 简单快手',cookCount:3,coverUrl:url('pasta')},
  {id:'demo-r2',name:'香煎三文鱼',category:'肉肉',metaLabel:'肉肉 · 周末慢慢做',cookCount:2,coverUrl:url('salmon')},
  {id:'demo-r3',name:'田园沙拉',category:'蔬菜',metaLabel:'蔬菜 · 清爽',cookCount:4,coverUrl:url('salad')},
  {id:'demo-r4',name:'菌菇汤',category:'汤羹',metaLabel:'汤羹 · 暖暖一碗',cookCount:1,coverUrl:url('soup')}
]
const photos = kind => [{key:`demo-${kind}`,url:url(kind),state:'ready'}]
const common = {loading:false,error:'',space:{name:'我们的厨房',memberCount:2,mediaUsage:'2.4 / 512 MB'},failedCovers:{},saving:false}
const meal = {id:'demo-meal',title:'周末一起开饭',date:'2026-10-04',diners:2,status:'confirmed',note:'趁着周末，一起慢慢做饭',items:recipes.slice(0,3).map((r,i)=>({...r,state:i===0?'cooked':'pending'}))}
const memoryItems = recipes.slice(0,3).map((r,i)=>({...r,hasMemory:i!==2,reflection:i===0?'番茄炒出汁，再拌进意面':i===1?'外皮煎得脆脆的，刚刚好':'',displayPhotos:photos(['pasta','salmon','salad'][i])}))
const groups = categories.slice(1,4).map(c=>({name:c.name,items:memoryItems.filter(r=>r.category===c.name)}))
const menuView = {title:meal.title,date:meal.date,diners:2,statusLabel:'已完成 · 吃饭记录',groups}
const demos = [
  {id:'menu',page:'menu',title:'菜单',tab:'menu',data:{...common,categories,categoryId:'all',shown:recipes,selectedCount:0,currentMeal:meal}},
  {id:'wishes',page:'wishes',title:'心愿',tab:'wishes',data:{...common,shown:[{id:'demo-w1',name:'奶油蘑菇意面',category:'主食',coverUrl:url('pasta'),recipe:{}},{id:'demo-w2',name:'南瓜浓汤',category:'汤羹',coverUrl:url('soup'),recipe:{}}],selectedCount:0}},
  {id:'meal',page:'meal',title:'饭单',data:{...common,meal,loadReady:true,pageTitle:'周末一起开饭',title:meal.title,date:meal.date,diners:2,note:meal.note,status:'confirmed',photos:[]}},
  {id:'meal-detail',page:'menu-preview',title:'一起吃饭',data:{...common,meal:{...meal,status:'completed'},menuView,dishGroups:groups,topInset:0,overlay:false,menuHeight:700}},
  {id:'records',page:'records',title:'记录',tab:'records',data:{...common,mode:'all',timeline:[{id:'demo-c1',key:'record-demo-c1',kind:'record',name:'番茄意面',dateLabel:'2026-10-04',kindLabel:'小林做的菜',note:'番茄炒出汁，酸甜刚刚好',photoCount:0},{id:'demo-meal',key:'meal-demo-meal',kind:'meal',title:meal.title,dateLabel:'2026-10-04',diners:2,dishCount:3,dishSummary:'番茄意面、香煎三文鱼、田园沙拉',status:'completed',statusLabel:'已完成',photoCount:0},{id:'demo-c2',key:'record-demo-c2',kind:'record',name:'菌菇汤',dateLabel:'2026-10-02',kindLabel:'小夏做的菜',note:'一碗暖暖的汤',photoCount:0}]}},
  {id:'space',page:'us',title:'我们',tab:'us',data:{...common,member:{role:'owner'},members:[{id:'demo-u1',role:'owner',displayName:'小林'},{id:'demo-u2',role:'member',displayName:'小夏'}]}},
  {id:'complete-menu',page:'menu-preview',title:'完整 Menu',canvas:true,data:{menuView}}
]

// Small XML adapter for documentation only; no page JS, wx API, event or persistence is executed.
function parse(source) {
  const top={children:[]}, stack=[top]
  for (const token of source.match(/<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)||[]) {
    if (token.startsWith('<!--')) continue
    if (token.startsWith('</')) { stack.pop(); continue }
    if (!token.startsWith('<')) { stack.at(-1).children.push({text:token}); continue }
    const tag=token.match(/^<([\w-]+)/)?.[1]; if(!tag)continue
    const attrs={}; for(const m of token.slice(tag.length+1,-1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g))attrs[m[1]]=m[2]??m[3]??true
    const node={tag,attrs,children:[]}; stack.at(-1).children.push(node)
    if(!token.endsWith('/>'))stack.push(node)
  }
  return top.children
}
function evaluate(raw, data, object=false) {
  const expression=String(raw).replace(/^{{|}}$/g,'').trim()
  const scope=new Proxy(data,{has:()=>true,get:(obj,key)=>key===Symbol.unscopables?undefined:obj[key]})
  try{return Function('scope',`with(scope){return (${object?'{'+expression+'}':expression})}`)(scope)}catch{return undefined}
}
function interpolate(raw, data){return String(raw).replace(/{{([\s\S]*?)}}/g,(_,expr)=>evaluate(expr,data)??'')}
function render(nodes,data,templates) {
  let chain=false, result=''
  for(const node of nodes){
    if(node.text!==undefined){result+=escape(interpolate(node.text,data));continue}
    const a=node.attrs
    if(a['wx:for']){
      const values=evaluate(a['wx:for'],data)||[]
      result+=values.map((item,index)=>render([{...node,attrs:Object.fromEntries(Object.entries(a).filter(([k])=>k!=='wx:for'))}],{...data,[a['wx:for-item']||'item']:item,[a['wx:for-index']||'index']:index},templates)).join('');continue
    }
    if(a['wx:if']){chain=!!evaluate(a['wx:if'],data);if(!chain)continue}
    else if(a['wx:elif']){if(chain)continue;chain=!!evaluate(a['wx:elif'],data);if(!chain)continue}
    else if(a['wx:else']){if(chain)continue;chain=true}
    else chain=false
    if(node.tag==='template'){
      if(a.name)continue
      result+=render(templates[a.is]||[],{...data,...evaluate(a.data,data,true)},templates);continue
    }
    if(node.tag==='block'){result+=render(node.children,data,templates);continue}
    const tag=({view:'div',text:'span',image:'img','scroll-view':'div',picker:'div',canvas:'canvas'})[node.tag]||node.tag
    let attrs=''
    for(const key of ['class','style','src','id','placeholder','value'])if(a[key]!==undefined){
      if(key==='id'&&tag==='canvas')continue
      attrs+=` ${key}="${escape(interpolate(a[key],data))}"`
    }
    if(tag==='img')attrs+=' alt="原创演示插画"'
    if(tag==='input')attrs+=' readonly'
    const children=tag==='textarea'?escape(interpolate(a.value||'',data)):render(node.children,data,templates)
    result+=`<${tag}${attrs}>${children}${!['img','input'].includes(tag)?`</${tag}>`:''}`
  }
  return result
}
function css(file){
  const full=path.join(root,file)
  return fs.readFileSync(full,'utf8').replace(/@import\s+"([^"]+)";/g,(_,f)=>css(path.relative(root,path.resolve(path.dirname(full),f))))
    .replace(/(-?[\d.]+)rpx/g,(_,n)=>`${Number(n)*390/750}px`)
    .replace(/(?<![.\w-])page(?=\s*[{,])/g,'body').replace(/(?<![.\w-])image(?=\s|,|\{|\.|:)/g,'img').replace(/(?<![.\w-])view(?=\s|,|\{|\.|:)/g,'div').replace(/(?<![.\w-])text(?=\s|,|\{|\.|:)/g,'span')
}
const tabs=[['menu','菜单'],['wishes','心愿'],['records','记录'],['us','我们']]
const tabbar=active=>`<div class="demo-tabs">${tabs.map(([id,name])=>`<div class="${id===active?'on':''}"><img src="../../../miniprogram/images/tabbar/${id}-${id===active?'selected':'normal'}.png" alt=""/><span>${name}</span></div>`).join('')}</div>`
const base=`*{box-sizing:border-box}body{margin:0;width:390px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}button,input,textarea{font:inherit;border:0}button{display:block;background:transparent;cursor:default}input,textarea{outline:0;resize:none}img{object-fit:cover}canvas.export-canvas{display:none}.demo-note{padding:9px 16px;background:#EAEFE6;color:#65785E;text-align:center;font-size:11px;letter-spacing:.2px}.demo-nav{height:55px;display:flex;align-items:center;justify-content:center;position:relative;font-size:16px;font-weight:600}.demo-nav b{position:absolute;left:17px;font-size:26px;font-weight:400}.demo-nav i{position:absolute;right:15px;font-size:22px;font-style:normal;letter-spacing:2px}.demo-tabs{display:flex;padding:13px 0 17px;background:#fff;gap:0}.demo-tabs>div{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;font-size:12px;color:#82907E}.demo-tabs img{width:28px;height:28px;object-fit:contain}.demo-tabs .on{color:#345443}.page{padding-bottom:25px}.demo-canvas{display:block;width:390px;height:auto}.detail-nav{display:none}`
for(const demo of demos){
  let body='', script=''
  if(demo.canvas){
    body='<canvas class="demo-canvas" id="menuCanvas"></canvas>'
    const fontSource=read('miniprogram/pages/menu-preview/font.js'),renderSource=read('miniprogram/pages/menu-preview/render.js')
    script=`<script>const fm={exports:{}};new Function('module',${JSON.stringify(fontSource)})(fm);const rm={exports:{}};new Function('module','require',${JSON.stringify(renderSource)})(rm,()=>fm.exports);(async()=>{const font=fm.exports.parseGlyphs(await(await fetch('glyphs.bin')).arrayBuffer());const menu=${JSON.stringify(menuView)};const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');const layout=rm.exports.layout(ctx,menu,font);canvas.width=600;canvas.height=layout.height;const urls=layout.photos.map(p=>p.url),images=new Map();await Promise.all(urls.map(url=>new Promise(resolve=>{const img=new Image;img.onload=()=>{images.set(url,img);resolve()};img.onerror=resolve;img.src=url})));rm.exports.draw(ctx,menu,layout,images,font);document.body.dataset.ready='true'})()</script>`
  }else{
    const nodes=parse(read(`miniprogram/pages/${demo.page}/index.wxml`)),templates={};for(const n of nodes)if(n.tag==='template'&&n.attrs.name)templates[n.attrs.name]=n.children
    body=`<div class="demo-nav">${!demo.tab?'<b>‹</b>':''}我们的厨房 · ${demo.title}<i>···</i></div>${render(nodes,demo.data,templates)}${demo.tab?tabbar(demo.tab):''}`
    script='<script>Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r}))).then(()=>document.body.dataset.ready="true")</script>'
  }
  fs.writeFileSync(path.join(out,`${demo.id}.html`),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${demo.title} · 本地演示</title><style>${css('miniprogram/app.wxss')}\n${css(`miniprogram/pages/${demo.page}/index.wxss`)}\n${base}\nbody{display:flex;flex-direction:column;min-height:100vh}.demo-note,.demo-nav,.demo-tabs{flex-shrink:0}.demo-tabs{margin-top:auto}</style></head><body><div class="demo-note">演示数据 · 当前模板本地渲染</div>${body}${script}</body></html>`)
}
fs.writeFileSync(path.join(out,'glyphs.bin'),zlib.brotliDecompressSync(fs.readFileSync(path.join(root,'miniprogram/fonts/kitchen-menu-glyphs.br'))))
console.log('Generated seven local documentation pages in output/playwright/showcase')
