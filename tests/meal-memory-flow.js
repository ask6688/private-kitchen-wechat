const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Real meal page with a small in-memory cloud API; no shared kitchen writes.
const calls = [], toasts = [], modals = []
const drafts = new Map(), savedFiles = new Set(), uploadReceipts = new Map(), saveReceipts = new Map()
let definition, uploads = 0, savedFileCount = 0, holdSave = false, releaseSave
let holdChoose = false, releaseChoose, cancelChoose = false, loseDishResponse = false
let uploadUnknown = false, saveUnknown = '', rejectSave = '', memberId = 'member00001'
const dishPhotos = ['cloud://dish-only']
let stored = { _id: 'meal00001', spaceId: 'space00001', version: 1, status: 'completed', title: '周末晚饭', date: '2026-09-30',
  diners: 2, note: '开饭前的安排', reflection: '吃完的回忆',
  photoFileIds: ['cloud://first', 'cloud://middle', 'cloud://last'],
  items: [{ id: 'item00001', recipeId: 'recipe00001', name: '番茄炒蛋', state: 'cooked' }] }
const clone = value => structuredClone(value)
const initial = clone(stored)
const ok = data => ({ result: { ok: true, data: clone(data) } })
const saves = () => calls.filter(call => call.action === 'saveMealMemory')
const tick = () => new Promise(resolve => setImmediate(resolve))

const app = { globalData: { configError: '', spaceName: '测试厨房' } }
global.getApp = () => app
global.Page = value => { definition = value }
global.wx = {
  env: { USER_DATA_PATH: '/user' },
  setNavigationBarTitle() {}, showLoading() {}, hideLoading() {}, showToast: options => toasts.push(options.title),
  showModal: options => { modals.push(options); if (options.success) options.success({ confirm: true }) },
  getStorageSync: key => clone(drafts.get(key)), setStorageSync: (key, value) => drafts.set(key, clone(value)),
  removeStorageSync: key => drafts.delete(key), enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
  previewImage() {},
  chooseMedia: ({ success, fail }) => {
    if (holdChoose) releaseChoose = success
    else if (cancelChoose) { cancelChoose = false; fail({ errMsg: 'chooseMedia:fail cancel' }) }
    else success({ tempFiles: [{ tempFilePath: '/tmp/meal-photo.jpg' }] })
  },
  compressImage: ({ success }) => success({ tempFilePath: '/tmp/meal-photo.jpg' }),
  getFileInfo: ({ filePath, success, fail }) => filePath === '/tmp/meal-photo.jpg' || savedFiles.has(filePath)
    ? success({ size: 4, digest: 'f1f2f3f4f5f6f7f8f9f0f1f2f3f4f5f6' }) : fail(new Error('file missing')),
  getImageInfo: ({ src, success, fail }) => src === '/tmp/meal-photo.jpg' || savedFiles.has(src)
    ? success({ width: 1, height: 1, type: 'jpeg' }) : fail(new Error('file missing')),
  getFileSystemManager: () => ({
    saveFile: ({ success }) => { const savedFilePath = `/saved/meal-${++savedFileCount}.jpg`; savedFiles.add(savedFilePath); success({ savedFilePath }) },
    readFile: ({ filePath, success, fail }) => filePath.startsWith('/saved/') && !savedFiles.has(filePath)
      ? fail(new Error('saved file missing')) : success({ data: Uint8Array.from([255, 216, 255, 217]).buffer }),
    unlink: ({ filePath, success }) => { savedFiles.delete(filePath); if (success) success() },
  }),
  request: ({ method, data, success }) => {
    assert.equal(method, 'PUT'); assert.ok(data instanceof ArrayBuffer); success({ statusCode: 200, data: '' })
  },
  cloud: { callFunction: async ({ data }) => {
    const { action, payload } = data
    calls.push(clone(data))
    if (action === 'bootstrap') return ok({ space: { _id: 'space00001', name: '测试厨房' }, member: { _id: memberId } })
    if (action === 'getMeal') return ok(stored)
    if (action === 'getRecipe') return ok({ _id: 'recipe00001', coverFileId: 'cloud://cover' })
    if (action === 'listRecords') return ok([{ _id: 'record00001', mealId: stored._id,
      mealItemId: 'item00001', recipeId: 'recipe00001', photoFileIds: dishPhotos }])
    if (action === 'mediaUrls') return ok({ urls: Object.fromEntries(payload.fileIds.map(id => [id, `https://example.test/${id.slice(8)}`])) })
    if (action === 'beginMediaUpload') return ok(uploadReceipts.has(payload.requestId)
      ? { fileId: uploadReceipts.get(payload.requestId) } : { url: 'https://upload.example.test/meal', headers: {} })
    if (action === 'finishMediaUpload') {
      let fileId = payload.requestId && uploadReceipts.get(payload.requestId)
      if (!fileId) {
        fileId = `cloud://new-${++uploads}`
        if (payload.requestId) uploadReceipts.set(payload.requestId, fileId)
      }
      if (uploadUnknown) { uploadUnknown = false; throw new Error('上传结果未知') }
      return ok({ fileId })
    }
    if (action === 'addMealItemPhoto') {
      dishPhotos.push(payload.fileId)
      stored = { ...stored, version: stored.version + 1 }
      if (loseDishResponse) { loseDishResponse = false; throw new Error('单菜照片响应丢失') }
      return ok({ mealVersion: stored.version, record: { _id: 'record00001', photoFileIds: dishPhotos } })
    }
    if (action === 'reopenMeal') {
      stored = { ...stored, status: 'confirmed', version: stored.version + 1 }
      return ok(stored)
    }
    if (action !== 'saveMealMemory') throw new Error(`unexpected action: ${action}`)
    if (holdSave) await new Promise(resolve => { releaseSave = resolve })
    if (rejectSave) { const code = rejectSave; rejectSave = ''; return { result: { ok: false, error: { code, message: '照片保存失败' } } } }
    assert.equal(payload.mealId, stored._id, 'editing memory updates the same meal')
    const receipt = payload.requestId && saveReceipts.get(payload.requestId)
    if (receipt) return ok({ ...stored, replayed: true, changedSinceReceipt: stored.version > receipt.version })
    if (saveUnknown === 'before') { saveUnknown = ''; throw new Error('保存结果未知') }
    if (payload.expectedStatus && stored.status !== payload.expectedStatus) return { result: { ok: false, error: { code: 'INVALID_STATE', message: '状态已变化' } } }
    if (payload.version !== stored.version) return { result: { ok: false, error: { code: 'VERSION_CONFLICT', message: '饭单已被更新' } } }
    stored = { ...stored, ...(Object.hasOwn(payload, 'photoFileIds') ? { photoFileIds: clone(payload.photoFileIds) } : {}),
      ...(Object.hasOwn(payload, 'reflection') ? { reflection: payload.reflection } : {}), version: stored.version + 1 }
    if (payload.requestId) saveReceipts.set(payload.requestId, { version: stored.version })
    if (saveUnknown === 'after') { saveUnknown = ''; throw new Error('保存结果未知') }
    return ok(stored)
  } },
}

function page() {
  const file = '../miniprogram/pages/meal/index'
  delete require.cache[require.resolve(file)]
  require(file)
  const result = { ...definition, data: clone(definition.data), setData(fields, callback) {
    for (const [key, value] of Object.entries(fields)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
    if (callback) callback()
  } }
  result.onLoad({ id: stored._id, mode: 'record', return: 'detail' })
  return result
}
const event = dataset => ({ currentTarget: { dataset } })
function reset() {
  stored = clone(initial)
  calls.length = toasts.length = modals.length = 0
  drafts.clear(); savedFiles.clear(); uploadReceipts.clear(); saveReceipts.clear()
  dishPhotos.splice(0, dishPhotos.length, 'cloud://dish-only')
  uploads = savedFileCount = 0
  holdSave = holdChoose = cancelChoose = loseDishResponse = uploadUnknown = false
  releaseSave = releaseChoose = null
  saveUnknown = rejectSave = ''
  memberId = 'member00001'
}

async function main() {
  let meal = page()
  await meal.load()
  assert.equal(meal.data.status, 'completed')
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), stored.photoFileIds)
  assert.equal(meal.data.meal.items[0].photoFileIds[0], 'cloud://dish-only')
  assert.equal(meal.data.photos.some(photo => photo.fileId === 'cloud://dish-only'), false,
    'a cooking photo is not copied into the whole-meal album')

  holdChoose = true
  const reads = calls.filter(call => call.action === 'getMeal').length
  const choosing = meal.addAlbumPhoto()
  await meal.onShow()
  assert.equal(calls.filter(call => call.action === 'getMeal').length, reads,
    'returning from the native photo picker does not start a reload while selection is pending')
  holdChoose = false
  releaseChoose({ tempFiles: [{ tempFilePath: '/tmp/meal-photo.jpg' }] })
  await choosing
  meal.onReflection({ detail: { value: '这一顿聊得很开心' } })
  assert.equal(meal.data.photos.length, 4)
  assert.equal(meal.data.memoryDirty, true)
  assert.deepEqual(stored.photoFileIds, ['cloud://first', 'cloud://middle', 'cloud://last'],
    'choosing a photo leaves the saved meal alone until save')
  await meal.saveMemory()
  assert.deepEqual(stored.photoFileIds, ['cloud://first', 'cloud://middle', 'cloud://last', 'cloud://new-1'])
  assert.equal(stored.reflection, '这一顿聊得很开心')
  assert.equal(stored.version, 2)
  assert.equal(meal.data.memoryDirty, false)

  meal = page()
  await meal.load()
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), stored.photoFileIds,
    'the whole-meal album survives leaving and reentering its detail page')
  meal.removeAlbumPhoto(event({ index: 1, fileId: 'cloud://middle' }))
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), ['cloud://first', 'cloud://last', 'cloud://new-1'])
  await meal.saveMemory()
  assert.deepEqual(stored.photoFileIds, ['cloud://first', 'cloud://last', 'cloud://new-1'])
  meal = page()
  await meal.load()
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), stored.photoFileIds,
    'a deleted middle photo does not return on reentry')

  await meal.addAlbumPhoto()
  meal.onReflection({ detail: { value: '修改后还没保存的心得' } })
  rejectSave = 'INVALID_INPUT'
  await meal.saveMemory()
  assert.equal(meal.data.memoryDirty, true, 'failed save keeps the album draft')
  assert.equal(meal.data.reflection, '修改后还没保存的心得', 'failed save keeps the reflection draft')
  assert.equal(meal.data.photos.length, 4)
  assert.equal(stored.photoFileIds.length, 3, 'failed save does not falsely persist the draft')
  assert.ok(toasts.includes('照片保存失败'))
  await meal.onShow()
  assert.equal(meal.data.photos.length, 4, 'returning to the page does not discard an unsaved album')
  await meal.saveMemory()
  assert.equal(uploads, 2, 'retry reuses an already uploaded file')
  assert.equal(stored.photoFileIds.length, 4)

  meal.onReflection({ detail: { value: '又想起一件事' } })
  holdSave = true
  const before = saves().length
  const pending = meal.saveMemory()
  await tick()
  await meal.saveMemory()
  assert.equal(saves().length, before + 1, 'repeated taps send only one memory save')
  assert.equal(meal.data.memorySaving, true)
  holdSave = false
  releaseSave()
  await pending
  assert.equal(stored.reflection, '又想起一件事')
  assert.equal(stored._id, 'meal00001')

  stored = { ...stored, version: stored.version + 1, note: '另一位成员更新了安排' }
  meal.onReflection({ detail: { value: '冲突时也要保留的心得' } })
  await meal.saveMemory()
  assert.equal(meal.data.reflection, '冲突时也要保留的心得')
  if (meal.data.memoryDirty) await meal.saveMemory()
  assert.equal(stored.reflection, '冲突时也要保留的心得', 'a version conflict can be retried without losing the draft')
  assert.equal(meal.data.memoryDirty, false)

  stored = { ...stored, version: stored.version + 1, reflection: '伙伴刚写的回忆' }
  meal.onReflection({ detail: { value: '我刚写的回忆' } })
  await meal.saveMemory()
  assert.equal(meal.data.memoryDirty, true, 'a simultaneous memory edit keeps the local draft')
  assert.equal(meal.data.memoryConflictReflection, true)
  assert.equal(meal.data.memoryRemoteReflection, '伙伴刚写的回忆')
  await meal.resolveMemoryConflict(event({ field: 'reflection', choice: 'mine' }))
  await meal.saveMemory()
  assert.equal(stored.reflection, '我刚写的回忆', 'explicitly keeping the local reflection resolves a simultaneous memory edit')

  await meal.addAlbumPhoto()
  meal.onReflection({ detail: { value: '还没保存的整顿饭心得' } })
  const draftLength = meal.data.photos.length
  loseDishResponse = true
  await meal.addPhoto(meal.data.meal.items[0])
  assert.equal(meal.data.photos.length, draftLength, 'a lost per-dish photo response keeps the unsaved whole-meal album')
  assert.equal(meal.data.reflection, '还没保存的整顿饭心得')
  assert.equal(meal.data.memoryDirty, true)

  const reopens = calls.filter(call => call.action === 'reopenMeal').length
  meal.reopen()
  await tick()
  assert.equal(calls.filter(call => call.action === 'reopenMeal').length, reopens,
    'undoing completion cannot hide an unsaved meal album behind another status')
  assert.equal(meal.data.status, 'completed')
  assert.equal(meal.data.memoryDirty, true)
  await layoutAndEmpty()
  await fieldMerges()
  await unknownRecovery()
  await coldStartAndState()
  console.log('整顿饭相册：三列/空态、增删重进、字段合并、冲突选择、未知结果重放、本机草稿隔离与状态保护检查通过')
}

async function layoutAndEmpty() {
  reset()
  const view = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/meal/index.wxml'), 'utf8')
  const style = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/meal/index.wxss'), 'utf8')
  assert.match(style, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(style, /\.album-photo\s*\{[^}]*padding-top:\s*100%/)
  assert.match(view, /wx:for="\{\{photos\}\}"/)
  assert.match(view, /photos\.length < 12/)
  assert.match(view, /catchtap="removeAlbumPhoto"/)
  stored = { ...stored, photoFileIds: [], reflection: '' }
  let meal = page()
  await meal.load()
  assert.deepEqual(meal.data.photos, [], 'an empty meal album starts without borrowed dish or cover photos')
  cancelChoose = true
  const beforeToast = toasts.length
  await meal.addAlbumPhoto()
  assert.equal(meal.data.photos.length, 0, 'cancelling the picker does not add a photo')
  assert.equal(meal.data.memoryDirty, false)
  assert.equal(toasts.length, beforeToast)
  for (let i = 1; i <= 4; i++) {
    await meal.addAlbumPhoto()
    assert.equal(meal.data.photos.length, i, `${i} photos keep their natural grid slots`)
  }
  assert.equal(new Set(meal.data.photos.map(photo => photo.localPath)).size, 4)
  const selected = meal.data.photos.map(photo => photo.localPath)
  meal.removeAlbumPhoto(event({ index: 1 }))
  assert.deepEqual(meal.data.photos.map(photo => photo.localPath), [selected[0], selected[2], selected[3]],
    'deleting a middle tile moves following photos forward')
  assert.equal(savedFiles.has(selected[1]), false, 'a removed local tile releases its saved file')
  await meal.saveMemory()
  assert.equal(stored.photoFileIds.length, 3)
  meal = page()
  await meal.load()
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), stored.photoFileIds)
  for (let i = meal.data.photos.length - 1; i >= 0; i--) meal.removeAlbumPhoto(event({ index: i }))
  await meal.saveMemory()
  assert.deepEqual(stored.photoFileIds, [], 'saving an empty album removes all meal references')
  meal = page()
  await meal.load()
  assert.deepEqual(meal.data.photos, [], 'removed photos do not return on reentry')
}

async function fieldMerges() {
  reset()
  const meal = page()
  await meal.load()
  meal.onReflection({ detail: { value: '只改心得' } })
  await meal.saveMemory()
  assert.equal(Object.hasOwn(saves().at(-1).payload, 'photoFileIds'), false,
    'a reflection-only save does not resend the album')
  assert.deepEqual(stored.photoFileIds, initial.photoFileIds)

  await meal.addAlbumPhoto()
  stored = { ...stored, reflection: '伙伴同时改了心得', version: stored.version + 1 }
  const before = saves().length
  await meal.saveMemory()
  const attempts = saves().slice(before)
  assert.equal(attempts.length, 2, 'an unrelated version change is retried once')
  assert.ok(attempts.every(call => Object.hasOwn(call.payload, 'photoFileIds') && !Object.hasOwn(call.payload, 'reflection')),
    'a photo-only save never overwrites the partner reflection')
  assert.equal(stored.reflection, '伙伴同时改了心得')
  assert.equal(stored.photoFileIds.length, 4)

  meal.onReflection({ detail: { value: '本页的心得' } })
  stored = { ...stored, reflection: '伙伴又写的心得', version: stored.version + 1 }
  await meal.saveMemory()
  assert.equal(meal.data.memoryConflictReflection, true)
  assert.equal(meal.data.reflection, '本页的心得', 'same-field conflict keeps the local draft')
  assert.equal(stored.reflection, '伙伴又写的心得')
  await meal.resolveMemoryConflict(event({ field: 'reflection', choice: 'latest' }))
  assert.equal(meal.data.reflection, '伙伴又写的心得', 'the explicit latest choice keeps the partner version')
  assert.equal(meal.data.memoryConflictReflection, false)

  await meal.addAlbumPhoto()
  const localPath = meal.data.photos.at(-1).localPath
  stored = { ...stored, photoFileIds: [...stored.photoFileIds, 'cloud://partner-photo'], version: stored.version + 1 }
  await meal.saveMemory()
  assert.equal(meal.data.memoryConflictPhotos, true)
  assert.equal(meal.data.photos.at(-1).localPath, localPath)
  await meal.resolveMemoryConflict(event({ field: 'photoFileIds', choice: 'latest' }))
  assert.deepEqual(meal.data.photos.map(photo => photo.fileId), stored.photoFileIds)
  assert.equal(savedFiles.has(localPath), false, 'choosing saved photos removes discarded local drafts')
}

async function unknownRecovery() {
  reset()
  let meal = page()
  await meal.load()
  await meal.addAlbumPhoto()
  uploadUnknown = true
  await meal.saveMemory()
  assert.equal(uploads, 1)
  assert.equal(meal.data.memoryDirty, true)
  assert.equal(meal.data.pendingMemoryPayload, null, 'unknown upload is retried before making a save request')
  const uploadRequest = calls.filter(call => call.action === 'beginMediaUpload')[0].payload.requestId
  await meal.saveMemory()
  assert.equal(uploads, 1, 'upload retry uses the original receipt without a second physical upload')
  assert.equal(calls.filter(call => call.action === 'beginMediaUpload')[1].payload.requestId, uploadRequest)
  assert.equal(stored.photoFileIds.length, 4)

  reset()
  meal = page()
  await meal.load()
  await meal.addAlbumPhoto()
  meal.onReflection({ detail: { value: '等待确认的回忆' } })
  saveUnknown = 'before'
  await meal.saveMemory()
  const pending = clone(meal.data.pendingMemoryPayload)
  assert.ok(pending && pending.requestId)
  assert.equal(meal.data.memoryDirty, true)
  assert.equal(stored.photoFileIds.length, 3)
  const uploaded = uploads
  meal.onUnload()
  meal = page()
  await meal.load()
  assert.deepEqual(meal.data.pendingMemoryPayload, pending, 'cold start restores the exact unresolved request')
  assert.equal(meal.data.photos.length, 4)
  await meal.saveMemory()
  assert.equal(uploads, uploaded)
  assert.deepEqual(saves().at(-1).payload, pending, 'retry replays the exact request payload')
  assert.equal(stored.reflection, '等待确认的回忆')
  assert.equal(meal.data.memoryDirty, false)

  reset()
  meal = page()
  await meal.load()
  meal.onReflection({ detail: { value: '已经提交的心得' } })
  saveUnknown = 'after'
  await meal.saveMemory()
  const committed = clone(meal.data.pendingMemoryPayload)
  assert.ok(committed)
  stored = { ...stored, version: stored.version + 1, reflection: '伙伴随后更新的心得' }
  await meal.saveMemory()
  assert.deepEqual(saves().at(-1).payload, committed)
  assert.equal(meal.data.memoryDirty, false)
  assert.equal(meal.data.reflection, '伙伴随后更新的心得')
  assert.match(meal.data.memoryNotice, /此后.*有更新/)
  assert.equal(toasts.includes('这顿的记录已保存'), false, 'receipt replay never claims the later partner edit was ours')
}

async function coldStartAndState() {
  reset()
  stored = { ...stored, photoFileIds: [], reflection: '' }
  let meal = page()
  await meal.load()
  await meal.addAlbumPhoto()
  meal.onReflection({ detail: { value: '仅存在本机的草稿' } })
  const localPath = meal.data.photos[0].localPath
  const ownKey = meal.memoryDraftKey
  assert.ok(savedFiles.has(localPath) && drafts.has(ownKey))
  meal.onUnload()
  meal = page()
  await meal.load()
  assert.equal(meal.data.photos[0].localPath, localPath, 'same member restores a stable saved file path')
  assert.equal(meal.data.reflection, '仅存在本机的草稿')
  memberId = 'member00002'
  const partner = page()
  await partner.load()
  assert.deepEqual(partner.data.photos, [], 'another member does not see the first member local draft')
  assert.equal(partner.data.reflection, '')
  memberId = 'member00001'
  meal = page()
  await meal.load()
  assert.equal(meal.data.photos[0].localPath, localPath)
  await meal.cancelMemory()
  assert.equal(drafts.has(ownKey), false)
  assert.equal(savedFiles.has(localPath), false)

  await meal.addAlbumPhoto()
  const unsaved = meal.data.photos[0].localPath
  stored = { ...stored, status: 'confirmed', version: stored.version + 1 }
  await meal.saveMemory()
  assert.equal(meal.data.status, 'confirmed', 'a revoked completion prevents saving new meal memories')
  assert.equal(meal.data.memoryDirty, true, 'status changes keep the local album draft')
  assert.equal(meal.data.photos[0].localPath, unsaved)
  const count = saves().length
  await meal.saveMemory()
  assert.equal(saves().length, count, 'a second tap cannot bypass the revoked status')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
