// 运行：node tests/project-check.js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '../miniprogram')
const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json')))
const backend = fs.readFileSync(path.join(root, '../cloudfunctions/kitchen/index.js'), 'utf8')
const handlers = backend.slice(backend.indexOf('const handlers = {'))
for (const page of app.pages) {
  const base = path.join(root, page)
  for (const ext of ['js', 'json', 'wxml', 'wxss']) assert.ok(fs.existsSync(`${base}.${ext}`), `${page}.${ext} missing`)
  JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'))
  const shared = path.join(path.dirname(base), 'page.js')
  let js = fs.readFileSync(`${base}.js`, 'utf8') + (fs.existsSync(shared) ? fs.readFileSync(shared, 'utf8') : '')
  if (page === 'pages/meal/index') js += ['memory.js', 'record.js'].map(name => fs.readFileSync(path.join(root, 'pages/meal', name), 'utf8')).join('')
  if (page === 'pages/record-edit/index') js += fs.readFileSync(path.join(root, 'pages/meal/memory.js'), 'utf8')
  const wxml = fs.readFileSync(`${base}.wxml`, 'utf8')
  const mixesPhotos = /\bconst\s+\{[^}]*\bphotoHandlers\b[^}]*\}\s*=\s*require\(['"]\.\.\/\.\.\/utils\/photos['"]\)/.test(js) && /\.\.\.photoHandlers\b/.test(js)
  const photoHandlers = mixesPhotos ? require('../miniprogram/utils/photos').photoHandlers : {}
  for (const [, handler] of wxml.matchAll(/\b(?:bind|catch)(?:tap|input|change|load|error)="([A-Za-z][A-Za-z0-9]*)"/g)) {
    assert.ok(new RegExp(`\\b${handler}\\s*\\(`).test(js) || Object.hasOwn(photoHandlers, handler) && typeof photoHandlers[handler] === 'function', `${page}: ${handler} missing`)
  }
  for (const [, action] of js.matchAll(/request\('([A-Za-z]+)'/g)) {
    assert.match(handlers, new RegExp(`\\b${action}\\b`), `${page}: backend action ${action} missing`)
  }
}

const appState = { globalData: { configError: '', spaceName: '' } }
global.getApp = () => appState
const calls = []
let navigationTitle = ''
global.wx = { setNavigationBarTitle: ({ title }) => { navigationTitle = title }, cloud: { callFunction: async ({ data }) => {
  calls.push(data)
  if (data.action === 'bootstrap') return { result: { ok: true, data: { space: { _id: 'space123', name: '家' }, member: null } } }
  if (data.action === 'renameSpace') return { result: { ok: true, data: { name: '两个人的厨房' } } }
  if (data.action === 'mediaUrls') return { result: { ok: true, data: { urls: Object.fromEntries(data.payload.fileIds.map(id => [id, `url:${id}`])) } } }
  return { result: { ok: false, error: { code: 'BAD', message: '已拒绝' } } }
} } }
const api = require('../miniprogram/utils/api')

async function main() {
  const data = await api.request('bootstrap')
  assert.equal(data.space.id, 'space123')
  assert.equal(data.space._id, 'space123')
  api.setSpaceTitle('菜单')
  assert.equal(navigationTitle, '家 · 菜单')
  await api.request('renameSpace', { name: '两个人的厨房' })
  api.setSpaceTitle('菜单')
  assert.equal(navigationTitle, '两个人的厨房 · 菜单')
  const ids = Array.from({ length: 31 }, (_, i) => `file${i}`)
  const urls = await api.mediaUrls(ids)
  assert.equal(urls.file30, 'url:file30')
  assert.equal(calls.filter(call => call.action === 'mediaUrls').length, 2)
  await assert.rejects(api.request('bad'), error => error.code === 'BAD' && error.message === '已拒绝')

  const drafts = new Map()
  let modal
  let latestVersion = 2
  let saveMode = 'conflict'
  let showOpenWish = true
  let uploadCount = 0
  let taxonomyCount = 0
  const photoCalls = []
  const catalogCategories = [{ id: 'cat-old-1', name: '早餐' }]
  const catalogTags = [{ id: 'tag-old-1', name: '旧标签' }, { id: 'tag-new-1', name: '家常' }]
  const localPhoto = '/tmp/chosen-photo.jpg'
  wx.env = { USER_DATA_PATH: '/user' }
  wx.getStorageSync = key => drafts.get(key)
  wx.setStorageSync = (key, value) => drafts.set(key, value)
  wx.removeStorageSync = key => drafts.delete(key)
  wx.showLoading = wx.hideLoading = wx.showToast = () => {}
  wx.showModal = options => { modal = options }
  wx.redirectTo = wx.navigateBack = () => {}
  wx.chooseMedia = ({ success }) => success({ tempFiles: [{ tempFilePath: localPhoto }] })
  wx.compressImage = ({ success }) => success({ tempFilePath: localPhoto })
  wx.getFileInfo = ({ filePath, success, fail }) => [localPhoto, localPhoto.replace('/tmp/', '/saved/')].includes(filePath)
    ? success({ size: 4, digest: 'f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6' }) : fail(new Error('file missing'))
  wx.getImageInfo = ({ src, success, fail }) => [localPhoto, localPhoto.replace('/tmp/', '/saved/')].includes(src)
    ? success({ width: 1, height: 1, type: 'jpeg' }) : fail(new Error('file missing'))
  wx.getFileSystemManager = () => ({ readFile: ({ success }) => success({ data: Uint8Array.from([255, 216, 255, 217]).buffer }),
    saveFile: ({ tempFilePath, success }) => success({ savedFilePath: tempFilePath.replace('/tmp/', '/saved/') }) })
  wx.request = ({ method, data, success }) => {
    assert.equal(method, 'PUT'); assert.ok(data instanceof ArrayBuffer); success({ statusCode: 200, data: '' })
  }
  wx.cloud.callFunction = async ({ data }) => {
    photoCalls.push(data)
    if (data.action === 'bootstrap') return { result: { ok: true, data: { space: { _id: 'space123', categories: catalogCategories, tags: catalogTags, catalogVersion: 0 }, member: { _id: 'member123' } } } }
    if (data.action === 'getRecipe') return { result: { ok: true, data: { _id: 'recipe0001', version: latestVersion, name: '伙伴更新', categoryId: 'cat-old-1', tagIds: ['tag-old-1'], description: '服务器原文', coverFileId: 'cloud://old-cover', photoFileIds: ['cloud://gallery'] } } }
    if (data.action === 'mediaUrls') return { result: { ok: true, data: { urls: Object.fromEntries(data.payload.fileIds.map(id => [id, `url:${id}`])) } } }
    if (data.action === 'manageTaxonomy') {
      const item = { id: `${data.payload.kind}-${++taxonomyCount}`, name: data.payload.name }
      ;(data.payload.kind === 'category' ? catalogCategories : catalogTags).push(item)
      return { result: { ok: true, data: { categories: catalogCategories, tags: catalogTags, catalogVersion: taxonomyCount } } }
    }
    if (data.action === 'beginMediaUpload') return { result: { ok: true, data: { url: 'https://upload.example.test/photo', headers: {} } } }
    if (data.action === 'finishMediaUpload') return { result: { ok: true, data: { fileId: `cloud://new-${++uploadCount}` } } }
    if (data.action === 'discardMedia') return { result: { ok: true, data: { discarded: true } } }
    if (data.action === 'saveRecipe') return saveMode === 'conflict'
      ? { result: { ok: false, error: { code: 'VERSION_CONFLICT', message: '内容已被更新' } } }
      : { result: { ok: true, data: { _id: 'recipe0001' } } }
    if (data.action === 'getRecord') return { result: { ok: true, data: { _id: 'record0001', version: 1, recipeId: 'recipe0001', wishId: 'wish00001', date: '2026-09-28', note: '', photoFileIds: ['cloud://old-record'] } } }
    if (data.action === 'listRecipes') return { result: { ok: true, data: [{ _id: 'recipe0001', name: '越南粉' }] } }
    if (data.action === 'getWish') return { result: { ok: true, data: { _id: 'wish00001', title: '想吃越南粉', recipeId: 'recipe0001', status: 'completed' } } }
    if (data.action === 'listWishes') return { result: { ok: true, data: showOpenWish ? [
      { _id: 'wish00001', title: '想吃越南粉', recipeId: 'recipe0001', recipe: { _id: 'recipe0001', name: '越南粉' } },
    ] : [] } }
    if (data.action === 'saveRecord') return saveMode === 'conflict'
      ? { result: { ok: false, error: { code: 'VERSION_CONFLICT', message: '内容已被更新' } } }
      : { result: { ok: true, data: { _id: 'record0001' } } }
    throw new Error(`unexpected action: ${data.action}`)
  }
  let currentPage
  global.Page = definition => {
    currentPage = { ...definition, data: { ...definition.data }, setData(fields, callback) { Object.assign(this.data, fields); if (callback) callback() } }
  }
  require('../miniprogram/pages/recipe-edit/index')
  const recipePage = currentPage
  await recipePage.onLoad({ id: 'recipe0001' })
  drafts.set('recipeDraft:recipe0001', { id: 'recipe0001', version: 1, name: '旧版草稿', category: '主菜', tagsText: '家常、香辣', description: '草稿改过的介绍', coverFileId: 'cloud://old-cover' })
  await recipePage.restoreDraft()
  assert.deepEqual(recipePage.data.photoFileIds, ['cloud://gallery'], 'restoring an old draft must keep loaded gallery photos')
  assert.equal(recipePage.data.draftVersionChanged, true, 'a stale draft version must be visible and kept for conflict checking')
  assert.equal(recipePage.data.description, '草稿改过的介绍', 'old description edits remain visible')
  assert.equal(recipePage.data.showDescription, true)
  assert.equal(recipePage.data.pendingCategoryName, '主菜')
  assert.deepEqual(recipePage.data.pendingTagNames, ['香辣'])
  const beforeUnmappedSave = photoCalls.length
  await recipePage.save()
  assert.equal(photoCalls.length, beforeUnmappedSave, 'unmapped legacy labels must block upload and save')
  catalogCategories.push({ id: 'cat-new-1', name: '主菜' })
  catalogTags.push({ id: 'tag-new-2', name: '香辣' })
  await recipePage.refreshCatalog()
  assert.equal(recipePage.data.pendingCategoryName, '')
  assert.deepEqual(recipePage.data.pendingTagNames, [])
  assert.equal(recipePage.data.categoryId, 'cat-new-1')
  assert.deepEqual(recipePage.data.tagIds, ['tag-new-1', 'tag-new-2'])
  recipePage.change({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '我的修改' } })
  const beforeChoose = photoCalls.length
  await recipePage.photo()
  assert.equal(recipePage.data.coverUrl, localPhoto.replace('/tmp/', '/saved/'))
  assert.equal(photoCalls.length, beforeChoose, 'choosing a photo must stay local')
  latestVersion = 2
  await recipePage.save()
  const stalePayload = photoCalls.findLast(call => call.action === 'saveRecipe').payload
  assert.equal(stalePayload.version, 1, 'a legacy draft must not silently take the latest server version')
  assert.equal(stalePayload.categoryId, 'cat-new-1')
  assert.deepEqual(stalePayload.tagIds, ['tag-new-1', 'tag-new-2'])
  assert.equal(stalePayload.description, '草稿改过的介绍')
  assert.equal(recipePage.data.name, '我的修改', 'conflict must preserve unsaved edits')
  assert.equal(drafts.get(recipePage.draftKey).name, '我的修改', 'conflict must keep a local draft')
  assert.equal(drafts.get(recipePage.draftKey).coverLocalPath, '')
  assert.equal(drafts.get(recipePage.draftKey).coverFileId, 'cloud://new-1', 'failed save keeps the uploaded cover for retry')
  assert.deepEqual(drafts.get(recipePage.draftKey).photoFileIds, ['cloud://gallery'])
  assert.equal(photoCalls.at(-1).action, 'saveRecipe', 'failed save must not discard a possibly committed cover')
  assert.equal(uploadCount, 1)
  await modal.success({ confirm: false })
  assert.equal(recipePage.data.name, '我的修改', 'cancel must keep unsaved edits')
  await recipePage.save()
  assert.equal(uploadCount, 1, 'retry must reuse the uploaded cover')
  await modal.success({ confirm: true })
  assert.equal(recipePage.data.name, '伙伴更新', 'explicit reload must load the latest content')
  assert.equal(recipePage.data.version, 2)
  assert.equal(drafts.has(recipePage.draftKey), false, 'explicit reload must clear stale draft')
  assert.equal(drafts.has('recipeDraft:recipe0001'), false, 'explicit reload must clear the legacy draft')
  assert.equal(recipePage.data.coverLocalPath, '')
  await recipePage.photo()
  saveMode = 'success'
  await recipePage.save()
  assert.equal(photoCalls.findLast(call => call.action === 'saveRecipe').payload.coverFileId, 'cloud://new-2')
  assert.deepEqual(photoCalls.findLast(call => call.action === 'saveRecipe').payload.photoFileIds, ['cloud://gallery'], 'editing the cover must preserve the gallery')
  assert.ok(photoCalls.some(call => call.action === 'discardMedia' && call.payload.fileId === 'cloud://old-cover'), 'successful replacement may reclaim the old cover')

  delete require.cache[require.resolve('../miniprogram/pages/recipe-edit/index')]
  require('../miniprogram/pages/recipe-edit/index')
  const chipPage = currentPage
  await chipPage.onLoad({})
  const categoryTap = id => ({ currentTarget: { dataset: { id } } })
  chipPage.selectCategory(categoryTap('cat-old-1'))
  assert.equal(chipPage.data.selectedCategoryId, 'cat-old-1')
  chipPage.selectCategory(categoryTap('cat-old-1'))
  assert.equal(chipPage.data.selectedCategoryId, '', 'tapping the selected category clears it')
  chipPage.openTaxonomyInput({ currentTarget: { dataset: { kind: 'category' } } })
  assert.equal(chipPage.data.editingTaxonomy, 'category')
  assert.equal(chipPage.data.taxonomyFocus, true, 'custom input receives focus after it appears')
  chipPage.taxonomyBlur({ currentTarget: { dataset: { kind: 'category' } } })
  assert.equal(chipPage.data.editingTaxonomy, '', 'empty custom input closes on blur')
  assert.equal(chipPage.data.taxonomyFocus, false)
  chipPage.openTaxonomyInput({ currentTarget: { dataset: { kind: 'category' } } })
  chipPage.categoryInput({ detail: { value: '汤羹' } })
  assert.equal(chipPage.data.categories.length, catalogCategories.length, 'typing does not filter the chips')
  await chipPage.categoryConfirm({ detail: { value: '汤羹' } })
  assert.equal(chipPage.data.category, '汤羹')
  assert.ok(photoCalls.some(call => call.action === 'manageTaxonomy' && call.payload.name === '汤羹'), 'confirm creates the category in the catalog')
  assert.equal(chipPage.data.editingTaxonomy, '')
  assert.equal(drafts.get(chipPage.draftKey).categoryId, chipPage.data.selectedCategoryId)
  chipPage.tag({ currentTarget: { dataset: { id: 'tag-old-1' } } })
  chipPage.tag({ currentTarget: { dataset: { id: 'tag-new-1' } } })
  chipPage.tag({ currentTarget: { dataset: { id: 'tag-old-1' } } })
  assert.deepEqual(chipPage.data.tagIds, ['tag-new-1'], 'tags support independent selection and deselection')
  chipPage.openTaxonomyInput({ currentTarget: { dataset: { kind: 'tag' } } })
  chipPage.tagInput({ detail: { value: '快手' } })
  await chipPage.tagConfirm({ detail: { value: '快手' } })
  assert.equal(chipPage.data.editingTaxonomy, '')
  assert.ok(photoCalls.some(call => call.action === 'manageTaxonomy' && call.payload.name === '快手'), 'confirm creates the tag in the catalog')
  assert.ok(chipPage.data.tags.some(item => item.name === '快手' && item.selected), 'new tag is immediately selected')

  require('../miniprogram/pages/record-edit/index')
  const recordPage = currentPage
  drafts.set('recordDraft:record0001:', { id: 'record0001', version: 1, recipeId: '', wishId: 'wish00001',
    note: '旧记录草稿', photos: [{ fileId: 'cloud://old-record' }] })
  await recordPage.onLoad({ id: 'record0001' })
  assert.equal(recordPage.data.recipeId, 'recipe0001', 'old wish-only draft must keep the newly linked recipe')
  assert.equal(recordPage.data.choices.length, 1, 'the same dish in recipes and wishes should be one record source')
  assert.equal(recordPage.data.choices[0].wishId, 'wish00001', 'record source preserves its linked wish')
  recordPage.removePhoto({ currentTarget: { dataset: { index: 0 } } })
  const beforeRecordChoose = photoCalls.length
  await recordPage.photo()
  assert.equal(recordPage.data.photos[0].url, localPhoto)
  assert.equal(photoCalls.length, beforeRecordChoose, 'record photo selection must stay local')
  saveMode = 'conflict'
  await recordPage.save()
  assert.ok(photoCalls.some(call => call.action === 'discardMedia' && call.payload.fileId === 'cloud://new-3'), 'failed record save must reclaim its new upload')
  assert.equal(modal.title, '记录已被更新')
  await modal.success({ confirm: false })
  recordPage.keepDraft()
  assert.equal(drafts.get(recordPage.draftKey).photos[0].localPath, localPhoto)
  assert.equal(drafts.get(recordPage.draftKey).photos[0].fileId, '', 'record draft must not retain a discarded upload')
  saveMode = 'success'
  await recordPage.save()
  assert.equal(photoCalls.findLast(call => call.action === 'saveRecord').payload.recipeId, 'recipe0001', 'record save keeps migrated recipe link')
  assert.equal(photoCalls.findLast(call => call.action === 'saveRecord').payload.photoFileIds[0], 'cloud://new-4')
  assert.ok(photoCalls.some(call => call.action === 'discardMedia' && call.payload.fileId === 'cloud://old-record'), 'successful replacement may reclaim removed record photo')
  assert.equal(drafts.has(recordPage.draftKey), false)
  showOpenWish = false
  drafts.set('recordDraft:meal00001:wish00001', { recipeId: '', wishId: 'wish00001', mealId: 'meal00001',
    note: '旧心愿草稿', photos: [] })
  await recordPage.onLoad({ mealId: 'meal00001', wishId: 'wish00001' })
  assert.equal(recordPage.data.recipeId, 'recipe0001', 'completed wish absent from picker must still restore its linked recipe')
  await recordPage.save()
  assert.equal(photoCalls.findLast(call => call.action === 'saveRecord').payload.recipeId, 'recipe0001')

  const selection = require('../miniprogram/utils/selection')
  selection.configure({ space: { id: 'space123' }, member: { id: 'member123' } })
  selection.clear()
  selection.add({ recipeId: 'recipe0001', name: '越南粉' })
  selection.toggle({ recipeId: 'recipe0001', wishId: 'wish00001', name: '越南粉' })
  assert.equal(selection.items().length, 1, 'menu and wish picks of the same dish must remain one')
  assert.equal(selection.items()[0].wishId, 'wish00001', 'wish source must be retained for the cooking record')
  const firstSubmit = selection.prepareSubmit()
  selection.configure({ space: { id: 'space123' }, member: { id: 'member123' } })
  assert.equal(selection.prepareSubmit().requestId, firstSubmit.requestId, 'a failed submission retries with the same request ID')
  selection.completeSubmit('unrelated-request')
  assert.equal(selection.items().length, 1, 'an unrelated response cannot erase the local selection')
  selection.completeSubmit(firstSubmit.requestId)
  assert.equal(selection.items().length, 0, 'only a matching successful submission clears the selection')
  selection.configure({ space: { id: 'space123' }, member: { id: 'other-member' } })
  assert.equal(selection.items().length, 0, 'selection is private to each member')

  require('../miniprogram/pages/taxonomy/index')
  const taxonomyPage = currentPage
  taxonomyPage.setData({ items: [{ id: 'cat-old-1', name: '早餐' }] })
  const swipeTarget = { currentTarget: { dataset: { id: 'cat-old-1' } } }
  taxonomyPage.swipeStart({ ...swipeTarget, touches: [{ clientX: 140, clientY: 40 }] })
  taxonomyPage.swipeEnd({ ...swipeTarget, changedTouches: [{ clientX: 130, clientY: 100 }] })
  assert.equal(taxonomyPage.data.openId, '', 'vertical scrolling does not reveal taxonomy deletion')
  taxonomyPage.swipeStart({ ...swipeTarget, touches: [{ clientX: 140, clientY: 40 }] })
  taxonomyPage.swipeEnd({ ...swipeTarget, changedTouches: [{ clientX: 65, clientY: 43 }] })
  assert.equal(taxonomyPage.data.openId, 'cat-old-1', 'left swipe reveals taxonomy deletion')
  taxonomyPage.remove(swipeTarget)
  assert.equal(modal.title, '删除“早餐”？', 'swipe deletion still uses the existing confirmation')
  assert.equal(taxonomyPage.data.openId, '', 'delete action closes the swipe row')

  require('../miniprogram/pages/wishes/index')
  const wishPage = currentPage
  wishPage.setData({ wishes: [{ id: 'wish00001', version: 1, name: '面包', recipe: null }] })
  const wishTarget = { currentTarget: { dataset: { id: 'wish00001' } } }
  wishPage.swipeStart({ ...wishTarget, touches: [{ clientX: 140, clientY: 100 }] })
  wishPage.swipeEnd({ ...wishTarget, changedTouches: [{ clientX: 130, clientY: 20 }] })
  assert.equal(wishPage.data.openId, '', 'vertical scrolling does not reveal wish deletion')
  wishPage.swipeStart({ ...wishTarget, touches: [{ clientX: 140, clientY: 100 }] })
  wishPage.swipeEnd({ ...wishTarget, changedTouches: [{ clientX: 65, clientY: 103 }] })
  assert.equal(wishPage.data.openId, 'wish00001', 'left swipe reveals wish deletion')
  wishPage.remove(wishTarget)
  assert.equal(modal.title, '删除“面包”？', 'wish deletion requires confirmation')
  assert.equal(wishPage.data.openId, '', 'delete prompt closes the swipe row')
  console.log('小程序页面与 API 自检通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
