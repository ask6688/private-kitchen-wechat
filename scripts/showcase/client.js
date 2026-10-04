// Only this documentation demo runs here. The actual mini program and CloudBase are never called.
const selected = new Set()
let categoryId = 'all', keyword = '', showSelection = false, localMeal = null, fontPromise
const content = document.querySelector('#content')
const toast = message => {
  const box = document.querySelector('#toast')
  box.textContent = message
  box.hidden = false
}
const route = () => pages.some(p => p.id === location.hash.slice(1)) ? location.hash.slice(1) : 'menu'
function currentData(spec) {
  const data = JSON.parse(JSON.stringify(spec.data))
  if (spec.id === 'menu') {
    const category = categories.find(c => c.id === categoryId)
    data.categoryId = categoryId
    data.keyword = keyword
    data.shown = recipes.filter(r => (categoryId === 'all' || r.category === category.name) && `${r.name} ${r.metaLabel}`.includes(keyword.trim()))
      .map(r => ({ ...r, selected: selected.has(r.id) }))
    data.selectedCount = selected.size
    data.selectedItems = recipes.filter(r => selected.has(r.id)).map(r => ({...r,recipeId:r.id}))
    data.showSelection = showSelection
    if (localMeal) data.currentMeal = localMeal
  }
  if (spec.id === 'meal' && localMeal) Object.assign(data, { meal: localMeal, title: localMeal.title, pageTitle: localMeal.title, status: localMeal.status })
  return data
}
async function drawMenu(canvas, menu) {
  fontPromise ||= fetch('glyphs.bin').then(response => {
    if (!response.ok) throw new Error('演示字形未加载')
    return response.arrayBuffer()
  }).then(fm.exports.parseGlyphs)
  const font = await fontPromise
  const ctx = canvas.getContext('2d'), layout = rm.exports.layout(ctx, menu, font)
  canvas.width = 1800
  canvas.height = Math.ceil(layout.height * 3)
  ctx.scale(3, 3)
  const images = new Map()
  await Promise.all(layout.photos.map(photo => new Promise(resolve => {
    const image = new Image()
    image.onload = () => { images.set(photo.url, image); resolve() }
    image.onerror = resolve
    image.src = photo.url
  })))
  rm.exports.draw(ctx, menu, layout, images, font)
}
async function show() {
  document.body.dataset.ready = 'false'
  const spec = pages.find(p => p.id === route())
  document.querySelector('#toast').hidden = true
  document.querySelector('#pageStyle').textContent = spec.css
  document.querySelector('#nav').innerHTML = `${!spec.tab ? '<b data-action="back">‹</b>' : ''}我们的厨房 · ${escape(spec.title)}<i>···</i>`
  document.querySelector('#tabs').innerHTML = spec.tab ? tabbar(spec.tab) : ''
  const data = currentData(spec)
  if (spec.canvas) {
    content.innerHTML = '<canvas class="demo-canvas" aria-label="完整 Menu" id="menuCanvas"></canvas>'
    try { await drawMenu(content.querySelector('canvas'), data.menuView) } catch { content.innerHTML = '<div class="empty">演示 Menu 暂未加载，请刷新重试</div>' }
  } else {
    const templates = {}
    for (const node of spec.nodes) if (node.tag === 'template' && node.attrs.name) templates[node.attrs.name] = node.children
    content.innerHTML = render(spec.nodes, data, templates)
  }
  document.body.dataset.ready = 'true'
}
document.addEventListener('input', event => {
  if (event.target.dataset.action !== 'onKeyword') return
  keyword = event.target.value
  const caret = event.target.selectionStart
  show()
  const input = content.querySelector('[data-action="onKeyword"]')
  input.focus()
  input.setSelectionRange(caret, caret)
})
document.addEventListener('click', event => {
  if (event.target.closest('#toast')) { event.target.closest('#toast').hidden = true; return }
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  if (action === 'onCategory') { categoryId = target.dataset.id; show(); return }
  if (action === 'toggleDish') { selected.has(target.dataset.id) ? selected.delete(target.dataset.id) : selected.add(target.dataset.id); show(); return }
  if (action === 'toggleSelection') { showSelection = !showSelection; show(); return }
  if (action === 'closeSelection') { showSelection = false; show(); return }
  if (action === 'clearSelected') { selected.clear(); showSelection = false; show(); return }
  if (action === 'removeSelected') { selected.delete(target.dataset.recipeId); show(); return }
  if (action === 'submit') {
    if (!selected.size) return
    localMeal = { ...pages.find(p => p.id === 'meal').data.meal, title: '演示饭单', status: 'draft', items: recipes.filter(r => selected.has(r.id)).map(r => ({ ...r, state: 'pending' })) }
    showSelection = false
    location.hash = 'meal'
    return
  }
  if (action === 'meal') { location.hash = 'meal'; return }
  if (action === 'menu' || action === 'chooseRecipe' || action === 'back') { location.hash = 'menu'; return }
  if (action === 'chooseWish') { location.hash = 'wishes'; return }
  if (action === 'preview') { location.hash = 'complete-menu'; return }
  if (action === 'open' && target.dataset.kind === 'meal') { location.hash = 'meal-detail'; return }
  toast('此处仅展示小程序页面；保存、上传、删除和成员操作请在微信中体验，不会写入云端')
})
window.addEventListener('hashchange', () => { content.scrollTop = 0; show() })
show()
