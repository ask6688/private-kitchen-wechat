const assert = require('node:assert/strict')

// Client-flow checks with the real page code; database transactions are tested separately.
const calls = []
const routes = []
const toasts = []
const drafts = new Map()
const records = new Map()
const requests = new Map()
let recipes = []
let pageDefinition
let uploadCount = 0
let loseResponse = false
let rejectSave = false
let holdSave = false
let releaseSave
let spaceId = 'space00001'
let failNavigation = false
let failBootstrap = false
const app = { globalData: { configError: '', spaceName: '测试厨房' } }
const clone = value => value == null ? value : structuredClone(value)
const success = data => ({ result: { ok: true, data } })
const change = (page, field, value) => page.change({ currentTarget: { dataset: { field } }, detail: { value } })
const tick = () => new Promise(resolve => setImmediate(resolve))
const saves = () => calls.filter(call => call.action === 'saveRecord')

global.getApp = () => app
global.getCurrentPages = () => []
global.Page = definition => { pageDefinition = definition }
const route = method => options => {
  routes.push({ method, url: options.url || '' })
  if (failNavigation) {
    failNavigation = false
    if (options.fail) options.fail({ errMsg: '模拟页面打开失败' })
    return
  }
  if (options.success) options.success()
}
global.wx = {
  env: { USER_DATA_PATH: '/user' },
  setNavigationBarTitle() {}, showLoading() {}, hideLoading() {},
  showToast: options => toasts.push(options.title),
  showModal: options => { if (options.complete) options.complete({ confirm: false }) },
  getStorageSync: key => clone(drafts.get(key)),
  setStorageSync: (key, value) => drafts.set(key, clone(value)),
  removeStorageSync: key => drafts.delete(key),
  navigateTo: route('navigateTo'), redirectTo: route('redirectTo'), navigateBack: route('navigateBack'),
  switchTab: route('switchTab'), reLaunch: route('reLaunch'),
  chooseMedia: ({ success }) => success({ tempFiles: [{ tempFilePath: '/tmp/cooking-photo.jpg' }] }),
  compressImage: ({ success }) => success({ tempFilePath: '/tmp/cooking-photo.jpg' }),
  getFileInfo: ({ filePath, success, fail }) => ['/tmp/cooking-photo.jpg', '/saved/cooking-photo.jpg'].includes(filePath)
    ? success({ size: 4, digest: 'f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6' }) : fail(new Error('file missing')),
  getImageInfo: ({ src, success, fail }) => ['/tmp/cooking-photo.jpg', '/saved/cooking-photo.jpg'].includes(src)
    ? success({ width: 1, height: 1, type: 'jpeg' }) : fail(new Error('file missing')),
  getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: Uint8Array.from([255, 216, 255, 217]).buffer }),
    saveFile: ({ tempFilePath, success }) => success({ savedFilePath: tempFilePath.replace('/tmp/', '/saved/') }) }),
  request: ({ method, data, success }) => {
    assert.equal(method, 'PUT'); assert.ok(data instanceof ArrayBuffer); success({ statusCode: 200, data: '' })
  },
  cloud: { callFunction: async ({ data }) => {
    const { action, payload } = data
    calls.push(clone(data))
    if (action === 'bootstrap' && failBootstrap) throw new Error('厨房暂时未能载入')
    if (action === 'bootstrap') return success({
      space: { _id: spaceId, name: '测试厨房', categories: [{ id: 'category01', name: '家常菜' }], tags: [{ id: 'tag000001', name: '快手' }] },
      member: { _id: 'member0001' },
    })
    if (action === 'listRecipes') return success(recipes)
    if (action === 'listWishes') return success([])
    if (action === 'getRecord') return success(records.get(payload.id))
    if (action === 'getRecipe') return success(recipes.find(recipe => recipe._id === payload.id))
    if (action === 'mediaUrls') return success({ urls: Object.fromEntries(payload.fileIds.map(id => [id, `url:${id}`])) })
    if (action === 'beginMediaUpload') return success({ url: 'https://upload.example.test/cooking', headers: {} })
    if (action === 'finishMediaUpload') return success({ fileId: `cloud://cooking-${++uploadCount}` })
    if (action === 'discardMedia') return success({ discarded: true })
    if (action !== 'saveRecord') throw new Error(`unexpected action: ${action}`)
    if (holdSave) await new Promise(resolve => { releaseSave = resolve })
    if (rejectSave) return { result: { ok: false, error: { code: 'INVALID_INPUT', message: '保存失败，请重试' } } }
    let record = records.get(payload.id || requests.get(payload.requestId))
    if (!record) {
      const id = `record${String(records.size + 1).padStart(5, '0')}`
      let recipeId = payload.recipeId || ''
      if (payload.newRecipe && payload.addToMenu) {
        recipeId = `recipe${String(recipes.length + 1).padStart(5, '0')}`
        recipes.push({ ...clone(payload.newRecipe), _id: recipeId })
      }
      record = { ...clone(payload), _id: id, version: 1, recipeId,
        name: payload.newRecipe ? payload.newRecipe.name : (recipes.find(recipe => recipe._id === recipeId) || {}).name,
        dishSnapshot: clone(payload.newRecipe || null) }
      records.set(id, record)
      if (payload.requestId) requests.set(payload.requestId, id)
    }
    if (loseResponse) {
      loseResponse = false
      throw new Error('网络连接中断')
    }
    return success(record)
  } },
}

function reset() {
  calls.length = routes.length = toasts.length = 0
  drafts.clear(); records.clear(); requests.clear()
  recipes = [{ _id: 'recipe00001', name: '番茄炒蛋', coverFileId: 'cloud://recipe-cover' }]
  uploadCount = 0
  loseResponse = rejectSave = holdSave = false
  releaseSave = null
  spaceId = 'space00001'
  failNavigation = failBootstrap = false
}
async function page(name, options) {
  const file = `../miniprogram/pages/${name}/index`
  delete require.cache[require.resolve(file)]
  require(file)
  const result = { ...pageDefinition, data: clone(pageDefinition.data), setData(fields, callback) {
    Object.assign(this.data, fields)
    if (callback) callback()
  } }
  await result.onLoad(options)
  return result
}
async function newDish(addToMenu) {
  const editor = await page('recipe-edit', { mode: 'cooking' })
  change(editor, 'name', '第一次做的菌菇炖饭')
  change(editor, 'date', '2026-09-30')
  change(editor, 'note', '米芯留一点口感，下次少放盐。')
  change(editor, 'ingredientsText', '米饭、菌菇、洋葱')
  change(editor, 'stepsText', '炒香洋葱，加入菌菇和米饭。')
  editor.selectCategory({ currentTarget: { dataset: { id: 'category01' } } })
  editor.tag({ currentTarget: { dataset: { id: 'tag000001' } } })
  editor.onAddToMenu({ detail: { value: addToMenu } })
  await editor.photo()
  return editor
}

async function main() {
  reset()
  const existing = await page('record-edit', { recipeId: 'recipe00001' })
  existing.onDate({ detail: { value: '2026-09-30' } })
  existing.onNote({ detail: { value: '今天蛋更嫩了。' } })
  await existing.photo()
  holdSave = true
  const existingSave = existing.save()
  await tick()
  existing.save()
  assert.equal(saves().length, 1)
  holdSave = false
  releaseSave()
  await existingSave
  const existingPayload = saves()[0].payload
  assert.equal(existingPayload.recipeId, 'recipe00001')
  assert.ok(existingPayload.requestId)
  assert.equal(existingPayload.newRecipe, undefined, 'cooking an existing recipe never sends a new recipe')
  assert.equal(existingPayload.note, '今天蛋更嫩了。')
  assert.deepEqual(existingPayload.photoFileIds, ['cloud://cooking-1'])
  assert.equal(recipes.length, 1, 'existing-dish saves do not create a recipe')
  assert.equal(records.size, 1)
  await existing.save()
  assert.equal(saves().length, 1)

  for (const addToMenu of [true, false]) {
    reset()
    const editor = await newDish(addToMenu)
    const oldRecipes = recipes.length
    holdSave = true
    const pending = editor.save()
    await tick()
    editor.save()
    assert.equal(saves().length, 1, 'repeated taps send one save while pending')
    assert.equal(editor.data.saving, true)
    holdSave = false
    releaseSave()
    await pending
    const payload = saves()[0].payload
    assert.ok(payload.requestId, 'a new cooking record carries an idempotency key')
    assert.equal(payload.addToMenu, addToMenu)
    assert.equal(payload.newRecipe.name, '第一次做的菌菇炖饭')
    assert.equal(payload.newRecipe.categoryId, 'category01')
    assert.deepEqual(payload.newRecipe.tagIds, ['tag000001'])
    assert.equal(payload.newRecipe.ingredients, '米饭、菌菇、洋葱')
    assert.equal(payload.newRecipe.steps, '炒香洋葱，加入菌菇和米饭。')
    assert.equal(payload.date, '2026-09-30')
    assert.equal(payload.note, '米芯留一点口感，下次少放盐。')
    assert.deepEqual(payload.photoFileIds, ['cloud://cooking-1'])
    assert.equal(payload.newRecipe.coverFileId, payload.photoFileIds[0])
    assert.equal(recipes.length, oldRecipes + Number(addToMenu), 'only the enabled choice adds a long-term recipe')
    assert.equal(records.size, 1)
    assert.equal(drafts.has(editor.draftKey), false)
    assert.deepEqual(routes.at(-1), { method: 'redirectTo', url: `/pages/record-edit/index?id=${[...records.keys()][0]}` })
    await editor.save()
    assert.equal(saves().length, 1, 'a completed save cannot be submitted again before navigation finishes')
    if (!addToMenu) {
      const recordId = [...records.keys()][0]
      const detail = await page('record-edit', { id: recordId })
      assert.equal(detail.data.error, '')
      assert.equal(detail.data.recipeId, '')
      assert.match(detail.data.sourceName, /第一次做的菌菇炖饭/)
      assert.equal(detail.data.dishSnapshot.ingredients, '米饭、菌菇、洋葱')
      assert.equal(detail.data.dishSnapshot.steps, '炒香洋葱，加入菌菇和米饭。')
      assert.equal(detail.data.photos[0].url, 'url:cloud://cooking-1')
      detail.onNote({ detail: { value: '补充心得：这次火候正好。' } })
      await detail.save()
      assert.equal(saves().at(-1).payload.id, recordId, 'a standalone snapshot record remains editable')
      assert.equal(saves().at(-1).payload.newRecipe, undefined, 'editing a record-only dish never creates a recipe')
      assert.equal(records.size, 1)
      assert.equal(recipes.length, 1)
    }
  }

  reset()
  const uncertain = await newDish(true)
  loseResponse = true
  await uncertain.save()
  assert.equal(uncertain.data.name, '第一次做的菌菇炖饭')
  assert.equal(uncertain.data.note, '米芯留一点口感，下次少放盐。')
  assert.equal(uncertain.data.saving, false)
  assert.equal(routes.length, 0, 'a lost response does not navigate as if saving succeeded')
  assert.ok(drafts.has(uncertain.draftKey), 'failure immediately retains the form draft')
  change(uncertain, 'note', '这段修改不能混入结果未知的提交')
  assert.equal(uncertain.data.note, '米芯留一点口感，下次少放盐。', 'an uncertain creation retries its original input without silently losing new edits')
  change(uncertain, 'name', '不能改成另一个菜名')
  uncertain.onAddToMenu({ detail: { value: false } })
  await uncertain.photo()
  assert.equal(uncertain.data.name, '第一次做的菌菇炖饭')
  assert.equal(uncertain.data.addToMenu, true)
  assert.equal(uncertain.data.photos.length, 1)
  assert.equal(routes.length, 0, 'an uncertain creation keeps its original page and payload until retry resolves it')
  uncertain.onUnload()
  const resumed = await page('recipe-edit', { mode: 'cooking' })
  assert.equal(resumed.data.name, uncertain.data.name)
  assert.equal(resumed.data.note, uncertain.data.note)
  assert.equal(resumed.data.addToMenu, true)
  assert.equal(resumed.data.photos.length, 1)
  await resumed.save()
  assert.equal(saves()[1].payload.requestId, saves()[0].payload.requestId, 'reopening and retrying keeps the same creation request')
  assert.deepEqual(saves()[1].payload.photoFileIds, saves()[0].payload.photoFileIds, 'uncertain response retries the same uploaded photos')
  assert.equal(uploadCount, 1, 'retry does not upload the same photo a second time')
  assert.equal(calls.filter(call => call.action === 'discardMedia').length, 0, 'an uncertain response cannot discard a photo that may already be saved')
  assert.equal(records.size, 1)
  assert.equal(recipes.length, 2)

  reset()
  const failedExisting = await page('record-edit', { recipeId: 'recipe00001' })
  failedExisting.onNote({ detail: { value: '已有菜网络断开后的心得。' } })
  await failedExisting.photo()
  loseResponse = true
  await failedExisting.save()
  assert.equal(failedExisting.data.saving, false)
  assert.equal(routes.length, 0)
  assert.ok(drafts.has(failedExisting.draftKey))
  failedExisting.onNote({ detail: { value: '结果未知时的新修改' } })
  assert.equal(failedExisting.data.note, '已有菜网络断开后的心得。')
  failedExisting.onUnload()
  const reopenedExisting = await page('record-edit', { recipeId: 'recipe00001' })
  assert.equal(reopenedExisting.data.note, '已有菜网络断开后的心得。')
  await reopenedExisting.save()
  assert.equal(saves()[1].payload.requestId, saves()[0].payload.requestId)
  assert.deepEqual(saves()[1].payload.photoFileIds, saves()[0].payload.photoFileIds)
  assert.equal(records.size, 1)
  assert.equal(recipes.length, 1)
  assert.equal(uploadCount, 1)

  reset()
  const rejected = await newDish(false)
  rejectSave = true
  await rejected.save()
  assert.equal(rejected.data.saving, false)
  assert.equal(rejected.data.name, '第一次做的菌菇炖饭')
  assert.equal(rejected.data.note, '米芯留一点口感，下次少放盐。')
  assert.ok(drafts.has(rejected.draftKey))
  assert.equal(records.size, 0)
  assert.equal(routes.length, 0)
  change(rejected, 'note', '明确失败后修改心得再保存。')
  assert.equal(rejected.data.note, '明确失败后修改心得再保存。', 'an explicit rejection permits fixing the form')
  rejectSave = false
  await rejected.save()
  assert.equal(saves().at(-1).payload.note, '明确失败后修改心得再保存。')
  assert.equal(records.size, 1)
  assert.equal(recipes.length, 1)

  reset()
  drafts.set('recordDraft:new:recipe00001:', { recipeId: 'recipe00001', note: '未隔离的旧草稿', requestId: 'legacyrequest' })
  drafts.set('recordDraft:new:recipe00001', { recipeId: 'recipe00001', note: '更旧的未隔离草稿', requestId: 'legacyrequest' })
  const kitchenA = await page('record-edit', { recipeId: 'recipe00001' })
  assert.equal(kitchenA.data.note, '', 'a new record must not restore an unscoped legacy draft')
  assert.notEqual(kitchenA.data.requestId, 'legacyrequest')
  kitchenA.onNote({ detail: { value: '厨房 A 的未保存心得' } })
  kitchenA.keepDraft()
  assert.ok(kitchenA.draftKey.includes('space00001'))
  spaceId = 'space00002'
  const kitchenB = await page('record-edit', { recipeId: 'recipe00001' })
  assert.equal(kitchenB.data.note, '', 'switching kitchens must not reveal another kitchen draft')
  assert.notEqual(kitchenB.data.requestId, kitchenA.data.requestId)
  assert.notEqual(kitchenB.draftKey, kitchenA.draftKey)
  spaceId = 'space00001'
  const restoredA = await page('record-edit', { recipeId: 'recipe00001' })
  assert.equal(restoredA.data.note, '厨房 A 的未保存心得')
  assert.equal(restoredA.data.requestId, kitchenA.data.requestId)
  const mealA = await page('record-edit', { mealId: 'meal00001', recipeId: 'recipe00001' })
  mealA.onNote({ detail: { value: '第一顿饭的心得' } })
  mealA.keepDraft()
  const mealB = await page('record-edit', { mealId: 'meal00002', recipeId: 'recipe00001' })
  assert.notEqual(mealA.draftKey, mealB.draftKey, 'two meals cooking the same recipe must not share a draft')
  assert.equal(mealB.data.note, '')

  reset()
  drafts.set('recordDraft:new:recipe00001:', { recipeId: 'recipe00001', note: '未确认归属的旧草稿' })
  failBootstrap = true
  const noKitchen = await page('record-edit', { recipeId: 'recipe00001' })
  assert.equal(noKitchen.data.note, '')
  assert.equal(noKitchen.draftKey, '')
  assert.match(noKitchen.data.error, /厨房暂时未能载入/)
  await noKitchen.save()
  assert.equal(saves().length, 0, 'unverified kitchen context cannot save or restore an unscoped draft')

  for (const kind of ['existing', 'new']) {
    reset()
    const savedPage = kind === 'new' ? await newDish(false) : await page('record-edit', { recipeId: 'recipe00001' })
    failNavigation = true
    await savedPage.save()
    assert.equal(saves().length, 1)
    assert.equal(records.size, 1)
    assert.ok(toasts.includes('页面未打开，请再试一次'))
    assert.equal(savedPage.data.saving, false)
    assert.equal(savedPage.routePending, false)
    assert.equal(drafts.has(savedPage.draftKey), false, 'a saved form is not restored as an unsaved draft after navigation fails')
    await savedPage.save()
    assert.equal(saves().length, 1, 'retrying navigation after a saved record must not write again')
    assert.equal(routes.length, 2)
    assert.deepEqual(routes[1], routes[0], 'retry navigation retains the original target')
  }

  console.log('做一道菜三路径、独立记录详情、防重复提交、失败重试与厨房隔离草稿自检通过')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
