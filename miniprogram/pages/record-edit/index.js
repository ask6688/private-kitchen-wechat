const { request, alert, withLoading, setSpaceTitle, formatDate } = require('../../utils/api')
const { chooseImage, uploadImage, uploadRecordPhotos } = require('../../utils/upload')
const { navigate } = require('../../utils/navigation')
const { photoRefs, photoItems, photoHandlers } = require('../../utils/photos')
const memoryHandlers = require('../meal/memory')

Page({
  ...photoHandlers,
  ...memoryHandlers,
  data: {
    id: '', version: null, recipeId: '', wishId: '', mealId: '', sourceName: '',
    choices: [], date: formatDate(new Date()), note: '', photos: [], finishWish: false,
    dishSnapshot: null, showRecipeInfo: false, requestId: '', pendingRecordPayload: null, savedRecordId: '',
    loading: true, saving: false, error: '', photoDraftNotice: '', canRestorePhotos: false,
    dishContext: false, meal: null, status: '', reflection: '', memoryDirty: false, memorySaving: false,
    memoryNotice: '', pendingMemoryPayload: null, memoryConflictPhotos: false, memoryConflictReflection: false,
  },
  onLoad(options) {
    if (options.mealId && options.itemId) {
      this.id = options.mealId; this.memoryItemId = options.itemId
      this.setData({ dishContext: true, mealId: this.id })
      return this.loadDishMemory()
    }
    this.saved = false
    this.legacyDraftKey = `recordDraft:${options.id || options.mealId || 'new'}:${options.recipeId || options.wishId || ''}`
    this.draftKey = `recordDraft:${options.id || options.mealId || 'new'}:${options.recipeId || ''}:${options.wishId || ''}`
    if (!options.id) this.draftKey = this.legacyDraftKey = ''
    this.setData({ id: options.id || '', recipeId: options.recipeId || '', wishId: options.wishId || '',
      mealId: options.mealId || '', finishWish: !!options.wishId && !options.id,
      requestId: options.id ? '' : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`,
      pendingRecordPayload: null, savedRecordId: '' })
    return this.load()
  },
  onShow() { this.memoryHidden = false; setSpaceTitle(this.data.dishContext ? '这道菜的记录' : '做菜记录'); if (this.refreshSources) { this.refreshSources = false; return this.retry() } },
  async loadDishMemory() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const memory = await this.readMemory()
      if (token !== this.loadToken || this.memoryUnloaded) return
      if (memory.status !== 'completed') throw new Error('这顿饭已撤销完成，请返回饭单查看；本机修改仍保留')
      this.setData({ meal: memory, status: memory.status, sourceName: memory.sourceName,
        dishRecipeId: (memory.items.find(item => item.id === this.memoryItemId) || {}).recipeId || '',
        date: memory.date, photos: photoItems(memory.photoFileIds), reflection: memory.reflection || '' })
      await this.initMemoryDraft(memory)
      await this.retryImages()
    } catch (error) { if (token === this.loadToken && !this.memoryUnloaded) this.setData({ error: error.message }) }
    finally { if (token === this.loadToken && !this.memoryUnloaded) this.setData({ loading: false }) }
  },
  leaveDishMemory() {
    if (this.memoryUnloaded) return
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const previous = pages[pages.length - 2]
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload()
    return navigate(this, previous && previous.route === 'pages/menu-preview/index' && previous.id === this.id ? 'navigateBack' : 'redirectTo',
      previous && previous.route === 'pages/menu-preview/index' && previous.id === this.id ? '' : `/pages/menu-preview/index?id=${this.id}&from=list`)
  },
  viewDishRecipe() { if (this.data.dishRecipeId) navigate(this, 'navigateTo', `/pages/recipe/index?id=${this.data.dishRecipeId}`) },
  async saveDishMemory() {
    if (this.data.memorySaving || this.data.loading || this.data.error) return
    if (this.data.memoryDirty) await this.saveMemory()
    if (!this.data.memoryDirty && !this.data.pendingMemoryPayload && !this.data.memoryConflictPhotos && !this.data.memoryConflictReflection) this.leaveDishMemory()
  },
  cancelDishMemory() {
    if (this.data.memorySaving || this.data.pendingMemoryPayload) return alert(new Error('保存结果仍待核对，请先确认结果；输入仍保留'))
    if (!this.data.memoryDirty) return this.leaveDishMemory()
    wx.showModal({ title: '放弃这次修改？', content: '已保存的照片和心得会保留', confirmText: '放弃修改', success: async ({ confirm }) => {
      if (!confirm) return
      try { await this.finishMemory(await this.readMemory()); this.leaveDishMemory() } catch (error) { alert(error) }
    } })
  },
  toggleRecipeInfo() { this.setData({ showRecipeInfo: !this.data.showRecipeInfo }) },
  retry() { this.setData({ loading: true, error: '' }); return this.data.dishContext ? this.loadDishMemory() : this.load() },
  onHide() { this.memoryHidden = true; this.keepDraft(); if (this.data.dishContext && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload() },
  onUnload() { this.keepDraft(); this.memoryUnloaded = true; this.loadToken = (this.loadToken || 0) + 1; this.photoLoadToken++ },
  keepDraft() {
    if (this.data.dishContext) return this.keepMemoryDraft()
    if (this.saved || !this.dirty || !this.draftKey) return
    const { id, version, recipeId, wishId, mealId, sourceName, date, note, photos, finishWish, requestId, pendingRecordPayload } = this.data
    if (id || recipeId || wishId || note || photos.length || pendingRecordPayload) {
      wx.setStorageSync(this.draftKey, { id, version, recipeId, wishId, mealId, sourceName, date, note,
        photos: photos.map(({ fileId, localPath, uploadRequestId }) => ({ fileId, localPath, uploadRequestId })), finishWish, requestId, pendingRecordPayload })
      if (this.legacyDraftKey !== this.draftKey) wx.removeStorageSync(this.legacyDraftKey)
    }
  },
  async restoreDraft() {
    if (!this.draftKey) return
    const draft = wx.getStorageSync(this.draftKey) || wx.getStorageSync(this.legacyDraftKey)
    if (!draft) return
    this.dirty = true
    const stale = this.data.id && draft.version !== this.data.version
    let photos = photoItems(draft.photos || draft.photoFileIds || [])
    if (stale) photos = photoItems([...photos, ...this.data.photos])
    const canRestorePhotos = !stale && (this.originalPhotoFileIds || []).some(fileId => !photoRefs(photos).includes(fileId))
    const linked = draft.wishId && this.data.choices.find(choice => choice.wishId === draft.wishId)
    const recipeId = linked ? linked.recipeId : draft.wishId === this.data.wishId && this.data.recipeId ? this.data.recipeId : draft.recipeId
    this.setData({ ...draft, recipeId, sourceName: linked ? linked.label : draft.sourceName,
      photos, canRestorePhotos, photoDraftNotice: stale ? '记录有更新，已补入保存的照片，本机修改仍保留'
        : canRestorePhotos ? '草稿中的照片已移除，保存前原照片仍保留' : '' })
  },
  restoreSavedPhotos() {
    if (this.data.saving || this.data.pendingRecordPayload || this.saved) return
    this.setData({ photos: photoItems([...this.originalPhotoFileIds, ...this.data.photos]), canRestorePhotos: false, photoDraftNotice: '' })
    this.dirty = true
    this.keepDraft()
    return this.retryImages()
  },
  async load(restore = true) {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      const [record, recipes, wishes, context] = await Promise.all([
        this.data.id ? request('getRecord', { id: this.data.id }) : null,
        request('listRecipes'), request('listWishes', { status: 'open' }),
        !this.data.id ? request('bootstrap') : null,
      ])
      if (token !== this.loadToken || this.memoryUnloaded) return
      if (!this.data.id) {
        if (!context || !context.space) throw new Error('请先加入厨房，再记录这次下厨')
        this.draftKey = `recordDraft:${context.space.id}:${this.data.mealId || 'new'}:${this.data.recipeId}:${this.data.wishId}`
        this.legacyDraftKey = this.draftKey
      }
      const choices = recipes.map(item => ({ label: `菜品 · ${item.name}`, recipeId: item.id, wishId: '' }))
      for (const wish of wishes) {
        const linked = wish.recipeId && choices.find(item => item.recipeId === wish.recipeId)
        if (linked) {
          linked.wishId = wish.id
          linked.label = `菜品与心愿 · ${wish.recipe && wish.recipe.name || wish.title}`
        } else choices.push({ label: `心愿 · ${wish.recipe && wish.recipe.name || wish.title}`,
          recipeId: wish.recipeId || '', wishId: wish.id })
      }
      const wishId = record ? record.wishId : this.data.wishId
      const linkedWish = wishId && (wishes.find(item => item.id === wishId) || await request('getWish', { id: wishId }))
      const recipeId = record ? record.recipeId || linkedWish && linkedWish.recipeId || '' : this.data.recipeId || linkedWish && linkedWish.recipeId || ''
      if (token !== this.loadToken || this.memoryUnloaded) return
      this.originalPhotoFileIds = photoRefs(record && record.photoFileIds)
      const source = choices.find(item => wishId && item.wishId === wishId || !wishId && recipeId && item.recipeId === recipeId)
      this.setData({
        choices, id: record ? record.id : this.data.id, version: record ? record.version : null,
        recipeId, wishId, mealId: record ? record.mealId : this.data.mealId,
        sourceName: source ? source.label : record ? record.name || record.dishSnapshot && record.dishSnapshot.name || '' : recipeId || wishId ? '已关联的菜品或心愿' : '',
        dishSnapshot: record && record.dishSnapshot || null,
        date: record ? record.date : this.data.date, note: record ? record.note : '',
        photos: photoItems(record && record.photoFileIds), photoDraftNotice: '', canRestorePhotos: false,
        finishWish: record ? false : this.data.finishWish, error: '',
      })
      if (restore) await this.restoreDraft()
      await this.retryImages()
    } catch (error) {
      if (token !== this.loadToken || this.memoryUnloaded) return
      this.setData({ error: error.message })
      if (!restore) throw error
    } finally { if (token === this.loadToken && !this.memoryUnloaded) this.setData({ loading: false }) }
  },
  source(e) {
    if (this.data.saving || this.data.pendingRecordPayload || this.saved) return
    const choice = this.data.choices[Number(e.detail.value)]
    if (!choice) return
    this.dirty = true
    this.setData({ recipeId: choice.recipeId, wishId: choice.wishId, sourceName: choice.label, finishWish: !!choice.wishId && !this.data.id })
  },
  onDate(e) { if (this.data.saving || this.data.pendingRecordPayload || this.saved) return; this.dirty = true; this.setData({ date: e.detail.value }) },
  onNote(e) { if (this.data.dishContext) return this.onReflection(e); if (this.data.saving || this.data.pendingRecordPayload || this.saved) return; this.dirty = true; this.setData({ note: e.detail.value }) },
  onFinishWish(e) { if (this.data.saving || this.data.pendingRecordPayload || this.saved) return; this.dirty = true; this.setData({ finishWish: e.detail.value }) },
  photo() {
    if (this.data.dishContext) return this.replaceDishPhoto()
    if (this.data.saving || this.data.pendingRecordPayload || this.saved) return
    if (this.data.photos.length >= 12) return wx.showToast({ title: '最多 12 张照片', icon: 'none' })
    return withLoading(chooseImage).then(({ tempFilePath }) => {
      this.dirty = true
      this.setData({ photos: [...this.data.photos, { fileId: '', localPath: tempFilePath, key: `${tempFilePath}:${Date.now()}`, url: tempFilePath, state: 'loading' }] })
    }).catch(error => { if (error.errMsg && error.errMsg.includes('cancel')) return; alert(error) })
  },
  async replaceDishPhoto() {
    if (this.data.memorySaving || this.data.pendingMemoryPayload || this.albumChoosing) return
    this.albumChoosing = true
    try {
      const { tempFilePath } = await chooseImage({ persist: true }), uploadRequestId = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
      const previous = this.data.photos
      this.memorySet({ photos: [{ fileId: '', localPath: tempFilePath, uploadRequestId, key: uploadRequestId, url: tempFilePath, state: 'loading' }] })
      if (this.keepMemoryDraft()) this.removeMemoryLocal(previous)
    } catch (error) { if (!/cancel/.test(error.errMsg || '')) alert(error) }
    finally { this.albumChoosing = false }
  },
  removePhoto(e) {
    if (this.data.dishContext) {
      if (this.data.memorySaving || this.data.pendingMemoryPayload || this.albumChoosing) return
      const previous = this.data.photos
      this.memorySet({ photos: [] })
      if (this.keepMemoryDraft()) this.removeMemoryLocal(previous)
      return
    }
    if (this.data.saving || this.data.pendingRecordPayload || this.saved) return
    this.dirty = true
    this.setData({ photos: this.data.photos.filter((_, index) => index !== Number(e.currentTarget.dataset.index)) })
  },
  leaveSavedRecord() {
    if (this.memoryUnloaded) return
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    return navigate(this, pages.length > 1 ? 'navigateBack' : 'redirectTo',
      pages.length > 1 ? '' : '/pages/record-list/index?kind=cooking')
  },
  save() {
    if (this.data.dishContext) return this.saveDishMemory()
    if (this.data.saving || this.data.loading || this.data.error) return
    if (this.saved) return this.leaveSavedRecord()
    if (!this.data.recipeId && !this.data.wishId && !(this.data.id && this.data.dishSnapshot)) return wx.showToast({ title: '先选择做的是哪道菜', icon: 'none' })
    const payload = { recipeId: this.data.recipeId, wishId: this.data.wishId, mealId: this.data.mealId,
      date: this.data.date, note: this.data.note.trim(), photoFileIds: [] }
    if (this.data.id) { payload.id = this.data.id; payload.version = this.data.version }
    else payload.requestId = this.data.requestId
    this.dirty = true
    this.keepDraft()
    this.setData({ saving: true })
    return withLoading(async () => {
      if (!this.data.id) {
        if (!this.data.pendingRecordPayload) {
          payload.photoFileIds = await uploadRecordPhotos(this)
          this.setData({ pendingRecordPayload: payload })
          this.keepDraft()
        }
        return request('saveRecord', this.data.pendingRecordPayload)
      }
      const uploaded = []
      try {
        for (const photo of this.data.photos) {
          if (photo.localPath) {
            const { fileId } = await uploadImage(photo.localPath)
            uploaded.push(fileId)
            payload.photoFileIds.push(fileId)
          } else payload.photoFileIds.push(photo.fileId)
        }
        return await request('saveRecord', payload)
      } catch (error) {
        await Promise.all(uploaded.map(fileId => request('discardMedia', { fileId }).catch(() => {})))
        throw error
      }
    }).then(async record => {
      this.saved = true
      this.setData({ pendingRecordPayload: null, savedRecordId: record.id })
      wx.removeStorageSync(this.draftKey)
      if (this.legacyDraftKey !== this.draftKey) wx.removeStorageSync(this.legacyDraftKey)
      for (const fileId of this.originalPhotoFileIds || []) {
        if (!payload.photoFileIds.includes(fileId)) await request('discardMedia', { fileId }).catch(() => {})
      }
      let wishError = null
      if (this.data.wishId && this.data.finishWish) {
        try {
          const wish = await request('getWish', { id: this.data.wishId })
          if (wish.status === 'open') await request('completeWish', { id: wish.id, version: wish.version, recordId: record.id })
        } catch (error) { wishError = error }
      }
      if (wishError) await new Promise(resolve => wx.showModal({ title: '记录已保存',
        content: `心愿还未实现：${wishError.message}；稍后可到心愿单重试`, showCancel: false, complete: resolve }))
      else wx.showToast({ title: '记下来啦' })
      this.leaveSavedRecord()
    }).catch(error => {
      if (['INVALID_INPUT', 'INVALID_MEDIA', 'NOT_FOUND', 'FORBIDDEN', 'NO_SPACE', 'VERSION_CONFLICT', 'INVALID_STATE'].includes(error.code)) this.setData({ pendingRecordPayload: null })
      this.keepDraft()
      if (error.code !== 'VERSION_CONFLICT') return alert(error)
      this.keepDraft()
      wx.showModal({
        title: '记录已被更新',
        content: '伙伴已先保存，你的修改已存为草稿；重新载入会放弃本次修改',
        cancelText: '稍后处理', confirmText: '重新载入',
        success: async ({ confirm }) => {
          if (!confirm) return
          try {
            await this.load(false)
            wx.removeStorageSync(this.draftKey)
            if (this.legacyDraftKey !== this.draftKey) wx.removeStorageSync(this.legacyDraftKey)
            this.dirty = false
            wx.showToast({ title: '已载入最新内容', icon: 'none' })
          } catch (loadError) { alert(loadError) }
        },
      })
    }).finally(() => this.setData({ saving: false }))
  },
})
