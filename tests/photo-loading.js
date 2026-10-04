const assert = require('node:assert/strict')

const calls = []
const previews = []
const drafts = new Map()
const clone = value => value == null ? value : structuredClone(value)
const success = data => ({ result: { ok: true, data } })
let mediaReply = async ids => success({ urls: Object.fromEntries(ids.map(id => [id, `https://photo.test/${id}`])) })
let pageDefinition
let record = null

global.getApp = () => ({ globalData: { configError: '', spaceName: '照片测试厨房' } })
global.getCurrentPages = () => []
global.Page = definition => { pageDefinition = definition }
global.wx = {
  setNavigationBarTitle() {}, showToast() {}, showLoading() {}, hideLoading() {},
  previewImage: options => previews.push(clone(options)),
  getStorageSync: key => clone(drafts.get(key)),
  setStorageSync: (key, value) => drafts.set(key, clone(value)),
  removeStorageSync: key => drafts.delete(key),
  cloud: { callFunction: async ({ data }) => {
    calls.push(clone(data))
    if (data.action === 'mediaUrls') return mediaReply(data.payload.fileIds)
    if (data.action === 'getRecord') return success(record)
    if (data.action === 'listRecipes') return success([{ id: 'recipe00001', name: '番茄炒蛋', coverFileId: 'cloud://recipe-cover' }])
    if (data.action === 'listWishes') return success([])
    if (data.action === 'bootstrap') return success({ space: { id: 'space00001', name: '照片测试厨房' } })
    throw new Error(`unexpected action: ${data.action}`)
  } },
}

const { mediaUrls } = require('../miniprogram/utils/api')

async function main() {
  const ids = Array.from({ length: 35 }, (_, index) => `cloud://photo-${index}`)
  mediaReply = async files => {
    if (files.includes(ids[32])) throw new Error('这批临时链接网络失败')
    return success({ urls: Object.fromEntries(files.map(id => [id, `https://photo.test/${id}`])) })
  }
  const partial = await mediaUrls(ids)
  assert.equal(Object.keys(partial).length, 30, 'a failed batch must preserve successful batches')
  assert.ok(partial[ids[0]])

  calls.length = 0
  const good = 'cloud://photo-good'
  const bad = 'cloud://photo-invalid'
  mediaReply = async files => files.includes(bad)
    ? { result: { ok: false, error: { code: 'INVALID_MEDIA', message: '照片不可用' } } }
    : success({ urls: Object.fromEntries(files.map(id => [id, `https://photo.test/${id}`])) })
  const isolated = await mediaUrls([good, bad])
  assert.deepEqual(Object.keys(isolated), [good], 'one invalid ID cannot hide another valid photo')
  assert.ok(calls.some(call => call.payload.fileIds.length === 1 && call.payload.fileIds[0] === good), 'retry the rejected batch by individual file')

  mediaReply = async () => { throw new Error('网络已断开') }
  await assert.rejects(() => mediaUrls([good, 'cloud://photo-second']), /网络已断开/)

  mediaReply = async () => success({ urls: {} })
  assert.deepEqual(await mediaUrls([good]), {}, 'missing URLs never fall back to a recipe cover')
  await checkPhotoItems(good)
  await checkDetailRetry(good)
  console.log('photo loading passed: partial batches, invalid-ID isolation, network failure, draft cloud refs and detail retry')
}

async function checkPhotoItems(good) {
  const { photoRefs, photoItems, resolvePhotos } = require('../miniprogram/utils/photos')
  const input = [good, { fileID: 'cloud://old-fileID', localPath: 'wxfile://expired-cloud-copy' }, { localPath: 'wxfile://unsaved' }]
  const photos = photoItems(input)
  assert.deepEqual(photoRefs(input), [good, 'cloud://old-fileID'])
  assert.equal(photos[0].fileId, good)
  assert.equal(photos[1].fileId, 'cloud://old-fileID')
  assert.equal(photos[1].localPath, '', 'a durable cloud ID takes precedence over an expired temporary path')
  assert.equal(photos[2].localPath, 'wxfile://unsaved')
  assert.equal(photos[0].state, 'loading')
  assert.ok(photos.every(photo => photo.key))
  mediaReply = async files => success({ urls: { [good]: 'https://photo.test/fresh' } })
  const loaded = await resolvePhotos(photos)
  assert.equal(loaded[0].url, 'https://photo.test/fresh')
  assert.equal(loaded[0].state, 'loading', 'a URL is not proof that the image has rendered')
  assert.equal(loaded[1].state, 'error', 'a missing URL keeps an explicit retryable item')
  assert.equal(loaded[2].url, 'wxfile://unsaved', 'unsaved local images remain available')
  const stillReady = await resolvePhotos([{ ...loaded[0], state: 'ready' }])
  assert.equal(stillReady[0].state, 'ready', 'refreshing an unchanged URL cannot wait forever for a second native load event')
  mediaReply = async () => { throw new Error('网络已断开') }
  const failed = await resolvePhotos(photoItems([good]))
  assert.equal(failed[0].state, 'error')
  assert.equal(failed[0].fileId, good, 'display failure never removes the persisted photo reference')
}

async function checkDetailRetry(good) {
  record = { id: 'record00001', version: 1, recipeId: 'recipe00001', wishId: '', mealId: '',
    name: '番茄炒蛋', date: '2026-09-30', note: '这次少放盐', photoFileIds: [good] }
  mediaReply = async files => success({ urls: Object.fromEntries(files.map(id => [id, `https://photo.test/${id}`])) })
  assert.ok((await mediaUrls(record.photoFileIds))[good], 'the same record first has a usable list URL')
  mediaReply = async () => { throw new Error('详情临时链接网络失败') }
  require('../miniprogram/pages/record-edit/index')
  const renders = []
  const detail = { ...pageDefinition, data: clone(pageDefinition.data), setData(fields, callback) {
    Object.assign(this.data, fields)
    if (fields.photos) renders.push(clone(fields.photos))
    if (callback) callback()
  } }
  await detail.onLoad({ id: record.id })
  assert.equal(detail.data.error, '', 'photo failure must not hide the loaded record content')
  assert.equal(detail.data.photos.length, 1)
  assert.equal(detail.data.photos[0].state, 'error')
  assert.equal(detail.data.photos[0].fileId, good)
  assert.equal(detail.data.note, record.note)
  mediaReply = async files => success({ urls: Object.fromEntries(files.map(id => [id, `https://photo.test/retry/${id}`])) })
  await detail.retryImages()
  assert.equal(detail.data.photos[0].url, `https://photo.test/retry/${good}`)
  assert.equal(detail.data.photos[0].state, 'loading')
  assert.equal(detail.data.photos[0].fileId, good)
  assert.equal(detail.data.note, record.note, 'retry changes image state, not record content')

  const imageEvent = { currentTarget: { dataset: { key: good, url: detail.data.photos[0].url } } }
  detail.photoLoaded(imageEvent)
  assert.equal(detail.data.photos[0].state, 'ready')
  await detail.retryImages()
  assert.equal(detail.data.photos[0].state, 'ready', 'same-URL retry preserves a rendered image')
  await detail.previewPhoto(imageEvent)
  assert.equal(previews.length, 1)
  assert.deepEqual(previews[0].urls, [imageEvent.currentTarget.dataset.url])
  assert.equal(previews[0].current, imageEvent.currentTarget.dataset.url)
  assert.equal(detail.data.photos[0].state, 'ready', 'preview refresh does not turn an already rendered photo into permanent loading')
  detail.photoFailed(imageEvent)
  assert.equal(detail.data.photos[0].state, 'error', 'native image download failure is visible even after URL lookup succeeds')
  const errorRender = clone(detail.data.photos[0])
  renders.length = 0
  await detail.retryImages()
  assert.equal(detail.data.photos[0].state, 'loading')
  assert.ok(renders.some(photos => !photos[0].url || photos[0].renderKey !== errorRender.renderKey), 'retrying a failed image at the same URL remounts it to trigger native loading')
  detail.photoLoaded(imageEvent)
  assert.equal(detail.data.photos[0].state, 'ready')
  mediaReply = async () => success({ urls: {} })
  await detail.previewPhoto(imageEvent)
  assert.equal(previews.length, 1, 'an unavailable photo must not launch an empty preview group')
  mediaReply = async files => success({ urls: Object.fromEntries(files.map(id => [id, `https://photo.test/retry/${id}`])) })

  drafts.set(detail.draftKey, { id: record.id, version: record.version, recipeId: record.recipeId, wishId: '',
    note: '本机未保存心得', photos: [{ fileId: good, localPath: 'wxfile://expired-cloud-copy' }] })
  await detail.load()
  assert.equal(detail.data.photos[0].localPath, '', 'old drafts cannot prefer an expired temp path over the saved cloud reference')
  assert.equal(detail.data.photos[0].url, `https://photo.test/retry/${good}`)
  assert.equal(detail.data.note, '本机未保存心得')

  drafts.set(detail.draftKey, { id: record.id, version: record.version, recipeId: record.recipeId, wishId: '',
    note: '保留未保存心得', photos: [] })
  await detail.load()
  assert.equal(detail.data.photos.length, 0, 'same-version intentional removal remains an unsaved draft')
  assert.equal(detail.data.canRestorePhotos, true, 'explain why the saved list still has photos and offer restore')
  await detail.restoreSavedPhotos()
  assert.equal(detail.data.photos[0].fileId, good)
  assert.equal(detail.data.note, '保留未保存心得')
  assert.equal(detail.data.canRestorePhotos, false)

  record.photoFileIds = [good, 'cloud://middle', 'cloud://last']
  drafts.set(detail.draftKey, { id: record.id, version: record.version, recipeId: record.recipeId, wishId: '',
    photos: [{ fileId: good }, { fileId: 'cloud://last' }, { localPath: 'wxfile://new-photo' }] })
  await detail.load()
  await detail.restoreSavedPhotos()
  assert.deepEqual(detail.data.photos.map(photo => photo.fileId || photo.localPath), [...record.photoFileIds, 'wxfile://new-photo'], 'restore keeps the saved album order and appends unsaved additions')
  record.photoFileIds = [good]

  record.version = 3
  drafts.set(detail.draftKey, { id: record.id, version: 2, recipeId: record.recipeId, wishId: '',
    note: '伙伴保存前的本机心得', photos: [] })
  await detail.load()
  assert.equal(detail.data.photos.length, 1, 'a stale empty-photo draft must not hide saved cloud photos')
  assert.equal(detail.data.photos[0].fileId, good)
  assert.equal(detail.data.photos[0].url, `https://photo.test/retry/${good}`)
  assert.equal(detail.data.version, 2, 'preserve the old draft version so normal save conflict protection still applies')
  assert.equal(detail.data.note, '伙伴保存前的本机心得')
  assert.ok(detail.data.photoDraftNotice)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
