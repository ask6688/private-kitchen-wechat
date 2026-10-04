const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { runInNewContext } = require('node:vm')
const { photoItems } = require('../miniprogram/utils/photos')
const files = new Map(), receipts = new Map()
const calls = [], puts = [], nativeCalls = [], canvasCalls = [], reads = [], copies = [], logs = []
let chosen, nativeSizes, canvasSizes, nativeFail, nativeUnchanged, nativeIgnoreDimensions, canvasScale, canvasFail, failFinish, putFailure, serial = 0
const targetBytes = 512 * 1024, maxBytes = 1024 * 1024
const originalLog = console.log, originalWarn = console.warn, originalInfo = console.info
console.log = console.warn = console.info = (...args) => logs.push(args)
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)

function file(filePath, size, width = 640, height = 480, type = 'jpeg') {
  const bytes = Buffer.alloc(size, ++serial % 256)
  const value = { size, width, height, type, data: arrayBuffer(bytes), digest: createHash('md5').update(bytes).digest('hex') }
  files.set(filePath, value)
  return value
}
function lookup(filePath, success, fail) {
  const value = files.get(filePath)
  if (value) success(value)
  else fail(new Error(`missing file: ${filePath}`))
}
function reset() {
  files.clear(); receipts.clear()
  calls.length = puts.length = nativeCalls.length = canvasCalls.length = reads.length = copies.length = 0
  nativeSizes = [120 * 1024]
  canvasSizes = [120 * 1024]
  nativeFail = nativeUnchanged = nativeIgnoreDimensions = canvasFail = failFinish = false
  canvasScale = 1
  putFailure = null
  chosen = '/tmp/photo.jpg'
}
function loadUpload() {
  delete require.cache[require.resolve('../miniprogram/utils/upload')]
  return require('../miniprogram/utils/upload')
}
function checkTransport(expected, requestId) {
  assert.deepEqual(calls.map(call => call.action), ['beginMediaUpload', 'finishMediaUpload'])
  assert.deepEqual(calls[0].payload, { requestId, size: expected.data.byteLength, md5: expected.digest })
  assert.deepEqual(calls[1].payload, { requestId })
  assert.equal(puts.length, 1, 'one photo uses one binary transfer, not sequential chunks')
  assert.equal(puts[0].method, 'PUT')
  assert.equal(puts[0].dataType, 'text')
  assert.ok(puts[0].data instanceof ArrayBuffer)
  assert.deepEqual(Buffer.from(puts[0].data), Buffer.from(expected.data), 'PUT retains all prepared bytes')
  assert.ok(calls.every(call => Buffer.byteLength(JSON.stringify(call)) < 1024), 'only metadata enters cloud calls')
}
global.getApp = () => ({ globalData: {} })
global.wx = {
  env: { USER_DATA_PATH: '/user' },
  chooseMedia: ({ success }) => success({ tempFiles: [{ tempFilePath: chosen }] }),
  getFileInfo: ({ filePath, success, fail }) => lookup(filePath, success, fail),
  getImageInfo: ({ src, success, fail }) => lookup(src, success, fail),
  compressImage: options => {
    nativeCalls.push(options)
    if (nativeFail) return options.fail(new Error('native compression unavailable'))
    if (nativeUnchanged) return options.success({ tempFilePath: options.src })
    const tempFilePath = `/tmp/native-${serial}.jpg`
    const source = files.get(options.src)
    assert.ok(options.compressedWidth > 0 && options.compressedHeight > 0, 'native compression receives both dimensions')
    file(tempFilePath, nativeSizes.shift() ?? maxBytes + 1,
      nativeIgnoreDimensions ? source.width : options.compressedWidth,
      nativeIgnoreDimensions ? source.height : options.compressedHeight)
    options.success({ tempFilePath })
  },
  createOffscreenCanvas: options => {
    const canvas = { ...options, getContext: () => ({ fillRect() {}, drawImage() {} }),
      createImage: () => ({ set src(value) { this.width = files.get(value).width; this.height = files.get(value).height; queueMicrotask(() => this.onload()) } }) }
    return canvas
  },
  canvasToTempFilePath: options => {
    canvasCalls.push(options)
    if (canvasFail) return options.fail(new Error('canvas conversion unavailable'))
    const tempFilePath = `/tmp/canvas-${serial}.jpg`
    file(tempFilePath, canvasSizes.shift() ?? maxBytes + 1,
      (options.destWidth || options.width || options.canvas.width) * canvasScale,
      (options.destHeight || options.height || options.canvas.height) * canvasScale)
    options.success({ tempFilePath })
  },
  getFileSystemManager: () => ({
    readFile: ({ filePath, encoding, success, fail }) => {
      assert.equal(encoding, undefined, 'upload reads binary bytes without Base64 conversion')
      reads.push(filePath); lookup(filePath, value => success({ data: value.data }), fail)
    },
    copyFile: ({ srcPath, destPath, success, fail }) => lookup(srcPath, value => {
      copies.push({ srcPath, destPath }); files.set(destPath, { ...value }); success({})
    }, fail),
    saveFile: ({ tempFilePath, success, fail }) => lookup(tempFilePath, value => {
      const savedFilePath = `/saved/photo-${++serial}.jpg`
      files.set(savedFilePath, { ...value }); success({ savedFilePath })
    }, fail),
  }),
  request: options => {
    const { success, fail, ...sent } = options
    puts.push(structuredClone(sent))
    if (typeof putFailure === 'string') fail({ errMsg: putFailure })
    else success({ statusCode: putFailure || 200, data: putFailure ? '<Error>AccessDenied</Error>' : '' })
  },
  cloud: { callFunction: async ({ data }) => {
    calls.push(structuredClone(data))
    const { action, payload } = data
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 1024, 'image bytes never enter cloud call data')
    if (action === 'beginMediaUpload') return { result: { ok: true, data: receipts.has(payload.requestId)
      ? { fileId: receipts.get(payload.requestId) }
      : { url: 'https://upload.example.test/private-stage', headers: { authorization: 'test-only' } } } }
    assert.equal(action, 'finishMediaUpload')
    receipts.set(payload.requestId, 'cloud://saved-photo')
    if (failFinish) throw new Error('upload response lost')
    return { result: { ok: true, data: { fileId: 'cloud://saved-photo' } } }
  } },
}

async function main() {
  let upload = loadUpload()
  reset()
  const small = file(chosen, 400, 640, 480)
  const selected = await upload.chooseImage()
  assert.equal(selected.tempFilePath, chosen, 'an already small image keeps its original bytes')
  assert.equal(nativeCalls.length + canvasCalls.length, 0)
  await upload.uploadImage(selected.tempFilePath, 'small-receipt')
  checkTransport(small, 'small-receipt')
  assert.deepEqual(puts[0].header, { authorization: 'test-only' }, 'server-signed headers are passed unchanged')
  const persisted = await upload.chooseImage({ persist: true })
  assert.ok(persisted.tempFilePath.startsWith('/saved/'))
  assert.deepEqual(files.get(persisted.tempFilePath).data, small.data)

  reset()
  const crossRealm = file(chosen, 400)
  crossRealm.data = runInNewContext('Uint8Array.from(bytes).buffer', { bytes: [...new Uint8Array(crossRealm.data)] })
  assert.equal(crossRealm.data instanceof ArrayBuffer, false, 'WeChat may return a buffer from another JS realm')
  assert.equal(Object.prototype.toString.call(crossRealm.data), '[object ArrayBuffer]')
  assert.equal((await upload.uploadImage(chosen, 'cross-realm-receipt')).fileId, 'cloud://saved-photo')
  checkTransport(crossRealm, 'cross-realm-receipt')

  reset()
  file(chosen, 3 * 1024 * 1024, 3024, 4032)
  nativeSizes = [targetBytes + 1000, targetBytes + 1, targetBytes]
  const portrait = await upload.chooseImage()
  assert.deepEqual(nativeCalls.map(({ compressedWidth, compressedHeight, quality }) => [compressedWidth, compressedHeight, quality]),
    [[1200, 1600, 78], [960, 1280, 70], [720, 960, 62]], 'each pass supplies both portrait dimensions and reduces quality')
  assert.equal(files.get(portrait.tempFilePath).width, 720, 'native compression preserves the portrait aspect ratio')
  assert.equal(files.get(portrait.tempFilePath).size, targetBytes, 'actual output bytes determine when compression stops')
  assert.equal((await upload.uploadImage(portrait.tempFilePath, 'portrait-receipt')).fileId, 'cloud://saved-photo')
  checkTransport(files.get(portrait.tempFilePath), 'portrait-receipt')

  reset()
  file(chosen, 1000, 2000, 500)
  await upload.chooseImage()
  assert.equal(nativeCalls.length, 1, 'small bytes still normalize excessive dimensions')
  assert.equal(nativeCalls[0].compressedWidth, 1600)

  reset()
  const normalPhoto = file(chosen, 300 * 1024, 1280, 1707)
  assert.equal((await upload.chooseImage()).tempFilePath, chosen, 'a normal phone photo above the old 180 KiB cap is already usable')
  assert.equal(nativeCalls.length + canvasCalls.length, 0)
  await upload.uploadImage(chosen, 'normal-phone-receipt')
  checkTransport(normalPhoto, 'normal-phone-receipt')

  reset()
  file(chosen, 3 * 1024 * 1024, 3024, 4032)
  nativeSizes = [800 * 1024, 700 * 1024, 600 * 1024]
  canvasSizes = [700 * 1024, 650 * 1024, 600 * 1024]
  await upload.uploadImage(chosen, 'soft-budget-receipt')
  assert.ok(puts[0].data.byteLength > targetBytes && puts[0].data.byteLength <= maxBytes,
    'missing the soft compression target does not reject a photo within the server limit')
  assert.ok(nativeCalls.length <= 3 && canvasCalls.length <= 3)

  reset()
  file(chosen, 3 * 1024 * 1024, 3024, 4032)
  nativeIgnoreDimensions = true
  nativeSizes = [400 * 1024, 350 * 1024, 300 * 1024]
  canvasFail = true
  await upload.uploadImage(chosen, 'ignored-dimensions-receipt')
  assert.ok(puts[0].data.byteLength <= maxBytes, 'native output dimensions are a soft target, not an upload barrier')
  assert.ok(reads.every(path => path !== chosen), 'an oversized original is never used as the safe fallback')

  reset()
  file(chosen, 3 * 1024 * 1024, 3024, 4032, 'png')
  nativeFail = true
  canvasScale = 2
  canvasSizes = [400 * 1024, 350 * 1024, 300 * 1024]
  await upload.uploadImage(chosen, 'canvas-dimensions-receipt')
  assert.ok(puts[0].data.byteLength <= maxBytes, 'safe canvas output remains usable when actual pixels differ from requested dimensions')

  reset()
  chosen = '/tmp/photo.png'
  file(chosen, 2 * 1024 * 1024, 2000, 1000, 'png')
  nativeFail = true
  const png = await upload.chooseImage()
  assert.equal(nativeCalls.length, 1, 'unavailable native conversion falls back to JPEG rendering')
  assert.equal(canvasCalls.length, 1)
  assert.equal(canvasCalls[0].fileType, 'jpg')
  assert.equal(files.get(png.tempFilePath).type, 'jpeg')
  failFinish = true
  await assert.rejects(upload.uploadImage(png.tempFilePath), /response lost/)
  assert.equal(reads.includes(chosen), false, 'the original PNG is never sent')
  const withoutReceipt = structuredClone(calls)
  const firstId = withoutReceipt[0].payload.requestId
  assert.match(firstId, /^[a-zA-Z0-9_-]{8,80}$/)
  assert.equal(puts.length, 1)
  failFinish = false
  assert.equal((await upload.uploadImage(png.tempFilePath)).fileId, 'cloud://saved-photo')
  assert.deepEqual(calls.slice(withoutReceipt.length), [withoutReceipt[0]], 'retry queries the original receipt and accepts completed upload')
  assert.equal(puts.length, 1, 'lost finish response never causes a second PUT when begin returns a receipt')
  await upload.uploadImage(png.tempFilePath)
  const selectedAgain = calls.slice(withoutReceipt.length + 1)
  assert.notEqual(selectedAgain[0].payload.requestId, firstId,
    'selecting the same image after success starts a new upload because the earlier file may have been discarded')
  assert.equal(puts.length, 2)

  for (const failure of [403, 413, 'request:fail url not in domain list', 'request:fail timeout']) {
    reset()
    const original = file(chosen, 400)
    putFailure = failure
    await assert.rejects(upload.uploadImage(chosen, 'rejected-put-receipt'), error => {
      assert.ok(error.message && error.message !== 'undefined', 'HTTP and transport failures have a visible error')
      return true
    })
    assert.deepEqual(calls.map(call => call.action), ['beginMediaUpload'], 'failed PUT never finalizes')
    assert.deepEqual(files.get(chosen).data, original.data, 'failure keeps the chosen file unchanged')
    putFailure = null
    await upload.uploadImage(chosen, 'rejected-put-receipt')
    assert.equal(calls[1].payload.requestId, calls[0].payload.requestId)
    assert.equal(calls.at(-1).action, 'finishMediaUpload')
    assert.equal(puts.length, 2)
  }

  reset()
  file(chosen, 2 * 1024 * 1024, 2000, 1000)
  nativeFail = true
  await upload.uploadImage(chosen, 'fallback-receipt')
  assert.ok(canvasCalls.length > 0, 'native compression failure uses canvas conversion')
  checkTransport(files.get(copies[0].destPath), 'fallback-receipt-p5')
  assert.equal(reads.includes(chosen), false, 'native failure never falls back to uploading raw bytes')

  reset()
  const unchangedOriginal = file(chosen, 2 * 1024 * 1024, 2000, 1000)
  nativeUnchanged = true
  await upload.uploadImage(chosen, 'unchanged-native-receipt')
  assert.ok(nativeCalls.length >= 1 && nativeCalls.length <= 3, 'ineffective native compression has a finite retry budget')
  assert.ok(canvasCalls.length >= 1 && canvasCalls.length <= 3, 'ineffective native compression falls back to Canvas')
  assert.equal(reads.includes(chosen), false, 'a successful native callback cannot upload the unchanged source')
  assert.notDeepEqual(puts[0].data, unchangedOriginal.data)
  checkTransport(files.get(copies[0].destPath), 'unchanged-native-receipt-p5')

  reset()
  const safeOriginal = file(chosen, 800 * 1024, 3024, 4032)
  nativeFail = canvasFail = true
  await upload.uploadImage(chosen, 'safe-original-receipt')
  checkTransport(safeOriginal, 'safe-original-receipt')
  assert.ok(nativeCalls.length <= 3 && canvasCalls.length <= 3,
    'encoder failures do not strand a valid original below the real upload limit')

  reset()
  file(chosen, 2 * 1024 * 1024, 2000, 1000)
  nativeSizes = canvasSizes = [maxBytes + 3, maxBytes + 2, maxBytes + 1]
  await assert.rejects(upload.uploadImage(chosen, 'oversize-receipt'))
  assert.ok(nativeCalls.length <= 3 && canvasCalls.length <= 3, 'normalization has a finite pass budget')
  assert.equal(calls.length + puts.length, 0, 'a photo still over budget never leaves the device')

  reset()
  file(chosen, 2 * 1024 * 1024, 2000, 1000)
  nativeFail = canvasFail = true
  await assert.rejects(upload.uploadImage(chosen, 'failed-receipt'))
  assert.equal(calls.length + puts.length, 0, 'if both encoders fail, the original is not uploaded')

  reset()
  const mismatched = file(chosen, 400)
  mismatched.data = new ArrayBuffer(maxBytes + 3)
  await assert.rejects(upload.uploadImage(chosen, 'mismatched-receipt'))
  assert.equal(puts.length, 0, 'the final binary read is checked before transfer even when metadata claims a small image')
  assert.deepEqual(calls.map(call => call.action), ['beginMediaUpload'], 'changed file contents never finalize')

  reset()
  const missingDigest = file(chosen, 2 * 1024 * 1024, 2000, 1000)
  delete missingDigest.digest
  await assert.rejects(upload.uploadImage(chosen, 'missing-digest-receipt'), /输入已保留/)
  assert.equal(calls.length, 0, 'old drafts require a stable cache key before upload')

  reset()
  const sourcePath = '/saved/old-large-photo.jpg'
  file(sourcePath, 3 * 1024 * 1024, 3024, 4032)
  const page = { data: { photos: [{ key: 'photo1', localPath: sourcePath, uploadRequestId: 'old-receipt' }] },
    setData(fields) { Object.assign(this.data, fields) },
    keepDraft() { this.draft = structuredClone(this.data.photos) } }
  failFinish = true
  await assert.rejects(upload.uploadRecordPhotos(page), /response lost/)
  assert.equal(page.draft[0].localPath, sourcePath, 'uncertain upload preserves the durable source path')
  assert.equal(page.draft[0].uploadRequestId, 'old-receipt', 'normalization preserves the draft receipt')
  const firstAttempt = structuredClone(calls)
  assert.ok(firstAttempt.every(call => call.payload.requestId === 'old-receipt-p5'), 'new compression never reuses a legacy transport receipt')
  assert.equal(copies.length, 1, 'the normalized derivative is persisted before sending')
  assert.ok(copies[0].destPath.startsWith('/user/photo-p5-'))
  const encodeCount = nativeCalls.length + canvasCalls.length
  page.setData({ photos: photoItems(page.draft) })
  upload = loadUpload()
  failFinish = false
  assert.deepEqual(await upload.uploadRecordPhotos(page), ['cloud://saved-photo'])
  assert.equal(nativeCalls.length + canvasCalls.length, encodeCount, 'cold restoration reuses the prepared bytes')
  assert.deepEqual(calls.slice(firstAttempt.length), [firstAttempt[0]], 'cold retry checks the same receipt')
  assert.equal(puts.length, 1, 'a completed upload is not repeated after cold draft restoration')
  assert.equal(page.draft[0].fileId, 'cloud://saved-photo')
  assert.equal(page.draft[0].localPath, '')
  assert.deepEqual(photoItems(page.draft), photoItems(['cloud://saved-photo']))
  await upload.uploadRecordPhotos(page)
  assert.equal(calls.length, 3, 'known uploaded photos do not upload again')
  assert.ok(!JSON.stringify(logs).includes(Buffer.from(puts[0].data).toString('base64')), 'diagnostics never expose image contents')
  assert.ok(!JSON.stringify(logs).includes('test-only'), 'diagnostics never expose upload credentials')

  reset()
  const legacyOriginal = file(chosen, 300 * 1024, 1280, 1707)
  const legacyPath = `/user/photo-p2-${legacyOriginal.digest}.jpg`
  const legacyPrepared = file(legacyPath, 120 * 1024, 720, 960)
  failFinish = true
  await assert.rejects(upload.uploadImage(chosen, 'legacy-cache-receipt'), /response lost/)
  checkTransport(legacyPrepared, 'legacy-cache-receipt-p2')
  assert.equal(nativeCalls.length + canvasCalls.length + copies.length, 0,
    'a pre-existing p2 derivative takes priority even when its original now fits the new budget')
  upload = loadUpload()
  failFinish = false
  assert.equal((await upload.uploadImage(chosen, 'legacy-cache-receipt')).fileId, 'cloud://saved-photo')
  assert.equal(calls.at(-1).payload.requestId, 'legacy-cache-receipt-p2')
  assert.equal(puts.length, 1, 'cold retry retains legacy bytes and the completed legacy receipt')
  originalLog('Photo normalization, binary direct upload and retained retry draft checks passed')
}
main().catch(error => { originalWarn(error); process.exitCode = 1 }).finally(() => {
  console.log = originalLog; console.warn = originalWarn; console.info = originalInfo
})
