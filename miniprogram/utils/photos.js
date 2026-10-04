const { mediaUrls } = require('./api')

function photoRefs(value) {
  return [...new Set((Array.isArray(value) ? value : value ? [value] : [])
    .map(item => typeof item === 'string' ? item : item && (item.fileId || item.fileID))
    .filter(item => typeof item === 'string' && item.trim()))]
}

function photoItems(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : value ? [value] : []).map((item, index) => {
    const fileId = typeof item === 'string' ? item : item && (item.fileId || item.fileID) || ''
    const localPath = fileId ? '' : item && item.localPath || ''
    if (!fileId && !localPath || fileId && seen.has(fileId)) return null
    if (fileId) seen.add(fileId)
    return { fileId, localPath, ...(localPath && item.uploadRequestId ? { uploadRequestId: item.uploadRequestId } : {}),
      key: fileId || item.key || `${localPath}:${index}`, url: localPath, state: 'loading' }
  }).filter(Boolean)
}

async function resolvePhotos(photos) {
  let urls = {}
  try { urls = await mediaUrls(photoRefs(photos)) } catch (_) {}
  return photos.map(photo => {
    const url = photo.fileId ? urls[photo.fileId] || '' : photo.localPath || ''
    return { ...photo, url, state: url ? photo.url === url && photo.state === 'ready' ? 'ready' : 'loading' : 'error' }
  })
}

// The two record editors use the same photo array and native image events.
const photoHandlers = {
  async retryImages() {
    const token = this.photoLoadToken = (this.photoLoadToken || 0) + 1
    const snapshot = this.data.photos
    this.setData({ photos: snapshot.map(photo => photo.state === 'ready' ? photo : { ...photo, url: '', state: 'loading' }) })
    const resolved = await resolvePhotos(snapshot)
    if (token !== this.photoLoadToken) return
    const byKey = new Map(resolved.map(photo => [photo.key, photo]))
    this.setData({ photos: this.data.photos.map(photo => {
      const fresh = byKey.get(photo.key)
      return fresh && fresh.fileId === photo.fileId && fresh.localPath === photo.localPath ? { ...photo, url: fresh.url, state: fresh.state } : photo
    }) })
  },
  photoLoaded(e) {
    const { key, url } = e.currentTarget.dataset
    this.setData({ photos: this.data.photos.map(photo => photo.key === key && photo.url === url && photo.state !== 'error' ? { ...photo, state: 'ready' } : photo) })
  },
  photoFailed(e) {
    const { key, url } = e.currentTarget.dataset
    this.setData({ photos: this.data.photos.map(photo => photo.key === key && photo.url === url ? { ...photo, state: 'error' } : photo) })
  },
  retryPhoto() { return this.retryImages() },
  async previewPhoto(e) {
    const key = e.currentTarget.dataset.key
    await this.retryImages()
    const photos = this.data.photos
    if (photos.some(photo => !photo.url || photo.state === 'error')) return wx.showToast({ title: '照片尚未全部加载，请重试失败照片', icon: 'none' })
    if (photos.length) wx.previewImage({ current: (photos.find(photo => photo.key === key) || photos[0]).url, urls: photos.map(photo => photo.url) })
  },
}

module.exports = { photoRefs, photoItems, resolvePhotos, photoHandlers }
