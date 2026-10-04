// node tests/menu-preview.js — measured layout checks, not a real-device test.
const assert = require('node:assert/strict')
const { groupsFor, wrap, layout, draw } = require('../miniprogram/pages/menu-preview/render')
const ctx = { font: '', measureText: value => ({ width: Array.from(value).length * 24 }) }
const bounds = block => { const width = ctx.measureText(block.text).width; const left = block.x - (block.align === 'center' ? width / 2 : 0); return { left, right: left + width } }
const fits = block => bounds(block).left >= 48 && bounds(block).right <= 552
const categories=[{name:'主菜'},{name:'时蔬'}]
const original=[{id:'1',name:'越南粉',category:''},{id:'2',name:'小炒排骨&肉',category:'主菜'},{id:'3',name:'青菜',category:'时蔬'}]
const before=JSON.stringify(original)
const groups=groupsFor(original,categories)
assert.deepEqual(groups.map(g=>g.name),['主菜','时蔬','未分类'])
assert.equal(JSON.stringify(original),before)
const three=layout(ctx,{title:'一起开饭',groups})
assert.equal(three.hits.length,3)
const names=Array.from({length:12},(_,i)=>({id:String(i),name:`第${i+1}道菜：${'长菜名青椒肉丝'.repeat(5)}`,category:i%2?'主菜':'时蔬'}))
const twelve=layout(ctx,{title:'饭名很长也应该保持完整'.repeat(4),groups:groupsFor(names,categories)})
assert.equal(twelve.hits.length,12)
assert.ok(twelve.height>three.height)
assert.equal(twelve.blocks.filter(b=>b.kind==='dish').map(b=>b.text).join(''),groupsFor(names,categories).flatMap(g=>g.items).map(i=>i.name).join(''))
assert.ok(twelve.blocks.every(fits))
assert.ok(twelve.hits.every((h,i)=>h.top+h.height<twelve.height-66&&(!i||h.top>=twelve.hits[i-1].top+twelve.hits[i-1].height)))
assert.deepEqual(wrap(ctx,'甲\n乙',100),['甲','乙'])
console.log('Menu 分组、无副作用、3/12 项、长标题与长菜名不丢字检查通过')

const illustrated = layout(ctx, { title: '肉肉大餐', groups: [{ name: '肉肉', items: [
  { id: 'photo-a', name: '炒牛肋条', displayPhotos: [{ url: 'https://photo/a' }], reflection: '这一口的味道'.repeat(30) },
  { id: 'photo-b', name: '手撕鸡', displayPhotos: [{ url: 'https://photo/b' }] },
  { id: 'plain', name: '没有照片也不留大块空白' },
] }] })
assert.equal(illustrated.photos.length, 2)
assert.ok(illustrated.photos[0].x < 300 && illustrated.photos[1].x > 300, 'photos alternate around the central text')
assert.notEqual(illustrated.photos[0].size, illustrated.photos[1].size, 'small photo-size variations keep the page from looking like a rigid list')
assert.equal(illustrated.blocks.filter(block => block.kind === 'note').length, 2)
assert.ok(illustrated.blocks.filter(block => block.kind === 'note').at(-1).text.endsWith('…'))
assert.ok(illustrated.hits[2].height < illustrated.hits[1].height)
assert.ok(illustrated.blocks.every(fits))
assert.ok(illustrated.hits.every(hit => hit.top + hit.height < illustrated.height - 70), 'dish content stays clear of the smaller footer')
console.log('完整 Menu 图文交错、心得截断、无图紧凑排版和边界检查通过')

for (const count of [2, 3, 6, 12]) {
  const page = layout(ctx, { title: '一起开饭', groups: groupsFor(Array.from({ length: count }, (_, i) => ({
    id: String(i), name: ['炒牛肋条', '手撕鸡', '刀削面'][i % 3], category: i < 2 ? '肉肉' : '主食', displayPhotos: [{ url: `photo-${i}` }],
  })), []) })
  assert.equal(page.photos.length, count)
  assert.ok(page.blocks.every(fits))
  page.photos.forEach((photo, i) => {
    const hit = page.hits[i]
    const dish = page.blocks.find(block => block.kind === 'dish' && block.y >= hit.top && block.y <= hit.top + hit.height)
    const box = bounds(dish)
    const gap = photo.x < dish.x ? box.left - photo.x - photo.size : photo.x - box.right
    assert.ok(gap >= 8 && gap <= 44, 'short dish names stay close to their photos')
    assert.ok(photo.x >= 48 && photo.x + photo.size <= 552)
    assert.ok(photo.y >= hit.top && photo.y + photo.size <= hit.top + hit.height)
    if (i) assert.ok(hit.top >= page.hits[i - 1].top + page.hits[i - 1].height, 'rows never overlap')
  })
  assert.ok(page.height <= ({ 2: 680, 3: 840, 6: 1230, 12: 2050 })[count], `${count} ordinary dishes stay compact`)
}
console.log('2/3/6/12 菜图文紧贴、适度图片变化、分类留白和多菜延展检查通过')

// Regression: a 114px first photo used to touch the following 肉肉 heading.
// Check rendered ink/shadow bounds, not only non-overlapping row rectangles.
function checkCategoryClearance(page, ascent = 18) {
  for (const category of page.blocks.filter(block => block.kind === 'category')) {
    const previousPhotos = page.photos.filter(photo => photo.y < category.y)
    const previousText = page.blocks.filter(block => ['dish', 'note'].includes(block.kind) && block.y < category.y)
    if (!previousPhotos.length && !previousText.length) continue
    const previousBottom = Math.max(
      ...previousPhotos.map(photo => photo.y + photo.size + 6),
      ...previousText.map(block => block.y + (block.kind === 'dish' ? 6 : 4)),
    )
    assert.ok(category.y - ascent - previousBottom >= 12, `${category.text} stays at least 12px below preceding text and photo shadows`)
  }
}
const consecutiveGroups = [
  { name: '主食', items: [{ id: 'noodles', name: '刀削面', displayPhotos: [{ url: 'noodles.jpg' }] }] },
  { name: '肉肉', items: ['炒牛肋条', '手撕鸡', '煎鲈鱼'].map((name, i) => ({ id: String(i), name, displayPhotos: [{ url: `${i}.jpg` }] })) },
]
const screenshotCase = layout(ctx, { title: '一起开饭', groups: consecutiveGroups })
assert.equal(screenshotCase.photos[0].size, 114)
checkCategoryClearance(screenshotCase)
const longContents = layout(ctx, { title: '这一顿的名字', groups: [
  { name: '主食', items: [{ id: 'long', name: '很长的菜名也要留出空间'.repeat(5), reflection: '心得可以有两行，分类标题也不能压在最后一行上'.repeat(5), displayPhotos: [{ url: 'long.jpg' }] }] },
  { name: '肉肉和其他想吃的菜'.repeat(3), items: [{ id: 'text', name: '没有照片的长菜名'.repeat(7), reflection: '没有照片的心得也保留清楚的下沿'.repeat(6) }] },
  { name: '时蔬', items: [{ id: 'greens', name: '炒青菜', displayPhotos: [{ url: 'greens.jpg' }] }] },
] })
checkCategoryClearance(longContents)
const tallerGlyphCtx = { font: '', measureText: value => ({ width: Array.from(value).length * 24, actualBoundingBoxAscent: 21 }) }
checkCategoryClearance(layout(tallerGlyphCtx, { title: '一起开饭', groups: consecutiveGroups }), 21)
console.log('首道大图、照片阴影、长菜名/心得、多行分类与不同字形高度的分类净空检查通过')

// Run the same renderer against the actual bundled contours, with system metrics only for notes and missing characters.
const fs = require('node:fs')
const { FAMILY, parseGlyphs, createLettering } = require('../miniprogram/pages/menu-preview/font')
const font = parseGlyphs(require('node:zlib').brotliDecompressSync(fs.readFileSync(require.resolve('../miniprogram/fonts/kitchen-menu-glyphs.br'))))
const nativeText = [], glyphScales = [], states = []
const realCtx = {
  font: '', textAlign: 'left', textBaseline: 'alphabetic',
  save() { states.push({ font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }) },
  restore() { Object.assign(this, states.pop()) },
  measureText(text) {
    assert.ok(!this.font.includes(FAMILY), 'the renderer uses local advances for Menu lettering')
    const size = Number(this.font.match(/([\d.]+)px/)[1])
    return { width: Array.from(text).length * size * .65, actualBoundingBoxAscent: size * .85 }
  },
  fillText(text, x, y) {
    assert.ok(!this.font.includes(FAMILY), 'covered Menu lettering never reaches native fillText')
    nativeText.push({ text, font: this.font, x, y })
  },
  scale(x, y) { if (y < 0) glyphScales.push([x, y]) },
}
for (const method of ['translate', 'rotate', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo', 'arc', 'rect', 'fill', 'fillRect', 'stroke', 'clip', 'drawImage']) {
  realCtx[method] = (...args) => assert.ok(args.every(Number.isFinite), `${method} receives finite coordinates`)
}
const realMenu = { title: '一起开饭长标题'.repeat(4), date: '2026-10-03', diners: 2, statusLabel: '已完成 · 吃饭记录', groups: [
  { name: '主食', items: [{ id: 'real-a', name: '刀削面', reflection: '这次面条刚刚好', displayPhotos: [{ url: 'noodles.jpg' }] }] },
  { name: '肉肉', items: [{ id: 'real-b', name: '青椒肉丝长菜名'.repeat(9), reflection: '心得需要截断也继续用系统字体'.repeat(6) }] },
  { name: '时蔬', items: [{ id: 'real-c', name: '青菜𠮷👩‍🍳' }] },
] }
const realPage = layout(realCtx, realMenu, font), realLettering = createLettering(realCtx, font)
assert.equal(realPage.titleLines.join(''), realMenu.title)
assert.equal(realPage.blocks.filter(block => block.kind === 'dish').map(block => block.text).join(''), realMenu.groups.flatMap(group => group.items).map(item => item.name).join(''))
for (const block of realPage.blocks) {
  realCtx.font = block.kind === 'note' ? '15px sans-serif' : `${block.kind === 'category' ? 18 : 23}px ${FAMILY}`
  const width = realLettering.measureText(block.text).width
  assert.ok(block.x - width / 2 >= 48 && block.x + width / 2 <= 552, 'atlas metrics keep every real text block within the page')
}
checkCategoryClearance(realPage)
draw(realCtx, realMenu, realPage, new Map(), font)
assert.ok(glyphScales.filter(([x, y]) => x === .023 && y === -.023).length > 50, 'title and wrapped dishes draw the real 23px contours')
assert.ok(glyphScales.some(([x, y]) => x === .018 && y === -.018), 'categories draw the same measured 18px contours')
assert.ok(glyphScales.some(([x, y]) => x === .015 && y === -.015), 'the footer uses the local contours')
assert.ok(nativeText.some(call => call.text === 'Menu'))
assert.ok(nativeText.some(call => call.text === '2026.10.03 · 2 人'))
assert.ok(nativeText.some(call => call.text === realMenu.statusLabel))
assert.ok(nativeText.some(call => call.text === '这次面条刚刚好' && call.font === '15px sans-serif'))
assert.ok(nativeText.some(call => call.text === '𠮷👩‍🍳' && call.font === '23px sans-serif'))
assert.equal(states.length, 0)
console.log('真实字形排版与绘制、长标题/菜名边界、系统心得和 Unicode 补字检查通过')
