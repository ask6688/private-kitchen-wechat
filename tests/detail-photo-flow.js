const assert = require('node:assert/strict')

// Run the real detail pages against an in-memory API; no shared kitchen writes.
const calls = [], previews = [], toasts = []
const app = { globalData: { configError: '', spaceName: '照片测试厨房' } }
let definition, failMedia = false, failRecords = false, failRecordOffset = null, generation = 1, mealRecords
let recipe = { _id: 'recipe00001', name: '越南粉', coverFileId: 'cloud://cover', ingredients: '', steps: '' }
const record = { _id: 'record00001', recipeId: 'recipe00001', mealId: 'meal00001', mealItemId: 'item00001',
  date: '2026-09-30', photoFileIds: [{ fileID: 'cloud://cooked' }], note: '这一次的心得' }
const meal = { _id: 'meal00001', version: 1, status: 'confirmed', title: '这一顿', date: '2026-09-30',
  spaceId: 'space00001', diners: 2, note: '饭单原备注', photoFileIds: ['cloud://meal', { fileId: 'cloud://other' }],
  items: [{ id: 'item00001', recipeId: 'recipe00001', recordId: 'record00001', name: '越南粉', state: 'cooked' }] }
const url = id => `https://example.test/${id.slice(8)}?v=${generation}`
const ok = data => ({ result: { ok: true, data } })
global.getApp = () => app
global.Page = value => { definition = value }
global.wx = {
  setNavigationBarTitle() {}, getStorageSync() {}, removeStorageSync() {},
  showToast: value => toasts.push(value.title),
  previewImage: value => previews.push(value),
  cloud: { callFunction: async ({ data }) => {
    calls.push(data)
    if (data.action === 'bootstrap') return ok({ space: { _id: 'space00001' }, member: { _id: 'member00001' } })
    if (data.action === 'getRecipe') return ok(recipe)
    if (data.action === 'getMeal') return ok(meal)
    if (data.action === 'listRecords') {
      if (failRecords || data.payload.offset === failRecordOffset) throw new Error('记录加载失败')
      return ok(data.payload.mealId && mealRecords ? mealRecords.slice(data.payload.offset || 0, (data.payload.offset || 0) + 50) : [record])
    }
    if (data.action === 'mediaUrls') {
      if (failMedia) throw new Error('图片地址暂时不可用')
      return ok({ urls: Object.fromEntries(data.payload.fileIds.map(id => [id, url(id)])) })
    }
    throw new Error(`unexpected write or request: ${data.action}`)
  } },
}

function page(name) {
  const file = `../miniprogram/pages/${name}/index`
  delete require.cache[require.resolve(file)]
  require(file)
  return { ...definition, data: structuredClone(definition.data), setData(fields, callback) {
    for (const [key, value] of Object.entries(fields)) {
      const parts = key.split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) target = target[part]
      target[parts.at(-1)] = value
    }
    if (callback) callback()
  } }
}
const event = dataset => ({ currentTarget: { dataset } })

async function main() {
  const dish = page('recipe')
  dish.onLoad({ id: recipe._id })
  failMedia = true
  await dish.load()
  assert.equal(dish.data.loading, false)
  assert.equal(dish.data.error, '')
  assert.equal(dish.data.recipe.coverError, true, 'failed URL lookup must not look like an unphotographed dish')
  assert.equal(dish.data.records[0].photoError, true)
  assert.equal(dish.data.records[0].photoFileId, 'cloud://cooked', 'legacy fileID objects keep their identity')
  failMedia = false
  await dish.retryPhotos()
  assert.equal(dish.data.recipe.coverError, false)
  assert.equal(dish.data.recipe.coverUrl, url('cloud://cover'), 'cover remains the recipe cover, not its latest cooking photo')
  assert.equal(dish.data.records[0].photoUrl, url('cloud://cooked'))
  assert.equal(dish.data.recipe.coverReady, false, 'a resolved URL still waits for native image loading')
  dish.coverLoaded(event({ url: dish.data.recipe.coverUrl }))
  assert.equal(dish.data.recipe.coverReady, true)
  await dish.retryPhotos()
  assert.equal(dish.data.recipe.coverReady, true, 'refreshing the same ready cover URL must not show permanent loading')
  const oldUrl = dish.data.recipe.coverUrl
  dish.imageError(event({ url: oldUrl }))
  assert.equal(dish.data.recipe.coverError, true, 'native image error exposes a retry entry')
  await dish.retryPhotos()
  assert.equal(dish.data.recipe.coverReady, false, 'a failed cover remounts and waits for native load even when the URL is unchanged')
  dish.coverLoaded(event({ url: oldUrl }))
  assert.equal(dish.data.recipe.coverReady, true)
  generation++
  await dish.retryPhotos()
  dish.imageError(event({ url: oldUrl }))
  assert.equal(dish.data.recipe.coverError, false, 'a stale failed URL cannot replace the retried image')
  dish.preview()
  assert.deepEqual(previews.at(-1).urls, [url('cloud://cover')])
  dish.imageError(event({ id: record._id, url: dish.data.records[0].photoUrl }))
  assert.equal(dish.data.records[0].photoError, true)
  await dish.retryPhotos()
  assert.equal(dish.data.records[0].photoError, false)
  recipe = { ...recipe, coverFileId: '' }
  await dish.load()
  assert.equal(dish.data.recipe.coverError, false, 'a genuinely absent cover is not a loading failure')
  recipe = { ...recipe, coverFileId: 'cloud://cover' }

  const dinner = page('meal')
  dinner.onLoad({ id: meal._id })
  await dinner.load()
  assert.equal(dinner.data.status, 'confirmed')
  assert.deepEqual(dinner.data.photos.map(photo => photo.fileId), ['cloud://meal', 'cloud://other'],
    'the meal album contains only its own saved photos; dish cooking photos remain separate')
  assert.equal(dinner.data.meal.items[0].photoUrl, url('cloud://cooked'))
  assert.equal(dinner.data.photos[0].state, 'loading')
  dinner.photoLoaded(event({ key: 'cloud://meal', url: url('cloud://meal') }))
  await dinner.retryImages()
  assert.equal(dinner.data.photos[0].state, 'ready', 'same ready gallery URL keeps its native-loaded state')
  dinner.photoFailed(event({ key: 'cloud://meal', url: url('cloud://meal') }))
  await dinner.retryImages()
  assert.equal(dinner.data.photos[0].state, 'loading', 'failed gallery images remount and show loading until bindload')
  dinner.photoLoaded(event({ key: 'cloud://meal', url: url('cloud://meal') }))
  assert.equal(dinner.data.photos[0].state, 'ready')
  await dinner.previewPhoto(event({ key: 'cloud://other' }))
  assert.equal(previews.at(-1).current, url('cloud://other'))
  assert.equal(previews.at(-1).urls.length, 2)
  dinner.photoFailed(event({ key: 'cloud://other', url: url('cloud://other') }))
  assert.equal(dinner.data.photos[1].state, 'error')
  dinner.onTitle({ detail: { value: '还没保存的饭名' } })
  dinner.onNote({ detail: { value: '还没保存的备注' } })
  failMedia = true
  const previewsBeforeFailure = previews.length
  await dinner.previewPhoto(event({ key: 'cloud://meal' }))
  assert.equal(previews.length, previewsBeforeFailure, 'an unresolved album is not sent to previewImage as an empty or partial album')
  assert.equal(dinner.data.photos.length, 2, 'loading failure retains existing meal photo references')
  assert.equal(dinner.data.photos.every(photo => photo.state === 'error'), true)
  failMedia = false
  await dinner.retryImages()
  assert.equal(dinner.data.title, '还没保存的饭名')
  assert.equal(dinner.data.note, '还没保存的备注', 'retrying media must not reload or overwrite the meal form')
  assert.equal(dinner.data.photos.some(photo => photo.state === 'error'), false)
  assert.equal(dinner.data.meal.items[0].coverError, false)
  failRecords = true
  await dinner.retryPhotos()
  assert.equal(dinner.data.meal.recordPhotosError, true, 'a failed record lookup must stay retryable')
  assert.deepEqual(dinner.data.meal.items[0].photoFileIds, ['cloud://cooked'], 'a failed lookup retains known per-dish photo references')
  assert.equal(dinner.data.meal.items[0].recordId, 'record00001')
  failRecords = false
  await dinner.retryPhotos()
  assert.equal(dinner.data.meal.recordPhotosError, false)
  dinner.applyMeal({ ...dinner.data.meal, version: 2, status: 'draft', items: meal.items })
  assert.equal(dinner.data.photos.length, 2, 'changing meal state retains its rendered album')
  assert.equal(dinner.data.meal.items[0].coverUrl, url('cloud://cover'))
  mealRecords = [record, ...Array.from({ length: 50 }, (_, index) => ({ ...record, _id: `record${index + 2}`,
    photoFileIds: index === 49 ? ['cloud://last-page-photo'] : [] }))]
  await dinner.retryPhotos()
  assert.equal(dinner.data.photos.some(photo => photo.fileId === 'cloud://last-page-photo'), false,
    'a dish photo from a later page never becomes a meal album photo')
  assert.ok(calls.some(call => call.action === 'listRecords' && call.payload.offset === 50))
  failRecordOffset = 50
  await dinner.retryPhotos()
  assert.equal(dinner.data.meal.recordPhotosError, true)
  assert.deepEqual(dinner.data.photos.map(photo => photo.fileId), ['cloud://meal', 'cloud://other'],
    'a later-page record failure does not alter the independent meal album')
  failRecordOffset = null
  mealRecords = []
  await dinner.retryPhotos()
  assert.equal(dinner.data.meal.recordPhotosError, false)
  assert.deepEqual(dinner.data.photos.map(photo => photo.fileId), ['cloud://meal', 'cloud://other'],
    'retrying dish records does not change the meal album')
  assert.deepEqual(dinner.data.meal.items[0].photoFileIds, [])
  assert.equal(calls.some(call => /^(save|add|discard|upload|remove)/.test(call.action)), false)
  console.log('菜品封面与饭单相册：旧照片字段、失败占位、局部重试、整组预览和未保存表单保留检查通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
