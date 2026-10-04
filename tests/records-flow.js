const assert = require('node:assert/strict')

const app = { globalData: { configError: '', spaceName: '我们的厨房' } }
const calls = []
const routes = []
const toasts = []
let records = []
let meals = []
let recipes = []
let currentMealId = ''
let failure = ''
let heldAction = ''
let releaseRequest
let unavailableMedia = new Set()
let loseDeleteResponse = false
const deletedKeys = new Set()
const deleteFailures = new Set(), deleteLostResponses = new Set()
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

global.getApp = () => app
global.getCurrentPages = () => []
const route = method => options => {
  routes.push({ method, url: options.url })
  if (options.success) options.success()
}
global.wx = {
  setNavigationBarTitle() {}, stopPullDownRefresh() {}, showLoading() {}, hideLoading() {},
  showToast: options => toasts.push(options.title),
  navigateTo: route('navigateTo'), redirectTo: route('redirectTo'), switchTab: route('switchTab'),
  cloud: { callFunction: async ({ data }) => {
    const { action, payload } = data
    const recordSnapshot = records
    const mealSnapshot = meals
    calls.push({ action, payload })
    if (action === heldAction) {
      const held = deferred()
      releaseRequest = held.resolve
      await held.promise
    }
    if (action === failure) return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '记录暂时未能加载' } } }
    let value
    if (action === 'bootstrap') value = { space: { _id: 'space00001', currentMealId }, member: { _id: 'member00001' } }
    else if (action === 'listRecords') value = recordSnapshot.filter(item => !payload.mealId || item.mealId === payload.mealId).slice(payload.offset || 0, (payload.offset || 0) + 50)
    else if (action === 'listMeals') value = mealSnapshot.slice(payload.offset || 0, (payload.offset || 0) + 50)
    else if (action === 'listRecipes') value = recipes
    else if (action === 'listWishes') value = []
    else if (action === 'getMeal') {
      value = meals.find(item => item._id === payload.id && !item.deletedAt)
      if (!value) return { result: { ok: false, error: { code: 'NOT_FOUND', message: '记录不存在' } } }
    }
    else if (action === 'getRecipe') value = { _id: payload.id, name: '番茄炒蛋', coverFileId: 'cloud://recipe-cover' }
    else if (action === 'mediaUrls') value = { urls: Object.fromEntries(payload.fileIds.filter(id => !unavailableMedia.has(id)).map(id => [id, `https://example.test/${id.slice(8)}.jpg`])) }
    else if (action === 'deleteRecord') {
      const key=payload.kind+':'+payload.id
      if (deleteFailures.has(key)) return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '删除暂时失败' } } }
      const target=(payload.kind==='meal'?meals:records).find(item=>item._id===payload.id)
      if (!deletedKeys.has(key) && target.version!==payload.version) return {result:{ok:false,error:{code:'VERSION_CONFLICT',message:'伙伴刚修改了这条记录'}}}
      deletedKeys.add(key)
      if(payload.kind==='meal') {meals=meals.filter(item=>item._id!==payload.id);if(currentMealId===payload.id)currentMealId=''}
      else {
        records=records.filter(item=>item._id!==payload.id)
        meals=meals.map(meal=>!(meal.items||[]).some(item=>item.recordId===payload.id)?meal:{...meal,version:meal.version+1,
          items:meal.items.map(item=>item.recordId===payload.id?{...item,recordId:''}:item)})
      }
      if(loseDeleteResponse || deleteLostResponses.has(key)){loseDeleteResponse=false;deleteLostResponses.delete(key);throw new Error('响应丢失')}
      value={id:payload.id,kind:payload.kind}
    }
    else throw new Error(`unexpected request, record browsing must not write: ${action}`)
    return { result: { ok: true, data: value } }
  } },
}

const definition = require('../miniprogram/pages/records/page')
function page(kind) {
  const instance = { ...definition, data: structuredClone(definition.data), setData(fields) { Object.assign(this.data, fields) } }
  instance.onLoad(kind ? { kind } : {})
  return instance
}
function reset() {
  records = []
  meals = []
  currentMealId = ''
  failure = heldAction = ''
  releaseRequest = null
  unavailableMedia = new Set()
  deletedKeys.clear();deleteFailures.clear();deleteLostResponses.clear();loseDeleteResponse=false
  calls.length = routes.length = toasts.length = 0
}
function meal(id, status, name = '周末晚饭') {
  return { _id: id, version: 1, title: name, status, date: '2026-09-29', diners: 2, note: '',
    items: [{ id: `dish${id}`, recipeId: 'recipe00001', name: '番茄炒蛋', state: status === 'completed' ? 'cooked' : 'planned' }] }
}
function record(id, photo = false) {
  return { _id: id, name: '葱油拌面', date: '2026-09-28', note: '这次葱油火候刚好', makerName: '小林',
    recipeId: 'recipe00002', photoFileIds: photo ? ['cloud://cooking-photo'] : [] }
}

async function main() {
  reset()
  records = [record('record00001', true), record('record00002')]
  meals = [meal('meal00001', 'draft'), meal('meal00002', 'confirmed'), meal('meal00003', 'completed'), meal('meal00004', 'cancelled')]
  const home = page()
  await home.onShow()
  assert.equal(home.data.mode, 'all')
  assert.equal(home.data.timeline.length, 5, 'home includes both record types and hides cancelled meals')
  assert.equal(home.data.timeline.filter(item => item.kind === 'record').length, 2)
  const statuses = new Map(home.data.timeline.filter(item => item.kind === 'meal').map(item => [item.status, item]))
  for (const [status, label] of [['draft', '待确认'], ['confirmed', '待开饭'], ['completed', '已完成']]) {
    assert.equal(statuses.get(status).statusLabel, label)
    assert.equal(statuses.get(status).kindLabel, status === 'completed' ? '吃饭记录' : `${label}饭单`)
    assert.ok(statuses.get(status).dishSummary.includes('番茄炒蛋'), 'real dish names distinguish meal rows')
  }
  const photographed = home.data.timeline.find(item => item.id === 'record00001')
  assert.equal(photographed.photoUrl, 'https://example.test/cooking-photo.jpg')
  assert.equal(photographed.note, '这次葱油火候刚好')
  const withoutPhoto = home.data.timeline.find(item => item.id === 'record00002')
  assert.equal(withoutPhoto.name, '葱油拌面', 'no-photo records retain their identity')
  assert.equal(withoutPhoto.photoUrl, '')

  const cooking = page('cooking')
  await cooking.onShow()
  assert.equal(cooking.data.mode, 'cooking')
  assert.equal(cooking.data.timeline.length, 2)
  assert.ok(cooking.data.timeline.every(item => item.kind === 'record'))
  const together = page('meals')
  await together.onShow()
  assert.equal(together.data.mode, 'meals')
  assert.equal(together.data.timeline.length, 3)
  assert.ok(together.data.timeline.every(item => item.kind === 'meal' && item.status !== 'cancelled'))

  records = Array.from({ length: 15 }, (_, index) => record(`record${index}`))
  await home.load(true)
  assert.equal(home.data.timeline.length, 12, 'home is a recent preview, the module holds the full list')
  await cooking.load(true)
  assert.equal(cooking.data.timeline.length, 15)

  records = [
    { ...record('linkedphoto01', true), recipeId: 'recipe00001', mealId: 'photomeal001' },
    { ...record('linkedphoto02'), recipeId: 'recipe00001', mealId: 'photomeal002', photoFileIds: ['cloud://other-meal-photo'] },
    { ...record('standalone01'), recipeId: 'recipe00001', photoFileIds: ['cloud://standalone-photo'] },
  ]
  meals = [{ ...meal('photomeal001', 'completed'), photoFileIds: ['cloud://dinner-photo'] }, meal('photomeal002', 'completed')]
  const linkedPhotos = page('meals')
  await linkedPhotos.load(true)
  assert.deepEqual(linkedPhotos.data.timeline.find(item => item.id === 'photomeal001').photos.map(photo => photo.url),
    ['https://example.test/dinner-photo.jpg'], 'meal cards use only the whole-meal album, not a linked cooking record')
  assert.deepEqual(linkedPhotos.data.timeline.find(item => item.id === 'photomeal002').photos.map(photo => photo.url),
    [], 'a meal without album photos stays photo-free even when a linked dish has photos')

  records = [{ _id: 'legacyrecord1', name: '旧记录里的面条', date: '2026-09-27', note: '保留的心得' }]
  meals = [{ _id: 'legacymeal01', title: '以前的一顿饭', status: 'completed', date: '2026-09-27', diners: 2 }]
  const legacy = page()
  await legacy.load(true)
  assert.equal(legacy.data.error, '')
  assert.equal(legacy.data.timeline.find(item => item.kind === 'record').photoUrl, '')
  const legacyMeal = legacy.data.timeline.find(item => item.kind === 'meal')
  assert.equal(legacyMeal.dishCount, 0)
  assert.equal(legacyMeal.dishSummary, '本次未记录实际菜品')
  assert.deepEqual(legacyMeal.photos, [], 'missing legacy items and photoFileIds must not break the record list')

  reset()
  records = Array.from({ length: 5 }, (_, count) => ({ ...record(`layout${count}`), coverFileId: 'cloud://not-this-time',
    photoFileIds: Array.from({ length: count }, (_, index) => `cloud://layout${count}-${index}`) }))
  meals = Array.from({ length: 5 }, (_, count) => ({ ...meal(`layoutmeal${count}`, 'completed'),
    photoFileIds: Array.from({ length: count }, (_, index) => `cloud://meal${count}-${index}`) }))
  const layout = page()
  await layout.load(true)
  for (const item of layout.data.timeline) {
    const count = Number(item.id.slice(-1))
    assert.equal(item.photoCount, count, 'record and meal galleries use the saved photo count')
    assert.equal(item.previewPhotos.length, Math.min(count, 3), 'the homepage shows at most the first three photos')
    assert.ok(item.photos.every(photo => photo.state === 'loading'), 'a resolved URL waits for the real image load event')
    assert.ok(item.photos.every(photo => !photo.fileId.includes('not-this-time')), 'record galleries never fall back to the long-term dish cover')
  }
  assert.equal(calls.some(call => call.action === 'getRecipe'), false)
  assert.equal(calls.some(call => call.action === 'listRecords' && call.payload.mealId), false, 'small record collections need no extra per-meal photo queries')
  records = [{ ...record('photoformats'), photoFileIds: [{ fileID: 'cloud://object-photo' }, { fileId: 'cloud://object-photo' }, 'cloud://string-photo'] }]
  meals = [{ ...meal('ownandlinked', 'completed'), photoFileIds: 'cloud://meal-own' }]
  records.push({ ...record('linkedformats'), mealId: 'ownandlinked', photoFileIds: ['cloud://meal-own', 'cloud://linked-photo'] })
  await layout.load(true)
  assert.deepEqual(layout.data.timeline.find(item => item.id === 'photoformats').photos.map(photo => photo.fileId), ['cloud://object-photo', 'cloud://string-photo'])
  assert.deepEqual(layout.data.timeline.find(item => item.id === 'ownandlinked').photos.map(photo => photo.fileId), ['cloud://meal-own'])

  reset()
  records = Array.from({ length: 50 }, (_, index) => record(`recent${index}`)).concat(
    Array.from({ length: 51 }, (_, index) => ({ ...record(`olderlinked${index}`), mealId: 'oldermeal', photoFileIds: [`cloud://older-${index}`] })))
  meals = [{ ...meal('oldermeal', 'completed'), photoFileIds: ['cloud://meal-album'] }]
  const olderMeal = page()
  await olderMeal.load(true)
  const fullAlbum = olderMeal.data.timeline.find(item => item.id === 'oldermeal')
  assert.equal(fullAlbum.photoCount, 1, 'whole-meal album count excludes linked cooking records')
  assert.equal(fullAlbum.previewPhotos.length, 1)
  assert.deepEqual(calls.filter(call => call.action === 'listRecords' && call.payload.mealId === 'oldermeal'), [],
    'meal cards do not page through cooking records for album photos')
  assert.equal(olderMeal.data.records.length, 50, 'the cooking record list still keeps its own pagination')

  reset()
  records = [record('slowphoto', true)]
  const slowPhotos = page()
  heldAction = 'mediaUrls'
  const waitingPhotos = slowPhotos.load(true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(slowPhotos.data.loading, false, 'the record content is usable while its photos resolve')
  assert.equal(slowPhotos.data.timeline[0].photoCount, 1)
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'loading')
  assert.equal(slowPhotos.data.timeline[0].photos[0].url, '')
  heldAction = ''
  releaseRequest()
  await waitingPhotos
  const photoEvent = () => ({ currentTarget: { dataset: { recordKey: 'record:slowphoto', fileId: 'cloud://cooking-photo', url: slowPhotos.data.timeline[0].photos[0].url } } })
  slowPhotos.photoLoaded(photoEvent())
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'ready')
  await slowPhotos.load(false)
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'ready', 'an already loaded image keeps its ready state when pagination retains the same URL')
  slowPhotos.photoFailed(photoEvent())
  assert.equal(slowPhotos.data.timeline[0].photoCount, 1, 'an image download error must not turn the record into a no-photo layout')
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'error')
  heldAction = 'mediaUrls'
  const beforeRetry = calls.filter(call => call.action === 'mediaUrls').length
  const retryPhoto = slowPhotos.retryPhoto(photoEvent())
  slowPhotos.retryPhoto(photoEvent())
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'loading')
  assert.equal(calls.filter(call => call.action === 'mediaUrls').length, beforeRetry + 1, 'repeated retry taps send only one photo lookup')
  heldAction = ''
  releaseRequest()
  await retryPhoto
  assert.equal(routes.length, 0, 'retrying a failed image does not navigate away')
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'loading')
  slowPhotos.photoLoaded(photoEvent())
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'ready')

  failure = 'mediaUrls'
  await slowPhotos.load(true)
  assert.equal(slowPhotos.data.error, '', 'photo failures do not hide the record content')
  assert.equal(slowPhotos.data.timeline[0].photoCount, 1)
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'error')
  assert.equal(slowPhotos.data.timeline[0].photos[0].url, '')
  failure = ''
  await slowPhotos.retryPhoto(photoEvent())
  assert.equal(slowPhotos.data.timeline[0].photos[0].url, 'https://example.test/cooking-photo.jpg')

  records = [{ ...record('partialphotos'), photoFileIds: ['cloud://ok-photo', 'cloud://missing-photo'] }]
  unavailableMedia.add('cloud://missing-photo')
  await slowPhotos.load(true)
  assert.equal(slowPhotos.data.timeline[0].photoCount, 2)
  assert.equal(slowPhotos.data.timeline[0].previewPhotos.length, 2)
  assert.equal(slowPhotos.data.timeline[0].photos[0].state, 'loading')
  assert.equal(slowPhotos.data.timeline[0].photos[1].state, 'error', 'one missing URL keeps its own retry slot beside successful photos')

  reset()
  for (const kind of [undefined, 'cooking', 'meals']) {
    const empty = page(kind)
    await empty.onShow()
    assert.equal(empty.data.loading, false)
    assert.equal(empty.data.error, '')
    assert.deepEqual(empty.data.timeline, [], `${kind || 'all'} supports an empty list`)
  }

  meals = [meal('slowmeal001', 'draft')]
  const delayed = page('meals')
  heldAction = 'listMeals'
  const pending = delayed.load(true)
  assert.equal(delayed.data.loading, true, 'a pending first request remains loading instead of showing an empty state')
  assert.deepEqual(delayed.data.timeline, [])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof releaseRequest, 'function')
  heldAction = ''
  releaseRequest()
  await pending
  assert.equal(delayed.data.timeline[0].id, 'slowmeal001')
  assert.equal(delayed.data.loading, false)

  const overlapping = page('meals')
  heldAction = 'listMeals'
  const olderLoad = overlapping.load(true)
  const releaseOlder = releaseRequest
  heldAction = ''
  meals = [meal('latestmeal01', 'confirmed', '新请求看到的饭单')]
  await overlapping.load(true)
  assert.equal(overlapping.data.timeline[0].id, 'latestmeal01')
  releaseOlder()
  await olderLoad
  assert.equal(overlapping.data.timeline[0].id, 'latestmeal01', 'a slow earlier reload cannot replace the newer result')
  assert.equal(overlapping.data.timeline[0].title, '新请求看到的饭单')

  meals = [meal('slowmeal001', 'draft')]
  failure = 'listMeals'
  const failed = page('meals')
  await failed.load(true)
  assert.equal(failed.data.loading, false)
  assert.equal(failed.data.error, '记录暂时未能加载', 'request failure must be distinct from empty data')
  failure = ''
  await failed.load(true)
  assert.equal(failed.data.error, '')
  assert.equal(failed.data.timeline[0].id, 'slowmeal001', 'a failed list can be retried')

  reset()
  meals = [...Array.from({ length: 50 }, (_, index) => meal(`cancelled${index}`, 'cancelled')), meal('olderdraft01', 'draft')]
  const hiddenFirstPage = page('meals')
  await hiddenFirstPage.load(true)
  assert.deepEqual(calls.filter(call => call.action === 'listMeals').map(call => call.payload.offset || 0), [0, 50])
  assert.deepEqual(hiddenFirstPage.data.timeline.map(item => item.id), ['olderdraft01'], 'cancelled first page cannot hide older active meals')

  reset()
  const navigation = page()
  await navigation.onShow()
  navigation.openModule({ currentTarget: { dataset: { kind: 'cooking' } } })
  navigation.openModule({ currentTarget: { dataset: { kind: 'meals' } } })
  navigation.newRecord()
  assert.equal(navigation.data.showRecordMenu, false, 'the home page has no cooking-list popup')
  navigation.open({ currentTarget: { dataset: { kind: 'record', id: 'record00001' } } })
  navigation.open({ currentTarget: { dataset: { kind: 'meal', id: 'meal00001' } } })
  assert.deepEqual(routes, [
    { method: 'navigateTo', url: '/pages/record-list/index?kind=cooking' },
    { method: 'navigateTo', url: '/pages/record-list/index?kind=meals' },
    { method: 'navigateTo', url: '/pages/record-edit/index?id=record00001' },
    { method: 'navigateTo', url: '/pages/meal/index?id=meal00001' },
  ])

  routes.length = 0
  const creation = page('cooking')
  await creation.onShow()
  creation.newRecord()
  assert.equal(creation.data.showRecordMenu, true)
  assert.equal(routes.length, 0, 'the plus button opens a menu without navigating')
  creation.newRecord()
  assert.equal(creation.data.showRecordMenu, false, 'the same button toggles the menu closed')
  creation.newRecord()
  creation.closeRecordMenu()
  assert.equal(creation.data.showRecordMenu, false, 'outside tap closes the anchored menu')
  creation.newRecord()
  creation.onHide()
  assert.equal(creation.data.showRecordMenu, false, 'leaving the list closes the menu')
  await creation.onShow()
  assert.equal(creation.data.showRecordMenu, false, 'returning to the list does not reopen the menu')
  for (const kind of ['existing', 'new']) {
    creation.newRecord()
    creation.chooseRecord({ currentTarget: { dataset: { kind } } })
    assert.equal(creation.data.showRecordMenu, false)
    const count = routes.length
    creation.chooseRecord({ currentTarget: { dataset: { kind } } })
    assert.equal(routes.length, count, 'a repeated selection cannot navigate twice')
  }
  assert.deepEqual(routes, [
    { method: 'navigateTo', url: '/pages/record-edit/index' },
    { method: 'navigateTo', url: '/pages/recipe-edit/index?mode=cooking' },
  ])
  creation.routePending = true
  creation.newRecord()
  assert.equal(creation.data.showRecordMenu, false, 'pending navigation cannot reopen the menu')
  const mealList = page('meals')
  mealList.newRecord()
  assert.equal(mealList.data.showRecordMenu, false, 'meal-list navigation is unchanged')

  routes.length = 0
  calls.length = 0
  currentMealId = 'meal00001'
  navigation.newMeal()
  navigation.newMeal()
  assert.equal(calls.filter(call => call.action === 'bootstrap').length, 0, 'direct record does not look up or replace the active plan')
  assert.deepEqual(routes, [{ method: 'navigateTo', url: '/pages/meal/index?mode=record' }], 'rapid taps open one direct recording form')
  await navigation.onShow()
  currentMealId = ''
  navigation.newMeal()
  assert.deepEqual(routes.at(-1), { method: 'navigateTo', url: '/pages/meal/index?mode=record' }, 'new record has the same independent entry without a plan')
  let editor
  wx.getStorageSync = () => null
  global.Page = definition => { editor = { ...definition, data: structuredClone(definition.data), setData(fields) { Object.assign(this.data, fields) } } }
  require('../miniprogram/pages/record-edit/index')
  await editor.onLoad({})
  assert.equal(editor.data.choices.length, 0)
  recipes = [{ _id: 'recipe00001', name: '番茄炒蛋' }]
  await editor.onLoad({})
  assert.equal(editor.data.choices[0].recipeId, 'recipe00001', 'opening the existing-dish flow loads current recipe choices')
  { reset();records=[{...record('delete-record-001'),version:1}];meals=[meal('delete-meal-001','draft')];currentMealId='delete-meal-001'
  const recent=page(),cookingList=page('cooking'),mealList=page('meals');await recent.onShow();await cookingList.onShow();await mealList.onShow()
  const gesture=(key,x,y=100)=>({currentTarget:{dataset:{id:key}},touches:[{clientX:x,clientY:y}],changedTouches:[{clientX:x,clientY:y}]})
  recent.swipeStart(gesture('record:delete-record-001',220));recent.swipeEnd(gesture('record:delete-record-001',130,240));assert.equal(recent.data.openId,'','vertical scrolling does not reveal deletion')
  recent.swipeStart(gesture('record:delete-record-001',220));recent.swipeEnd(gesture('record:delete-record-001',110));assert.equal(recent.data.openId,'record:delete-record-001')
  recent.open({currentTarget:{dataset:{id:'delete-record-001',kind:'record'}}});assert.equal(recent.data.openId,'record:delete-record-001','tap emitted at swipe end must not close the deletion slot')
  recent.askDelete({currentTarget:{dataset:{key:'record:delete-record-001'}}});recent.closeDelete();assert.equal(records.length,1,'confirmation cancel writes nothing')
  assert.equal(recent.swipeMoved,false,'cancel restores normal row clicks')
  cookingList.askDelete({currentTarget:{dataset:{key:'record:delete-record-001'}}});failure='deleteRecord';await cookingList.confirmDelete();assert.equal(cookingList.data.timeline.length,1);assert.ok(cookingList.data.deleteError);assert.equal(toasts.includes('记录已删除'),false)
  failure='';loseDeleteResponse=true;await cookingList.confirmDelete();assert.ok(cookingList.data.deleteTarget);assert.ok(cookingList.data.deleteError);assert.equal(toasts.includes('记录已删除'),false,'lost response is never reported as success')
  await Promise.all([cookingList.confirmDelete(),cookingList.confirmDelete()]);assert.equal(cookingList.data.timeline.length,0)
  await recent.onShow();assert.equal(recent.data.timeline.filter(item=>item.kind==='record').length,0,'same record removed across lists')
  mealList.askDelete({currentTarget:{dataset:{key:'meal:delete-meal-001'}}});meals[0].version++
  await mealList.confirmDelete();assert.equal(mealList.data.deleteTarget,null);assert.equal(mealList.data.timeline.length,1,'conflict refreshes and requires a new confirmation')
  mealList.askDelete({currentTarget:{dataset:{key:'meal:delete-meal-001'}}});await mealList.confirmDelete();await recent.onShow();assert.equal(recent.data.timeline.length,0);assert.equal(currentMealId,'') }

  reset()
  records = [record('parallel-identity')]
  const returning = page('cooking')
  heldAction = 'bootstrap'
  const restoring = returning.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call.action === 'listRecords').length, 1, 'return loads records while identity is being restored, removing one serial network wait')
  assert.equal(returning.data.timeline.length, 0, 'parallel loading still waits for identity before showing content')
  assert.equal(returning.data.loading, true)
  heldAction = ''
  releaseRequest()
  await restoring
  assert.equal(returning.data.timeline[0].id, 'parallel-identity')

  reset()
  records = Array.from({ length: 51 }, (_, index) => ({ ...record(`page-delete-${index}`), version: 1 }))
  const pagedDeletion = page('cooking')
  await pagedDeletion.onShow()
  pagedDeletion.askDelete({ currentTarget: { dataset: { key: 'record:page-delete-0' } } })
  calls.length = 0
  heldAction = 'deleteRecord'
  const deleting = pagedDeletion.confirmDelete()
  assert.equal(pagedDeletion.data.timeline.length, 50, 'a pending delete keeps the record until the server confirms')
  assert.equal(pagedDeletion.data.deleting, true, 'the pressed delete action responds immediately')
  heldAction = ''
  releaseRequest()
  await deleting
  assert.deepEqual(calls.map(call => call.action), ['deleteRecord'], 'confirmed deletion needs no bootstrap or whole-list reload')
  assert.equal(pagedDeletion.data.timeline.length, 49)
  assert.equal(pagedDeletion.data.recordOffset, 49)
  assert.equal(pagedDeletion.data.loading, false)
  assert.equal(pagedDeletion.data.deleting, false)
  await pagedDeletion.load(false)
  assert.equal(pagedDeletion.data.timeline.length, 50)
  assert.equal(pagedDeletion.data.timeline.some(item => item.id === 'page-delete-50'), true, 'deleting an earlier row must not skip the next page boundary')

  reset()
  meals = Array.from({ length: 52 }, (_, index) => meal(`highlight-delete-${index}`, 'completed'))
  const highlighted = page('meals')
  highlighted.setData({ highlightMealId: 'highlight-delete-51' })
  await highlighted.onShow()
  assert.equal(highlighted.data.mealOffset, 50)
  assert.equal(highlighted.data.timeline.length, 51)
  highlighted.askDelete({ currentTarget: { dataset: { key: 'meal:highlight-delete-51' } } })
  await highlighted.confirmDelete()
  assert.equal(highlighted.data.mealOffset, 50, 'a highlighted meal fetched outside the page does not shift the page offset')
  await highlighted.load(false)
  assert.equal(highlighted.data.timeline.length, 51)
  assert.equal(new Set(highlighted.data.timeline.map(item => item.id)).size, 51)

  reset()
  records = [{ ...record('linked-delete'), mealId: 'linked-meal', version: 1 }]
  meals = [{ ...meal('linked-meal', 'completed'), items: [{ id: 'dish-linked', name: '番茄炒蛋', recordId: 'linked-delete' }] }]
  const linkedDeletion = page()
  await linkedDeletion.onShow()
  linkedDeletion.askDelete({ currentTarget: { dataset: { key: 'record:linked-delete' } } })
  await linkedDeletion.confirmDelete()
  assert.equal(linkedDeletion.data.meals[0].items[0].recordId, '', 'confirmed cooking-record deletion unlinks the same in-memory meal without removing its dish')
  assert.equal(linkedDeletion.data.timeline[0].version, 1, 'a record deletion must not guess the related meal version and accidentally acknowledge unseen partner edits')

  reset()
  records = [{ ...record('linked-route'), mealId: 'completed-route', version: 1 }]
  meals = [meal('completed-route', 'completed'), meal('draft-route', 'draft'), meal('confirmed-route', 'confirmed')]
  const recentRoutes = page(), mealRoutes = page('meals')
  await recentRoutes.onShow(); await mealRoutes.onShow()
  recentRoutes.open({ currentTarget: { dataset: { id: 'completed-route', kind: 'meal' } } })
  mealRoutes.open({ currentTarget: { dataset: { id: 'completed-route', kind: 'meal' } } })
  recentRoutes.open({ currentTarget: { dataset: { id: 'linked-route', kind: 'record' } } })
  recentRoutes.open({ currentTarget: { dataset: { id: 'draft-route', kind: 'meal' } } })
  recentRoutes.open({ currentTarget: { dataset: { id: 'confirmed-route', kind: 'meal' } } })
  assert.deepEqual(routes.map(route => route.url), [
    '/pages/menu-preview/index?id=completed-route&from=recent', '/pages/menu-preview/index?id=completed-route&from=list',
    '/pages/menu-preview/index?id=completed-route&from=recent', '/pages/meal/index?id=draft-route', '/pages/meal/index?id=confirmed-route',
  ], 'recent records belonging to a completed meal share its Menu detail; active plans retain their original route')
  const cookingRoutes = page('cooking'); await cookingRoutes.onShow()
  await cookingRoutes.open({ currentTarget: { dataset: { id: 'linked-route', kind: 'record' } } })
  assert.equal(routes.at(-1).url, '/pages/record-edit/index?id=linked-route', 'the explicit cooking list retains its single-dish editor')

  reset()
  records = [{ ...record('beyond-page'), mealId: 'older-parent', date: '2026-10-03' }, { ...record('independent-route'), date: '2026-10-03' }]
  meals = Array.from({ length: 50 }, (_, index) => meal(`newer-parent-${index}`, 'completed')).concat(meal('older-parent', 'completed'))
  const missingParent = page(); await missingParent.onShow(); calls.length = 0
  heldAction = 'getMeal'
  const openParent = missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  assert.equal(missingParent.data.openingKey, 'record:beyond-page')
  assert.equal(calls.filter(call => call.action === 'getMeal').length, 1, 'a parent beyond the first meal page is looked up once per opening')
  heldAction = ''; releaseRequest(); await openParent
  assert.equal(routes.at(-1).url, '/pages/menu-preview/index?id=older-parent&from=recent')
  assert.equal(missingParent.data.openingKey, '')
  await missingParent.open({ currentTarget: { dataset: { id: 'independent-route', kind: 'record' } } })
  assert.equal(routes.at(-1).url, '/pages/record-edit/index?id=independent-route', 'independent cooking records keep their editor')
  meals[50].deletedAt = '2026-10-03'
  await missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  assert.equal(routes.at(-1).url, '/pages/record-edit/index?id=beyond-page', 'deleting the parent meal does not make its preserved single-dish record inaccessible')
  failure = 'getMeal'; const routeCount = routes.length
  await missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  assert.equal(routes.length, routeCount, 'an uncertain parent lookup reports its error instead of sending the user to the wrong page')
  assert.equal(missingParent.data.openingKey, '')
  assert.equal(toasts.at(-1), '记录暂时未能加载')
  failure = ''; delete meals[50].deletedAt; heldAction = 'getMeal'
  const refreshingLookup = missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  await missingParent.refresh()
  assert.equal(missingParent.data.openingKey, '', 'refresh clears the superseded parent lookup lock')
  heldAction = ''; releaseRequest(); await refreshingLookup
  assert.equal(routes.length, routeCount, 'the superseded lookup cannot navigate after refresh')
  heldAction = 'getMeal'
  const leavingLookup = missingParent.open({ currentTarget: { dataset: { id: 'beyond-page', kind: 'record' } } })
  missingParent.onHide(); heldAction = ''; releaseRequest(); await leavingLookup
  assert.equal(routes.length, routeCount, 'a late parent response cannot navigate after leaving the recent list')

  reset()
  records = ['linked-batch', 'failed-batch', 'plain-batch'].map(id => ({ ...record(id), version: 1 }))
  records[0].mealId = 'meal-batch'
  meals = [{ ...meal('meal-batch', 'completed'), items: [{ id: 'batch-dish', name: '番茄炒蛋', recordId: 'linked-batch' }] }]
  const batch = page(), afterCooking = page('cooking'), afterMeals = page('meals')
  await batch.onShow(); await afterCooking.onShow(); await afterMeals.onShow()
  batch.toggleEditing(); assert.equal(batch.data.editing, true)
  batch.selectAll(); assert.equal(batch.data.selectedKeys.length, 4)
  batch.selectAll(); assert.equal(batch.data.selectedKeys.length, 0)
  batch.open({ currentTarget: { dataset: { id: 'linked-batch', kind: 'record' } } })
  assert.deepEqual(batch.data.selectedKeys, ['record:linked-batch'])
  assert.equal(routes.length, 0, 'editing a recent row selects it instead of opening a detail')
  batch.selectAll(); batch.askBatchDelete(); calls.length = 0; batch.closeDelete()
  assert.equal(calls.length, 0, 'cancelling the bulk confirmation never writes')
  batch.askBatchDelete(); deleteFailures.add('record:failed-batch')
  await Promise.all([batch.confirmDelete(), batch.confirmDelete()])
  assert.deepEqual(calls.filter(call => call.action === 'deleteRecord').map(call => call.payload.kind), ['meal', 'record', 'record', 'record'],
    'bulk deletion starts with meals, avoids internal linked-record version conflicts and ignores repeated confirmation taps')
  assert.deepEqual(batch.data.timeline.map(item => item.key), ['record:failed-batch'])
  assert.deepEqual(batch.data.selectedKeys, ['record:failed-batch'])
  assert.equal(batch.data.deleteTarget.items.length, 1, 'retry contains only the failed selection')
  assert.match(batch.data.deleteError, /已删除 3 条.*剩余 1 条/)
  assert.equal(toasts.length, 0, 'partial success is not reported as complete success')
  deleteFailures.clear(); calls.length = 0
  await batch.confirmDelete()
  assert.deepEqual(calls.map(call => call.payload.id), ['failed-batch'])
  assert.equal(batch.data.timeline.length, 0)
  assert.equal(batch.data.selectedKeys.length, 0)
  assert.equal(toasts.at(-1), '已删除 1 条记录')
  batch.toggleEditing(); assert.equal(batch.data.editing, false, 'an empty list can still exit editing')
  await afterCooking.onShow(); await afterMeals.onShow()
  assert.equal(afterCooking.data.timeline.length + afterMeals.data.timeline.length, 0, 'bulk deletion remains synchronized when entering related lists again')

  reset()
  records = Array.from({ length: 15 }, (_, index) => ({ ...record(`scope-${index}`), version: 1 }))
  const scope = page(); await scope.onShow(); scope.toggleEditing(); scope.selectAll()
  assert.equal(scope.data.selectedKeys.length, 12, 'select all covers the 12 visible recent rows, not all 50 fetched or the whole kitchen')
  scope.askBatchDelete(); await scope.confirmDelete()
  assert.equal(records.length, 3, 'records outside the displayed selection remain untouched')
  assert.ok(calls.filter(call => call.action.startsWith('delete')).every(call => call.action === 'deleteRecord'), 'bulk editing never deletes a recipe or wish')

  reset()
  records = ['lost-batch', 'conflict-batch'].map(id => ({ ...record(id), version: 1 }))
  const uncertain = page(); await uncertain.onShow(); uncertain.toggleEditing()
  uncertain.selectRecord({ currentTarget: { dataset: { key: 'record:lost-batch' } } }); uncertain.askBatchDelete()
  deleteLostResponses.add('record:lost-batch')
  await uncertain.confirmDelete()
  assert.equal(uncertain.data.timeline.length, 2, 'lost response keeps the apparently deleted row until the server confirms a retry')
  assert.equal(toasts.length, 0)
  await uncertain.confirmDelete()
  assert.deepEqual(uncertain.data.timeline.map(item => item.id), ['conflict-batch'])
  uncertain.selectAll(); uncertain.askBatchDelete(); records[0].version = 2; records[0].name = '伙伴修改后的菜名'
  await uncertain.confirmDelete()
  assert.equal(uncertain.data.deleteTarget, null, 'version conflict closes confirmation for fresh review')
  assert.equal(uncertain.data.timeline[0].name, '伙伴修改后的菜名')
  assert.deepEqual(uncertain.data.selectedKeys, ['record:conflict-batch'])
  uncertain.askBatchDelete(); await uncertain.confirmDelete()
  assert.equal(records.length, 0, 'the refreshed conflict can be confirmed again')
  uncertain.onHide(); assert.equal(uncertain.data.editing, false)

  reset()
  records = ['shared-recipe-1', 'shared-recipe-2', 'shared-recipe-3'].map(id => ({ ...record(id), version: 1 }))
  const serialized = page(); await serialized.onShow(); serialized.toggleEditing(); serialized.selectAll(); serialized.askBatchDelete()
  calls.length = 0; heldAction = 'deleteRecord'
  const sharingDelete = serialized.confirmDelete()
  assert.equal(calls.filter(call => call.action === 'deleteRecord').length, 1, 'records sharing the same recipe counter wait for the preceding deletion transaction')
  await serialized.onPullDownRefresh()
  serialized.onHide(); await serialized.onShow()
  assert.equal(calls.length, 1, 'pull refresh and return do not start a competing list load during bulk deletion')
  heldAction = ''; releaseRequest(); await sharingDelete
  assert.equal(calls.filter(call => call.action === 'deleteRecord').length, 3)
  assert.equal(serialized.data.timeline.length, 0, 'returning during a bulk delete refreshes after all results are known')
  assert.equal(serialized.data.deleting, false)
  assert.equal(serialized.data.deleteTarget, null)
  console.log('记录首页、分类、状态、照片、空列表、加载失败与新增导航自检通过')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
