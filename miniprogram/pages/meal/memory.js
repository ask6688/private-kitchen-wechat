const { request, alert, withLoading } = require('../../utils/api')
const { chooseImage, uploadImage } = require('../../utils/upload')
const { photoRefs, photoItems, resolvePhotos } = require('../../utils/photos')

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
const fields = meal => ({ photoFileIds: photoRefs(meal.photoFileIds), reflection: meal.reflection || '' })
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const rejected = new Set(['INVALID_INPUT', 'INVALID_MEDIA', 'INVALID_STATE', 'NOT_FOUND', 'FORBIDDEN', 'NO_SPACE',
  'VERSION_CONFLICT', 'REQUEST_EXPIRED', 'REQUEST_CONFLICT'])

module.exports = {
  readMemory() { return this.memoryItemId ? request('getMealDishMemory', { mealId: this.id, itemId: this.memoryItemId }) : request('getMeal', { id: this.id }) },
  memorySet(data) {
    if (this.memoryUnloaded) Object.assign(this.data, data)
    else this.setData(data)
  },
  memoryMeal(latest) {
    const previous = this.data.meal || {}
    const shown = new Map((previous.items || []).map(item => [item.id, item]))
    return { ...previous, ...latest, items: (latest.items || []).map(item => ({ ...shown.get(item.id), ...item })) }
  },
  memoryPatch() {
    const base = this.memoryBase || fields({})
    const photos = this.data.photos.map(photo => photo.fileId || photo.localPath)
    const reflection = this.data.reflection.trim()
    return { ...(!same(photos, base.photoFileIds) ? { photoFileIds: photos } : {}),
      ...(reflection !== base.reflection ? { reflection } : {}) }
  },
  keepMemoryDraft() {
    if (this.discardForm) return true
    if (this.data.recordMode) this.keepForm()
    if (!this.memoryDraftKey) return false
    const dirty = !!this.data.pendingMemoryPayload || !!Object.keys(this.memoryPatch()).length
    this.memorySet({ memoryDirty: dirty })
    try {
      if (dirty) wx.setStorageSync(this.memoryDraftKey, { base: this.memoryBase,
        photos: this.data.photos.map(({ fileId, localPath, key, uploadRequestId }) => ({ fileId, localPath, key, uploadRequestId })),
        reflection: this.data.reflection, pending: this.data.pendingMemoryPayload })
      else wx.removeStorageSync(this.memoryDraftKey)
    } catch (_) {
      this.memorySet({ memoryNotice: '草稿暂存失败，请留在本页，清理存储后重试' })
      return false
    }
    if (!this.memoryUnloaded && !this.memoryHidden) {
      if ((dirty || this.data.recordMode && this.data.formDirty) && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({
        message: this.data.pendingMemoryPayload ? '保存结果待确认，离开后请重开这顿饭核对' : '照片和心得还没保存，离开后会留在本机草稿' })
      else if (!dirty && (!this.data.recordMode || !this.data.formDirty) && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload()
    }
    return true
  },
  async initMemoryDraft(meal) {
    this.memoryBase = fields(meal)
    if (!this.memoryDraftKey || !this.memoryDraftKey.endsWith(`:${meal.id}`)) {
      const context = this.context || await request('bootstrap')
      if (!context.space || !context.member || context.space.id !== meal.spaceId) throw new Error('厨房身份已变化，请重新打开这顿饭')
      this.memoryDraftKey = `${this.memoryItemId ? 'mealDishMemory' : 'mealMemory'}:${context.space.id}:${context.member.id}:${this.memoryItemId ? `${this.memoryItemId}:` : ''}${meal.id}`
    }
    const draft = wx.getStorageSync(this.memoryDraftKey)
    if (!draft || !draft.base || !Array.isArray(draft.photos)) return
    this.memoryBase = draft.base
    const photos = photoItems(draft.photos).map(photo => {
      const saved = draft.photos.find(item => photo.fileId ? item.fileId === photo.fileId : item.key === photo.key) || {}
      return { ...photo, localPath: saved.localPath || '', uploadRequestId: saved.uploadRequestId || '' }
    })
    this.memorySet({ photos, reflection: draft.reflection || '', pendingMemoryPayload: draft.pending || null,
      memoryNotice: draft.pending ? '保存结果待确认，输入已保留，请点核对并重试' : '已恢复这顿饭的本机草稿' })
    if (!draft.pending) this.rebaseMemory(meal)
    this.keepMemoryDraft()
  },
  rebaseMemory(latest) {
    const patch = this.memoryPatch(), remote = fields(latest), base = this.memoryBase
    const changes = { meal: this.memoryMeal(latest), status: latest.status }
    for (const field of ['photoFileIds', 'reflection']) {
      const conflict = Object.prototype.hasOwnProperty.call(patch, field) && !same(remote[field], base[field]) && !same(remote[field], patch[field])
      changes[field === 'photoFileIds' ? 'memoryConflictPhotos' : 'memoryConflictReflection'] = conflict
      if (conflict) continue
      if (!Object.prototype.hasOwnProperty.call(patch, field)) changes[field === 'photoFileIds' ? 'photos' : 'reflection'] = field === 'photoFileIds' ? photoItems(remote[field]) : remote[field]
      this.memoryBase[field] = remote[field]
    }
    this.memoryRemote = latest
    this.memorySet({ ...changes, memoryRemotePhotoCount: remote.photoFileIds.length, memoryRemoteReflection: remote.reflection,
      memoryNotice: latest.status !== 'completed' ? '这顿饭的状态有更新，草稿已保留，请先返回核对'
        : changes.memoryConflictPhotos || changes.memoryConflictReflection ? '伙伴也改了这些内容，请选择要保留哪份' : this.data.memoryNotice })
    this.keepMemoryDraft()
  },
  async resolveMemoryConflict(e) {
    if (this.data.memorySaving || !this.memoryRemote) return
    const { field, choice } = e.currentTarget.dataset
    if (!['photoFileIds', 'reflection'].includes(field) || !['mine', 'latest'].includes(choice)) return
    const remote = fields(this.memoryRemote)
    this.memoryBase[field] = remote[field]
    const data = { [field === 'photoFileIds' ? 'memoryConflictPhotos' : 'memoryConflictReflection']: false }
    if (choice === 'latest') data[field === 'photoFileIds' ? 'photos' : 'reflection'] = field === 'photoFileIds' ? photoItems(remote[field]) : remote[field]
    const discarded = choice === 'latest' && field === 'photoFileIds' ? this.data.photos : []
    this.memorySet(data)
    this.memorySet({ memoryNotice: this.data.memoryConflictPhotos || this.data.memoryConflictReflection
      ? '还有一项修改需要核对' : '已保留你的选择，保存后生效' })
    if (this.keepMemoryDraft()) this.removeMemoryLocal(discarded)
    await this.retryImages()
  },
  async previewMemoryRemote() {
    if (!this.memoryRemote) return
    const photos = await resolvePhotos(photoItems(this.memoryRemote.photoFileIds))
    if (!photos.length) return wx.showToast({ title: '已保存的相册为空', icon: 'none' })
    if (photos.some(photo => !photo.url)) return alert(new Error('已保存照片暂时未加载，请重试'))
    wx.previewImage({ current: photos[0].url, urls: photos.map(photo => photo.url) })
  },
  onReflection(e) {
    if (this.data.memorySaving || this.data.pendingMemoryPayload || this.data.pendingEatingPayload || this.data.status !== 'completed') return
    this.memorySet({ reflection: e.detail.value })
    this.keepMemoryDraft()
  },
  async addAlbumPhoto() {
    if (this.data.status !== 'completed' || this.data.memorySaving || this.data.pendingMemoryPayload || this.data.pendingEatingPayload || this.data.saving || this.albumChoosing) return
    if (this.data.photos.length >= 12) return wx.showToast({ title: '最多 12 张照片', icon: 'none' })
    this.albumChoosing = true
    try {
      const { tempFilePath } = await chooseImage({ persist: true })
      const uploadRequestId = newId()
      this.memorySet({ photos: [...this.data.photos, { fileId: '', localPath: tempFilePath, uploadRequestId,
        key: uploadRequestId, url: tempFilePath, state: 'loading' }] })
      this.keepMemoryDraft()
    } catch (error) { if (!/cancel/.test(error.errMsg || '')) alert(error) }
    finally { this.albumChoosing = false }
  },
  removeAlbumPhoto(e) {
    if (this.data.status !== 'completed' || this.data.memorySaving || this.data.pendingMemoryPayload || this.data.pendingEatingPayload || this.data.saving) return
    const index = Number(e.currentTarget.dataset.index)
    if (!Number.isInteger(index) || index < 0 || index >= this.data.photos.length) return
    const removed = this.data.photos[index]
    this.memorySet({ photos: this.data.photos.filter((_, i) => i !== index) })
    if (this.keepMemoryDraft()) this.removeMemoryLocal([removed])
  },
  removeMemoryLocal(photos) {
    for (const photo of photos) if (photo.localPath && photo.uploadRequestId) {
      wx.getFileSystemManager().unlink({ filePath: photo.localPath, fail() {} })
    }
  },
  async finishMemory(latest) {
    const oldPhotos = this.data.photos
    this.memoryBase = fields(latest)
    this.memorySet({ meal: this.memoryMeal(latest), status: latest.status,
      photos: photoItems(latest.photoFileIds), reflection: latest.reflection || '', pendingMemoryPayload: null,
      memoryDirty: false, memoryNotice: '', memoryConflictPhotos: false, memoryConflictReflection: false })
    if (this.keepMemoryDraft()) this.removeMemoryLocal(oldPhotos)
    if (!this.memoryUnloaded) await this.retryImages()
  },
  async cancelMemory() {
    if (this.data.memorySaving || this.data.pendingMemoryPayload) return alert(new Error('保存结果仍待确认，请先核对，避免误以为已取消保存'))
    if (!this.data.memoryDirty) return
    this.memorySet({ memorySaving: true })
    try {
      const latest = await this.readMemory()
      await this.finishMemory(latest)
      if (!this.memoryUnloaded) wx.showToast({ title: '已取消本次修改', icon: 'none' })
    } catch (error) { alert(error) }
    finally { this.memorySet({ memorySaving: false }) }
  },
  async saveMemory() {
    if (!this.data.meal || !this.data.memoryDirty || this.data.memorySaving) return
    if (!this.data.pendingMemoryPayload && this.data.status !== 'completed') return alert(new Error('这顿饭的状态已变化，请核对后再编辑'))
    if (this.data.memoryConflictPhotos || this.data.memoryConflictReflection) return alert(new Error('请先核对伙伴修改的内容'))
    this.memorySet({ memorySaving: true, memoryNotice: '' })
    try {
      await withLoading(async () => {
        if (!this.data.pendingMemoryPayload) {
          for (const photo of this.data.photos) {
            if (!photo.localPath || photo.fileId) continue
            if (!photo.uploadRequestId) photo.uploadRequestId = newId()
            if (!this.keepMemoryDraft()) throw new Error('草稿未能暂存，请留在本页重试')
            const { fileId } = await uploadImage(photo.localPath, photo.uploadRequestId)
            this.memorySet({ photos: this.data.photos.map(item => item.key === photo.key ? { ...item, fileId } : item) })
            if (!this.keepMemoryDraft()) throw new Error('上传已完成，草稿暂存失败，请留在本页重试')
          }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!this.data.pendingMemoryPayload) {
            const patch = this.memoryPatch()
            if (!Object.keys(patch).length) return this.finishMemory(await this.readMemory())
            this.memorySet({ pendingMemoryPayload: { mealId: this.id, expectedStatus: 'completed',
              version: this.data.meal.version, requestVersion: this.data.meal.version, requestId: newId(),
              ...(this.memoryItemId ? { itemId: this.memoryItemId, recordVersion: this.data.meal.recordVersion } : {}), ...patch } })
          }
          if (!this.keepMemoryDraft()) throw new Error('保存请求未能暂存，请留在本页重试')
          try {
            const updated = await request(this.memoryItemId ? 'saveMealDishMemory' : 'saveMealMemory', this.data.pendingMemoryPayload)
            await this.finishMemory(updated)
            if (updated.changedSinceReceipt) this.memorySet({ memoryNotice: '上次已保存，此后又有更新，现显示最新内容' })
            if (!this.memoryUnloaded) wx.showToast({ title: updated.replayed ? '已核对上次保存结果' : '记下来啦', icon: 'none' })
            return
          } catch (error) {
            if (!rejected.has(error.code)) {
              this.memorySet({ memoryNotice: '保存结果待确认，输入已保留，核对重试不会重复记录' })
              this.keepMemoryDraft()
              return
            }
            this.memorySet({ pendingMemoryPayload: null })
            this.keepMemoryDraft()
            if (['VERSION_CONFLICT', 'INVALID_STATE', 'REQUEST_EXPIRED'].includes(error.code)) {
              const latest = await this.readMemory()
              this.rebaseMemory(latest)
              await this.retryImages()
              if (error.code === 'VERSION_CONFLICT' && attempt === 0 && latest.status === 'completed' &&
                !this.data.memoryConflictPhotos && !this.data.memoryConflictReflection) continue
              if (this.data.memoryConflictPhotos || this.data.memoryConflictReflection || latest.status !== 'completed') return
            }
            throw error
          }
        }
      })
    } catch (error) {
      this.memorySet({ memoryNotice: error.message || '保存未完成，输入已保留，请重试' })
      this.keepMemoryDraft()
      if (!this.memoryUnloaded) alert(error)
    } finally { this.memorySet({ memorySaving: false }) }
  },
}
