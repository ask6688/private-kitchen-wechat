const { request } = require('./api')

// Compression targets are soft; the private file-upload endpoint accepts up to 1 MiB.
const TARGET_PHOTO_BYTES = 512 * 1024
const MAX_PHOTO_BYTES = 1024 * 1024
// Older, non-persistent photo editors retry the same selected file while the page is open.
const pendingUploads = new Map()
const fileInfo = filePath => new Promise((resolve, reject) => wx.getFileInfo({ filePath, success: resolve, fail: reject }))
const imageInfo = src => new Promise((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject }))

async function jpegImage(src, width, height, quality) {
  const canvas = wx.createOffscreenCanvas && wx.createOffscreenCanvas({ type: '2d', width, height })
  const context = canvas && canvas.getContext('2d')
  if (!context) throw new Error('照片处理失败，请重试选择照片')
  const image = canvas.createImage()
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
      image.src = src
    })
  } finally { image.onload = image.onerror = null }
  context.fillStyle = '#fff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, width, height, destWidth: width,
    destHeight: height, fileType: 'jpg', quality: quality / 100, success: resolve, fail: reject }))
}

async function prepareImage(filePath, cache = false) {
  const [original, dimensions] = await Promise.all([fileInfo(filePath), imageInfo(filePath)])
  const { width, height } = dimensions
  const usable = (info, image) => info.size > 0 && info.size <= MAX_PHOTO_BYTES &&
    image.width > 0 && image.height > 0 && /^(jpe?g|png)$/i.test(image.type)
  const light = (info, image) => usable(info, image) && info.size <= TARGET_PHOTO_BYTES &&
    Math.max(image.width, image.height) <= 1920
  if (!(width > 0 && height > 0 && original.size > 0)) throw new Error('无法读取照片，请重新选择')
  // Retry old drafts with their original prepared bytes and receipt, even under the new limits.
  if (cache && original.digest) {
    for (const version of ['p2', 'p5']) {
      const path = `${wx.env.USER_DATA_PATH}/photo-${version}-${original.digest}.jpg`
      const saved = await Promise.all([fileInfo(path), imageInfo(path)]).catch(() => null)
      if (saved && usable(...saved) && (version !== 'p2' ||
        (saved[0].size <= 180 * 1024 && Math.max(saved[1].width, saved[1].height) <= 1280))) {
        return { tempFilePath: path, changed: true, version }
      }
    }
  }
  if (light(original, dimensions)) {
    return { tempFilePath: filePath, changed: false }
  }
  const cachedPath = cache && original.digest ? `${wx.env.USER_DATA_PATH}/photo-p5-${original.digest}.jpg` : ''
  if (cache && !cachedPath) throw new Error('无法暂存压缩照片，输入已保留，请重试')
  let best = usable(original, dimensions) ? { tempFilePath: filePath, info: original, image: dimensions } : null
  for (const [edge, quality] of [[1600, 78], [1280, 70], [960, 62]]) {
    const scale = Math.min(1, edge / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * scale)), targetHeight = Math.max(1, Math.round(height * scale))
    let usedCanvas = false
    const renderJpeg = () => { usedCanvas = true; return jpegImage(filePath, targetWidth, targetHeight, quality) }
    let candidate = null
    try {
      const output = await new Promise((resolve, reject) => wx.compressImage({ src: filePath, quality,
        compressedWidth: targetWidth, compressedHeight: targetHeight, success: resolve, fail: reject }))
        .catch(renderJpeg)
      const [info, image] = await Promise.all([fileInfo(output.tempFilePath), imageInfo(output.tempFilePath)])
      candidate = { ...output, info, image }
      if (usable(info, image) && (!best || info.size < best.info.size)) best = candidate
      if (light(info, image)) { best = candidate; break }
    } catch (_) { /* Try the next bounded compression candidate. */ }
    // Some devices ignore native size options. Canvas is a bounded fallback, never a new upload route.
    if (edge === 960 && !usedCanvas && (!candidate || !light(candidate.info, candidate.image))) {
      try {
        const output = await renderJpeg()
        const [info, image] = await Promise.all([fileInfo(output.tempFilePath), imageInfo(output.tempFilePath)])
        if (usable(info, image) && (!best || info.size < best.info.size)) best = { ...output, info, image }
      } catch (_) { /* Keep the smallest valid candidate, if one exists. */ }
    }
  }
  if (!best) throw new Error('照片处理未成功，输入已保留，请重新选择后重试')
  const changed = best.tempFilePath !== filePath
  if (changed && cachedPath) await new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({
    srcPath: best.tempFilePath, destPath: cachedPath, success: resolve, fail: reject }))
  return { tempFilePath: changed && cachedPath || best.tempFilePath, changed, version: 'p5' }
}

async function chooseImage({ persist = false } = {}) {
  const { tempFiles } = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ['image'],
    sourceType: ['album', 'camera'], success: resolve, fail: reject }))
  if (!tempFiles[0]) throw new Error('没有选中照片')
  const { tempFilePath } = await prepareImage(tempFiles[0].tempFilePath)
  if (!persist) return { tempFilePath }
  return new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({ tempFilePath,
    success: ({ savedFilePath }) => resolve({ tempFilePath: savedFilePath }),
    fail: () => reject(new Error('无法暂存这张照片，请清理本机存储后重试')) }))
}

async function uploadImage(tempFilePath, requestId) {
  const prepared = await prepareImage(tempFilePath, true)
  const info = await fileInfo(prepared.tempFilePath)
  if (!info.size || info.size > MAX_PHOTO_BYTES || !/^[a-f0-9]{32}$/i.test(info.digest || '')) {
    throw new Error('照片处理失败，输入已保留，请重试')
  }
  if (!requestId && !pendingUploads.has(tempFilePath)) {
    pendingUploads.set(tempFilePath, `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`)
  }
  const uploadRequestId = requestId ? prepared.changed ? `${requestId}-${prepared.version}` : requestId : pendingUploads.get(tempFilePath)
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(uploadRequestId)) throw new Error('照片上传标识已失效，请重新选择照片')
  const ticket = await request('beginMediaUpload', { requestId: uploadRequestId, size: info.size, md5: info.digest })
  if (ticket.fileId) {
    pendingUploads.delete(tempFilePath)
    return ticket
  }
  if (!/^https:\/\//.test(ticket.url || '') || !ticket.headers) throw new Error('照片上传凭证无效，输入已保留，请重试')
  const { data } = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath: prepared.tempFilePath, success: resolve, fail: reject
  }))
  // WeChat can return an ArrayBuffer from another JS realm; instanceof rejects those valid buffers.
  if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]' || data.byteLength !== info.size) throw new Error('照片内容已变化，输入已保留，请重新选择')
  await new Promise((resolve, reject) => wx.request({
    url: ticket.url, method: 'PUT', header: ticket.headers, data, dataType: 'text', timeout: 30000,
    success: result => {
      if (result.statusCode >= 200 && result.statusCode < 300) return resolve()
      const error = new Error(result.statusCode === 403 ? '照片上传凭证已失效，输入已保留，请重试' : '照片传输失败，输入已保留，请重试')
      error.code = `PHOTO_HTTP_${result.statusCode}`
      reject(error)
    },
    fail: result => {
      const message = result.errMsg || ''
      const error = new Error(/url not in domain list|合法域名/i.test(message)
        ? '图片上传域名尚未配置，输入已保留，请联系维护者'
        : /timeout/i.test(message) ? '照片上传超时，输入已保留，请重试' : '照片传输失败，输入已保留，请重试')
      error.code = /url not in domain list|合法域名/i.test(message) ? 'PHOTO_DOMAIN' : 'PHOTO_TRANSFER_FAILED'
      reject(error)
    }
  }))
  const result = await request('finishMediaUpload', { requestId: uploadRequestId })
  if (!result.fileId) throw new Error('照片保存结果尚未确认，输入已保留，请重试')
  pendingUploads.delete(tempFilePath)
  return result
}

async function uploadRecordPhotos(page) {
  for (const photo of page.data.photos) {
    if (!photo.localPath || photo.fileId) continue
    const uploadRequestId = photo.uploadRequestId || `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
    page.setData({ photos: page.data.photos.map(item => item.key === photo.key ? { ...item, uploadRequestId } : item) })
    page.keepDraft()
    const { fileId } = await uploadImage(photo.localPath, uploadRequestId)
    page.setData({ photos: page.data.photos.map(item => item.key === photo.key
      ? { ...item, fileId, localPath: '' } : item) })
    page.keepDraft()
  }
  return page.data.photos.map(photo => photo.fileId)
}

module.exports = { chooseImage, uploadImage, uploadRecordPhotos }
