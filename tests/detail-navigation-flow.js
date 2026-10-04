const assert = require('node:assert/strict')
const fs = require('node:fs')
const glyphData = require('node:zlib').brotliDecompressSync(fs.readFileSync(require.resolve('../miniprogram/fonts/kitchen-menu-glyphs.br')))
let definition, stack = [], responder, failRoute = false
const routes = [], writes = [], app = { globalData: {} }
const ok = data => ({ result: { ok: true, data } })
const later = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
global.Page = value => { definition = value }
global.getApp = () => app
global.getCurrentPages = () => stack
const route = method => options => {
  routes.push({ method, url: options.url || '' })
  if (failRoute) { failRoute = false; options.fail({ errMsg: 'navigation failed' }) }
  else options.success()
}
global.wx = {
  cloud: { callFunction: ({ data }) => responder(data.action, data.payload) },
  setNavigationBarTitle() {}, showToast() {}, showLoading() {}, hideLoading() {},
  getStorageSync() {}, setStorageSync() {}, removeStorageSync() {}, previewImage() {},
  navigateBack: route('navigateBack'), redirectTo: route('redirectTo'), switchTab: route('switchTab'),
}
function page(name) {
  const file = `../miniprogram/pages/${name}/index`
  delete require.cache[require.resolve(file)]; require(file)
  return { ...definition, data: structuredClone(definition.data), setData(value, callback) {
    Object.assign(this.data, value); if (callback) callback()
  } }
}
const bootstrap = () => ok({ space: { id: 'space001', categories: [], tags: [] }, member: { id: 'member001' } })
async function main() {
  const slow = later(); let count = 0
  responder = async action => {
    if (action === 'getRecipe') return ++count === 1 ? slow.promise : ok({ id: 'recipe001', name: '新版本' })
    if (action === 'listRecords') return ok([])
    if (action === 'bootstrap') return bootstrap()
    throw new Error(action)
  }
  const dish = page('recipe'); dish.onLoad({ id: 'recipe001' })
  const oldLoad = dish.load(); await dish.load()
  slow.resolve(ok({ id: 'recipe001', name: '旧版本' })); await oldLoad
  assert.equal(dish.data.recipe.name, '新版本', 'late response cannot overwrite the latest dish')
  dish.data.recipe.coverUrl = 'https://example.test/photo.jpg'
  dish.preview(); dish.onHide(); dish.onShow()
  assert.equal(count, 2, 'return from native photo preview keeps the original page')
  const empty = page('recipe'); empty.onLoad({}); await empty.onShow()
  assert.equal(empty.data.loading, false); assert.match(empty.data.error, /缺少菜品/)

  responder = async (action, payload) => {
    if (action === 'bootstrap') return bootstrap()
    if (action === 'saveRecipe' || action === 'saveWish') { writes.push({ action, payload }); return ok({ id: 'recipe001' }) }
    if (action === 'getRecipe') return ok({ id: 'recipe001', name: '菜名', photoFileIds: [] })
    throw new Error(action)
  }
  for (const [mode, previous] of [['wish', 'pages/wish-picker/index'], ['recipe', 'pages/menu-picker/index']]) {
    const editor = page('recipe-edit'); await editor.onLoad({ mode })
    editor.change({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '新增的菜' } })
    stack = [{ route: previous }, editor]
    failRoute = true; const before = writes.length
    await editor.save(); assert.equal(editor.saved, true); await editor.save()
    assert.equal(writes.length, before + 1, 'saved recipe navigation retry does not repeat the write')
    assert.deepEqual(routes.at(-1), { method: 'navigateBack', url: '' }, 'picker source and meal context stay in the stack')
  }
  stack = []
  const cold = page('recipe-edit'); await cold.onLoad({})
  cold.change({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '冷启动新菜' } })
  await cold.save()
  assert.deepEqual(routes.at(-1), { method: 'redirectTo', url: '/pages/recipe/index?id=recipe001' })
  const record = page('record-edit'); record.saved = true; record.data.loading = false
  record.save()
  assert.deepEqual(routes.at(-1), { method: 'redirectTo', url: '/pages/record-list/index?kind=cooking' })
  stack = [{ route: 'pages/records/index' }, record]; record.save()
  assert.deepEqual(routes.at(-1), { method: 'navigateBack', url: '' })
  record.id = 'meal001'; stack = [{ route: 'pages/menu-preview/index', id: 'another-meal' }, record]
  record.leaveDishMemory()
  assert.deepEqual(routes.at(-1), { method: 'redirectTo', url: '/pages/menu-preview/index?id=meal001&from=list' }, 'dish edit never returns to another meal')

  const completed = { id: 'meal001', status: 'completed', title: '同一顿饭', date: '2026-10-02', diners: 2, items: [] }
  responder = async action => {
    if (action === 'bootstrap') return bootstrap()
    if (action === 'getMeal') return ok(completed)
    throw new Error(`completed viewing should not load editor resources: ${action}`)
  }
  stack = []
  const oldMealLink = page('meal'); oldMealLink.onLoad({ id: completed.id })
  await oldMealLink.load()
  assert.deepEqual(routes.at(-1), { method: 'redirectTo', url: '/pages/menu-preview/index?id=meal001&from=list' })
  assert.equal(oldMealLink.data.loadReady, false, 'the old completed form never flashes before Menu')
  assert.equal(app.globalData.mealCompletion, undefined, 'ordinary entry never starts a completion celebration')
  failRoute = true; await oldMealLink.load()
  assert.equal(oldMealLink.data.loading, false, 'failed redirect ends waiting')
  assert.match(oldMealLink.data.error, /重试/)
  await oldMealLink.retry()
  const mealEditor = page('meal'); mealEditor.onLoad({ id: completed.id, mode: 'record' })
  mealEditor.withCovers = async value => value
  mealEditor.initMemoryDraft = async () => {}; mealEditor.retryImages = async () => {}
  const beforeEdit = routes.length
  await mealEditor.load()
  assert.equal(routes.length, beforeEdit, 'explicit edit record keeps its existing form')
  assert.equal(mealEditor.data.loadReady, true)

  // Hold the old canvas export until a new menu has requested its render.
  const renderer = require.resolve('../miniprogram/pages/menu-preview/render')
  let measuredFont
  require.cache[renderer] = { id: renderer, filename: renderer, loaded: true, exports: {
    layout(ctx, menu, font) {
      assert.ok(font.glyphs.has('永'.codePointAt(0)), 'layout receives the parsed local atlas')
      measuredFont = font
      return { width: 600, height: 680 }
    },
    draw(ctx, menu, page, photos, font) { assert.equal(font, measuredFont, 'drawing uses the same atlas as layout') },
    decoration() {}, groupsFor: () => [],
  } }
  const detail = page('menu-preview'); let exportCount = 0, finishOld
  const context = { scale() {}, clearRect() {}, getImageData() { assert.fail('Menu does not probe native font pixels') } }
  const canvas = { getContext: () => context, requestAnimationFrame() { assert.fail('Menu does not wait for native font frames') } }
  let finishFont, fontReads = 0
  wx.getFileSystemManager = () => ({ readCompressedFile(options) {
    fontReads++
    assert.equal(options.filePath, '/fonts/kitchen-menu-glyphs.br')
    assert.equal(options.compressionAlgorithm, 'br')
    finishFont = () => options.success({ data: glyphData })
  } })
  wx.loadFontFace = () => assert.fail('Menu does not register native fonts')
  detail.createSelectorQuery = () => ({ select() { return this }, fields() { return this }, exec(done) { done([{ node: canvas }]) } })
  const images = []; const originalSet = detail.setData
  detail.setData = function (data) { if (data.image) images.push(data.image); originalSet.call(this, data) }
  wx.canvasToTempFilePath = options => {
    if (++exportCount === 1) finishOld = () => options.success({ tempFilePath: 'old-menu.png' })
    else options.success({ tempFilePath: exportCount === 2 ? 'new-menu.png' : 'decoration.png' })
  }
  detail.menu = { title: '旧饭名' }; detail.loadToken = 1
  const firstRender = detail.render(); await tick()
  assert.equal(exportCount, 0, 'Menu must wait for the local glyph atlas before exporting')
  finishFont(); await tick()
  assert.equal(exportCount, 1, 'parsed local contours make export ready without native registration or animation frames')
  wx.getFileSystemManager = () => ({ readCompressedFile: options => { fontReads++; options.success({ data: glyphData }) } })
  detail.menu = { title: '新饭名' }; detail.loadToken = 2; await detail.render()
  finishOld(); await firstRender
  assert.deepEqual(images, ['new-menu.png'], 'a stale image never replaces or accompanies the refreshed Menu')
  assert.equal(fontReads, 1, 'a later render reuses the same parsed atlas')
  assert.equal(detail.data.exporting, false)
  let reloads = 0; detail.ready = true; detail.load = () => reloads++
  detail.preview(); detail.onHide(); detail.onShow()
  assert.equal(reloads, 0, 'full Menu preview returns at the same level without another load')
  detail.onUnload()

  // A failed photo must be retryable without exporting an incomplete Menu or changing its saved snapshot.
  const photoMeal = { id: 'photo-meal', title: '周末午饭', date: '2026-10-02', diners: 2, status: 'completed',
    items: [{ id: 'dish-photo', recordId: 'record-photo', recipeId: 'recipe-photo' }],
    menuSnapshot: { title: '周末午饭', date: '2026-10-02', diners: 2,
      groups: [{ name: '肉肉', items: [{ id: 'dish-photo', name: '煎鱼', category: '肉肉' }] }] } }
  const originalMeal = JSON.stringify(photoMeal), reads = [], renderedMenus = [], pendingImages = []
  responder = async action => {
    reads.push(action)
    if (action === 'getMeal') return ok(photoMeal)
    if (action === 'listRecords') return ok([{ id: 'record-photo', note: '这次火候刚好', photoFileIds: ['cloud://meal-photo'] }])
    if (action === 'mediaUrls') return ok({ urls: { 'cloud://meal-photo': 'https://example.test/meal-photo.jpg' } })
    throw new Error(`Menu viewing must not write: ${action}`)
  }
  require.cache[renderer].exports.draw = (ctx, menu, layout, photos, font) => {
    assert.equal(font, measuredFont)
    renderedMenus.push({ menu, photos })
  }
  const photoCanvas = { ...canvas, createImage() {
    const image = { width: 1200, height: 1600 }
    Object.defineProperty(image, 'src', { set(url) { image.url = url; pendingImages.push(image) } })
    return image
  } }
  wx.getImageInfo = options => options.success({ path: '/tmp/meal-photo.jpg', width: 1200, height: 1600 })
  const photoDetail = page('menu-preview'); photoDetail.onLoad({ id: 'photo-meal' })
  photoDetail.createSelectorQuery = () => ({ select() { return this }, fields() { return this }, exec(done) { done([{ node: photoCanvas }]) } })
  let photoExports = 0
  wx.canvasToTempFilePath = options => { photoExports++; options.success({ tempFilePath: 'photo-menu.png' }) }
  const photoLoading = photoDetail.load(); await tick()
  assert.equal(photoDetail.data.loading, false, 'dish content is usable while the export photo loads')
  assert.equal(photoDetail.data.exporting, true)
  await photoDetail.menuFontReady
  assert.equal(photoExports, 0, 'export waits for the real canvas image onload')
  assert.equal(pendingImages[0].url, '/tmp/meal-photo.jpg', 'canvas export uses the resolved local image instead of the signed remote URL')
  pendingImages.shift().onerror()
  await photoLoading
  assert.equal(photoDetail.data.image, '', 'a failed image never creates an apparently complete photo Menu')
  assert.match(photoDetail.data.renderError, /照片/)
  assert.equal(photoDetail.data.exporting, false)
  assert.equal(photoDetail.data.error, '', 'an export error leaves the saved dish content readable')
  const retryPhotoMenu = photoDetail.retryMenu(); await tick()
  pendingImages.shift().onload()
  await retryPhotoMenu
  assert.equal(photoDetail.data.image, 'photo-menu.png')
  assert.equal(photoDetail.data.renderError, '')
  assert.equal(photoDetail.data.exporting, false)
  assert.equal(renderedMenus.length, 1)
  assert.equal(renderedMenus[0].photos.size, 1)
  assert.equal(renderedMenus[0].menu.groups[0].items[0].reflection, '这次火候刚好')
  assert.equal(renderedMenus[0].menu.groups[0].name, '肉肉', 'photo enrichment respects the saved category group')
  assert.deepEqual(photoDetail.data.meal.menuSnapshot, JSON.parse(originalMeal).menuSnapshot)
  assert.equal(JSON.stringify(photoMeal), originalMeal, 'preview and retry leave the persisted historical snapshot intact')
  assert.deepEqual(reads, ['getMeal', 'listRecords', 'mediaUrls', 'mediaUrls'], 'Menu retry only resolves photos; it never writes business data')
  photoDetail.onUnload()
  console.log('详情导航检查通过：冷启动、保存路由重试、选择来源、慢请求和Menu导出竞态、预览返回')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
