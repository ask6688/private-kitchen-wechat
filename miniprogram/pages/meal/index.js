const { request, alert, withLoading, memberSpace, setSpaceTitle, mediaUrls, formatDate } = require('../../utils/api')
const selection = require('../../utils/selection')
const { chooseImage, uploadImage } = require('../../utils/upload')
const { navigate, openMealDetail } = require('../../utils/navigation')
const { photoRefs, photoItems, photoHandlers } = require('../../utils/photos')

const memoryHandlers = require('./memory')
const recordHandlers = require('./record')
const swipeHandlers = require('../../utils/swipe')
const celebrationParticles = require('../../utils/celebration')

const requestId = () => `r${Date.now()}${Math.random().toString(36).slice(2, 12)}`

Page({
  ...photoHandlers,
  ...memoryHandlers,
  ...recordHandlers,
  ...swipeHandlers,
  data: {
    recordMode: false, newDishName: '', formDirty: false, pendingEatingPayload: null, pendingMealPayload: null, openSaved: false,
    meal: null, title: '一起开饭', pageTitle: '这顿饭', date: formatDate(new Date()), diners: '2', note: '', status: 'draft',
    photos: [], reflection: '', memoryDirty: false, memorySaving: false, memoryNotice: '',
    pendingMemoryPayload: null, memoryConflictPhotos: false, memoryConflictReflection: false,
    loading: true, loadReady: false, saving: false, savingAction: '', photoSaving: false, photosLoading: false, error: '', successNote: '', openId: '', confirmationVisible: false, confirmationParticles: [],
  },
  onLoad(options) {
    this.id = options.id || ''
    this.setData({ recordMode: options.mode === 'record' })
    this.returnToDetail = options.return === 'detail'
    this.pendingAdd = options.addRecipeId ? { recipeId: options.addRecipeId } : options.addWishId ? { wishId: options.addWishId } : null
  },
  onShow() { this.memoryHidden = false; this.syncTitle(); return this.pendingAdd ? this.addFromLink() : this.albumChoosing || this.data.memoryDirty || this.data.recordMode && this.data.formDirty ? undefined : this.load() },
  retryPendingMeal() {
    if (!this.pendingMealSave) return
    const status = this.pendingMealSave.status
    return this.save(status).then(meal => {
      if (!meal) return
      if (status === 'completed') openMealDetail(this, meal, true)
      else if (status === 'cancelled') { getApp().globalData.mealWishContext = null; navigate(this, 'switchTab', '/pages/menu/index') }
    })
  },
  retry() { if (this.savedMealId) return this.openSavedRecord(); return this.pendingAdd ? this.addFromLink() : this.load() },
  onHide() { this.loadToken = (this.loadToken || 0) + 1; this.memoryHidden = true; this.closeConfirmation(); this.keepForm(); this.keepMemoryDraft(); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload() },
  onUnload() { this.loadToken = (this.loadToken || 0) + 1; this.closeConfirmation(); this.keepForm(); this.keepMemoryDraft(); this.memoryUnloaded = true; this.photoLoadToken++ },
  async withCovers(meal) {
    if (!meal) return null
    // ponytail: at most 20 dishes; batch cover lookup if a meal grows beyond that limit.
    const recipes = await Promise.all((meal.items || []).map(item => item.recipeId
      ? request('getRecipe', { id: item.recipeId }).catch(() => null) : null))
    const covers = recipes.map(recipe => recipe && recipe.coverFileId || '')
    let recordPhotosError = false
    const records = []
    try {
      for (let offset = 0; ; offset += 50) {
        const batch = await request('listRecords', { mealId: meal.id, offset })
        records.push(...batch)
        if (batch.length < 50) break
      }
    } catch (_) { recordPhotosError = true }
    const matching = meal.items.map(item => records.find(record => record.id === item.recordId) || records.find(record =>
      record.mealItemId === item.id || (item.wishId ? record.wishId === item.wishId : !!item.recipeId && record.recipeId === item.recipeId && !record.wishId)))
    const photoFileIds = [...new Set([...records.flatMap(record => photoRefs(record.photoFileIds)),
      ...(recordPhotosError ? meal.items.flatMap(item => photoRefs(item.photoFileIds)) : [])])]
    const urls = await mediaUrls([...covers, ...photoFileIds]).catch(() => ({}))
    return { ...meal, recordPhotosError,
      items: meal.items.map((item, index) => {
        const record = matching[index]
        const photos = [...new Set([...(record ? photoRefs(record.photoFileIds) : []),
          ...(recordPhotosError ? photoRefs(item.photoFileIds) : [])])]
        const photoUrls = photos.map(fileId => urls[fileId]).filter(Boolean)
        return { ...item, coverFileId: covers[index], coverUrl: urls[covers[index]] || '',
          coverError: !!item.recipeId && !recipes[index] || !!covers[index] && !urls[covers[index]],
          recordId: item.recordId || record && record.id || '', photoFileIds: photos, photoUrls,
          photoError: !!photos.length && !photoUrls.length,
          photoUrl: photoUrls[0] || '' }
      }) }
  },
  imageError(e) {
    if (!this.data.meal) return
    const { id, kind, fileId, url } = e.currentTarget.dataset
    if (kind === 'cover') this.setData({ 'meal.items': this.data.meal.items.map(item => item.id === id && item.coverUrl === url ? { ...item, coverError: true } : item) })
    else if (kind === 'record') this.setData({ 'meal.items': this.data.meal.items.map(item => item.id === id && item.photoUrl === url ? { ...item, photoError: true } : item) })
  },
  async retryPhotos() {
    if (this.data.photosLoading || !this.data.meal) return
    const meal = this.data.meal
    this.setData({ photosLoading: true })
    try {
      const updated = await this.withCovers(meal)
      if (!this.data.meal || this.data.meal.id !== meal.id || this.data.meal.version !== meal.version) return
      this.setData({ 'meal.items': updated.items, 'meal.recordPhotosError': updated.recordPhotosError })
      if (updated.recordPhotosError || updated.items.some(item => item.coverError || item.photoError)) alert(new Error('部分照片暂时无法加载，请稍后重试'))
    } catch (error) { alert(error) }
    finally { this.setData({ photosLoading: false }) }
  },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, loadReady: false, error: '', successNote: '' })
    try {
      const context = await request('bootstrap')
      if (token !== this.loadToken) return
      this.context = context
      if (!this.context.space || !this.context.member) throw new Error('请先加入厨房')
      this.formDraftKey = `mealForm:${this.context.space.id}:${this.context.member.id}:${this.data.recordMode && !this.id ? 'new' : this.id || this.context.space.currentMealId || 'new'}`
      if (this.data.recordMode && !this.id) return this.loadNewRecord()
      const id = this.id || this.context.space.currentMealId
      this.syncTitle()
      let meal = id ? await request('getMeal', { id }) : null
      if (token !== this.loadToken) return
      // Older links can still point at the meal form; completed meals share one viewing page.
      if (meal && meal.status === 'completed' && !this.data.recordMode) {
        this.id = meal.id
        navigate(this, 'redirectTo', `/pages/menu-preview/index?id=${meal.id}&from=list`, () => {
          this.setData({ loading: false, error: 'Menu 未打开，点此重试' })
        })
        return
      }
      meal = await this.withCovers(meal)
      if (token !== this.loadToken) return
      if (this.albumChoosing || this.data.memoryDirty) { this.setData({ loading: false }); return }
      if (meal) this.id = meal.id
      const draft = getApp().globalData.mealDraftReturn
      const restore = meal && draft && draft.mealId === meal.id && meal.status === 'draft' ? draft : null
      if (restore) getApp().globalData.mealDraftReturn = null
      this.setData({ meal, title: restore ? restore.title : meal ? meal.title : '一起开饭',
        date: restore ? restore.date : meal ? meal.date : formatDate(new Date()),
        diners: restore ? restore.diners : String(meal ? meal.diners : 2), note: restore ? restore.note : meal ? meal.note : '',
        photos: photoItems(meal && meal.photoFileIds), reflection: meal && meal.reflection || '',
        memoryDirty: false, status: meal ? meal.status : 'draft', openId: '' })
      if (meal) {
        this.formBase = { title: meal.title, date: meal.date, diners: String(meal.diners), note: meal.note || '' }
        if (this.data.recordMode) this.recordItemsBase = meal.items
        this.restoreForm()
        await this.initMemoryDraft(meal)
        if (token !== this.loadToken) return
        if (this.data.recordMode) this.rebaseRecord(meal)
      }
      this.setData({ loading: false, loadReady: true })
      this.syncTitle()
      if (meal) await this.retryImages()
    } catch (error) { if (token === this.loadToken && !this.albumChoosing && !this.data.memoryDirty) this.setData({ loading: false, error: error.message }) }
  },
  async addFromLink() {
    const pending = this.pendingAdd
    this.pendingAdd = null
    try {
      const data = await memberSpace()
      if (!data) return
      this.syncTitle()
      const source = pending.recipeId
        ? await request('getRecipe', { id: pending.recipeId })
        : await request('getWish', { id: pending.wishId })
      const meal = await request('addMealItem', { mealId: this.id, requestId: requestId(), item: {
        recipeId: pending.recipeId || source.recipeId || '', wishId: pending.wishId && source.status === 'open' ? pending.wishId : '',
        name: source.name || source.title, state: 'planned' } })
      this.id = meal.id
      await this.load()
    } catch (error) { this.pendingAdd = pending; this.setData({ loading: false, error: error.message }); alert(error) }
  },
  keepForm() {
    this.syncTitle()
    if (this.discardForm || !this.formDraftKey || !this.data.meal) return
    const values = { title: this.data.title, date: this.data.date, diners: this.data.diners, note: this.data.note }
    const dirty = Object.keys(values).some(key => values[key] !== (this.formBase || {})[key]) || this.recordItemsDirty || !!this.data.pendingEatingPayload || !!this.pendingMealSave
    this.setData({ formDirty: !!dirty })
    try {
      if (dirty || this.data.recordMode && !this.id) wx.setStorageSync(this.formDraftKey, { ...values, base: this.formBase,
        pendingMeal: this.pendingMealSave || null, ...(this.data.recordMode ? { ...(this.recordItemsDirty || !this.id ? { items: this.data.meal.items, itemsBase: this.recordItemsBase } : {}), requestId: this.newRecordRequest, pending: this.data.pendingEatingPayload } : {}) })
      else wx.removeStorageSync(this.formDraftKey)
      if (this.data.recordMode && !this.memoryHidden && (dirty || this.data.memoryDirty) && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '修改还没保存，离开后会留在本机草稿' })
    } catch (_) { alert(new Error('本机暂存失败，请留在本页重试')) }
  },
  restoreForm() {
    const draft = this.formDraftKey && wx.getStorageSync(this.formDraftKey)
    if (!draft) return
    const restored = {}
    let conflict = false
    for (const key of ['title', 'date', 'diners', 'note']) {
      if (draft[key] == null || draft.base && draft[key] === draft.base[key]) continue
      restored[key] = draft[key]
      if (draft.base && this.formBase[key] !== draft.base[key] && this.formBase[key] !== draft[key]) conflict = true
    }
    if (this.data.recordMode && draft.base) this.formBase = draft.base
    if (this.data.recordMode && draft.items) { restored['meal.items'] = draft.items; this.recordItemsDirty = true; this.recordItemsBase = draft.itemsBase || this.recordItemsBase }
    this.pendingMealSave = !this.data.recordMode && draft.pendingMeal || null
    this.setData({ ...restored, formDirty: true, pendingMealPayload: this.pendingMealSave, pendingEatingPayload: draft.pending || null,
      ...(conflict ? { successNote: '伙伴也改了安排，草稿已保留，请核对后保存' } : {}) })
  },
  syncTitle() {
    const pageTitle = (this.data.title || '').trim() || '这顿饭'
    if (this.data.pageTitle !== pageTitle) this.setData({ pageTitle })
    setSpaceTitle(pageTitle)
  },
  chooseRecipe() {
    if (!this.data.meal || this.data.saving || this.pendingMealSave || ['completed', 'cancelled'].includes(this.data.status)) return
    this.keepForm()
    navigate(this, 'navigateTo', `/pages/menu-picker/index?mealId=${this.data.meal.id}`)
  },
  chooseWish() {
    if (!this.data.meal || this.data.saving || this.pendingMealSave || ['completed', 'cancelled'].includes(this.data.status)) return
    this.keepForm()
    getApp().globalData.mealWishContext = { mealId: this.data.meal.id, spaceId: this.data.meal.spaceId,
      draft: { mealId: this.data.meal.id, title: this.data.title, date: this.data.date,
        diners: this.data.diners, note: this.data.note } }
    navigate(this, 'navigateTo', `/pages/wish-picker/index?mealId=${this.data.meal.id}`, () => { getApp().globalData.mealWishContext = null })
  },
  remove(e) {
    const meal = this.data.meal
    if (!meal || this.data.saving || ['completed', 'cancelled'].includes(this.data.status)) return
    const item = meal.items.find(entry => entry.id === e.currentTarget.dataset.id)
    if (!item) return
    wx.showModal({ title: `移出“${item.name}”？`, content: '只从这顿饭移出，菜品、心愿和已有记录都会保留',
      confirmText: '移出饭单', success: ({ confirm }) => { if (confirm) this.removeItem(item.id) } })
  },
  removeItem(itemId) {
    if (this.data.saving || this.pendingMealSave) return
    this.setData({ saving: true, successNote: '' })
    return withLoading(() => request('removeMealItem', { mealId: this.id, itemId, requestId: requestId() }))
      .then(updated => { const form = { title: this.data.title, date: this.data.date, diners: this.data.diners, note: this.data.note }; this.applyMeal(updated); this.setData(form); this.keepForm(); this.setData({ openId: '' }) })
      .catch(error => { this.setData({ openId: '' }); alert(error) }).finally(() => this.setData({ saving: false }))
  },
  applyMeal(meal) {
    this.id = meal.id
    if (getApp().globalData.mealDraftReturn && getApp().globalData.mealDraftReturn.mealId === meal.id) getApp().globalData.mealDraftReturn = null
    const previous = this.data.meal
    const displayed = new Map((previous && previous.items || []).map(item => [item.id, item]))
    const shown = { ...meal,
      recordPhotosError: !!(previous && previous.id === meal.id && previous.recordPhotosError),
      items: meal.items.map(item => ({ ...displayed.get(item.id), ...item })) }
    this.setData({ meal: shown, title: meal.title, date: meal.date, diners: String(meal.diners), note: meal.note, status: meal.status, openId: '' })
  },
  onTitle(e) { if (this.data.saving || this.data.pendingEatingPayload || this.pendingMealSave) return; this.setData({ title: e.detail.value }); this.keepForm() },
  onDate(e) { if (this.data.saving || this.data.pendingEatingPayload || this.pendingMealSave) return; this.setData({ date: e.detail.value }); this.keepForm() },
  onDiners(e) { if (this.data.saving || this.data.pendingEatingPayload || this.pendingMealSave) return; this.setData({ diners: e.detail.value }); this.keepForm() },
  onNote(e) { if (this.data.saving || this.data.pendingEatingPayload || this.pendingMealSave) return; this.setData({ note: e.detail.value }); this.keepForm() },
  saveCurrent() { return this.save(this.data.status).then(meal => { if (meal) navigate(this, 'switchTab', '/pages/menu/index') }) },
  save(status = this.data.status, items = this.data.meal ? this.data.meal.items : [], action = 'save') {
    if (this.data.saving) return Promise.resolve()
    const diners = Number(this.data.diners)
    if (!Number.isInteger(diners) || diners < 1 || diners > 20) {
      wx.showToast({ title: '用餐人数需为 1 到 20 人', icon: 'none' })
      return Promise.resolve()
    }
    if (!items.length && status !== 'cancelled') {
      wx.showToast({ title: '先选择至少一道菜', icon: 'none' })
      return Promise.resolve()
    }
    const payload = this.pendingMealSave || { requestId: requestId(), title: this.data.title.trim() || '一起开饭', date: this.data.date, diners,
      note: this.data.note.trim(), items: items.map(item => ({ id: item.id, recipeId: item.recipeId,
        wishId: item.wishId, name: item.name, state: item.state })), status }
    if (this.pendingMealSave && status !== payload.status) { alert(new Error('上次保存结果尚未确认，请先重试原操作')); return Promise.resolve() }
    if (this.id && !this.pendingMealSave) { payload.id = this.id; payload.version = this.data.meal.version }
    this.pendingMealSave = payload
    const painted = new Promise(resolve => this.setData({ saving: true, savingAction: action, pendingMealPayload: payload, successNote: '' }, resolve))
    this.keepForm()
    const matches = latest => latest && latest.version > payload.version && latest.status === payload.status && latest.title === payload.title &&
      latest.date === payload.date && latest.diners === payload.diners && latest.note === payload.note &&
      latest.items.length === payload.items.length && latest.items.every((item, index) =>
        item.id === payload.items[index].id && item.state === payload.items[index].state)
    const conflict = () => { const error = new Error('饭单已被另一位成员修改，请刷新后重试'); error.code = 'VERSION_CONFLICT'; return error }
    return painted.then(() => withLoading(async () => {
      try { return await request('saveMeal', payload) } catch (error) {
        if (!payload.id || error.code && error.code !== 'SERVER_ERROR') throw error
        let latest
        try { latest = await request('getMeal', { id: payload.id }) } catch { throw error }
        if (matches(latest)) return latest
        if (!latest || latest.version !== payload.version) throw conflict()
        try { return await request('saveMeal', payload) } catch (retryError) {
          try { latest = await request('getMeal', { id: payload.id }) } catch { throw retryError }
          if (matches(latest)) return latest
          if (!latest || latest.version !== payload.version) throw conflict()
          throw retryError
        }
      }
    })).then(meal => {
      this.pendingMealSave = null
      this.applyMeal(meal)
      if (this.formDraftKey) wx.removeStorageSync(this.formDraftKey)
      this.formBase = { title: meal.title, date: meal.date, diners: String(meal.diners), note: meal.note || '' }
      this.setData({ formDirty: false, pendingMealPayload: null })
      return meal
    }).catch(error => {
      if (error.code && error.code !== 'SERVER_ERROR') { this.pendingMealSave = null; this.setData({ pendingMealPayload: null }) }
      this.keepForm()
      alert(error)
      if (!error.code || error.code === 'SERVER_ERROR') this.setData({ successNote: '保存结果待确认，输入已保留，请重试核对' })
      if (error.code === 'VERSION_CONFLICT') this.setData({ error: '伙伴改了饭单，你的输入还在，请核对后刷新' })
    }).finally(() => this.setData({ saving: false, savingAction: '' }))
  },
  confirm() { return this.save('confirmed', this.data.meal ? this.data.meal.items : [], 'confirm').then(meal => {
    if (!meal) return
    if (this.memoryHidden || this.memoryUnloaded) return
    clearTimeout(this.confirmationTimer)
    this.setData({ confirmationVisible: true, confirmationParticles: celebrationParticles(), successNote: '' })
    this.confirmationTimer = setTimeout(() => this.setData({ confirmationParticles: [] }), 1250)
  }) },
  closeConfirmation() { clearTimeout(this.confirmationTimer); this.setData({ confirmationVisible: false, confirmationParticles: [] }) },
  viewConfirmed() { navigate(this, 'navigateTo', `/pages/record-list/index?kind=meals&mealId=${this.id}`) },
  stopConfirmationScroll() {},
  unconfirm() { return this.save('draft', this.data.meal.items, 'unconfirm') },
  complete() {
    if (this.savedMealId) return this.openSavedRecord()
    if (this.data.saving || !this.data.meal) return
    if (!this.data.meal.items.length) return alert(new Error('先选择至少一道菜'))
    wx.showModal({ title: '把这一顿收进回忆吧',
      content: '饭单里的菜会一起完成并记下，照片和心得随时回来补',
      confirmText: '收进记录', cancelText: '先等等', success: ({ confirm }) => { if (confirm) this.save('completed', this.data.meal.items.map(item => ({ ...item, state: 'cooked' })), 'complete').then(meal => {
        if (meal) openMealDetail(this, meal, true)
      }) } })
  },
  cancel() {
    if (!this.data.meal || this.data.saving) return
    wx.showModal({ title: '取消这顿饭？', content: '饭单会保留，以后还能恢复', confirmText: '取消饭单',
      success: ({ confirm }) => confirm && this.save('cancelled', this.data.meal.items, 'cancel').then(meal => { if (meal) { getApp().globalData.mealWishContext = null; if (this.formDraftKey) wx.removeStorageSync(this.formDraftKey); navigate(this, 'switchTab', '/pages/menu/index') } }) })
  },
  reopen() {
    const meal = this.data.meal
    if (!meal) return
    if (this.data.memoryDirty) return alert(new Error('请先保存这顿饭的照片和心得，再撤销完成'))
    const cancelled = meal.status === 'cancelled'
    wx.showModal({ title: cancelled ? '恢复饭单？' : '撤销完成？', content: cancelled ? '饭单会回到待确认，已有做菜记录会保留' : '饭单会回到待开饭，已有做菜记录会保留', confirmText: cancelled ? '恢复饭单' : '撤销完成', success: ({ confirm }) => {
      if (!confirm) return
      withLoading(() => request('reopenMeal', { id: meal.id, version: meal.version }))
        .then(updated => this.applyMeal(updated)).catch(alert)
    } })
  },
  mark(e) {
    if (this.data.status !== 'confirmed' || this.data.saving || this.pendingMealSave) return
    const { id } = e.currentTarget.dataset
    const previous = this.data.meal.items
    const items = previous.map(item => item.id === id ? { ...item, state: item.state === 'cooked' ? 'planned' : 'cooked' } : item)
    this.setData({ 'meal.items': items })
    return this.save('confirmed', items, 'mark').then(meal => { if (!meal) this.setData({ 'meal.items': previous }) })
  },
  async photo(e) {
    if (this.data.photoSaving || this.data.status !== 'completed') return
    let item = this.data.meal.items.find(entry => entry.id === e.currentTarget.dataset.id)
    if (!item || item.state !== 'cooked') return
    if (item.photoError || this.data.meal.recordPhotosError) {
      await this.retryPhotos()
      item = this.data.meal.items.find(entry => entry.id === e.currentTarget.dataset.id)
      if (!item || item.photoError || this.data.meal.recordPhotosError) return
    }
    if (item.photoFileIds && item.photoFileIds.length) {
      return wx.showActionSheet({ itemList: ['查看照片', '继续添加'], success: async ({ tapIndex }) => {
        if (tapIndex !== 0) return this.addPhoto(item)
        if (!item.photoUrls || item.photoUrls.length !== item.photoFileIds.length) {
          await this.retryPhotos()
          item = this.data.meal.items.find(entry => entry.id === item.id)
        }
        if (!item || !item.photoUrls || item.photoUrls.length !== item.photoFileIds.length) return alert(new Error('照片尚未全部加载，请重试失败照片'))
        if (item.photoUrls.length) wx.previewImage({ current: item.photoUrl, urls: item.photoUrls })
      } })
    }
    return this.addPhoto(item)
  },
  async addPhoto(item) {
    if (this.data.photoSaving) return
    this.setData({ photoSaving: true })
    let fileId = ''
    try {
      const chosen = await chooseImage()
      const uploaded = await withLoading(() => uploadImage(chosen.tempFilePath))
      fileId = uploaded.fileId
      const result = await withLoading(() => request('addMealItemPhoto', { mealId: this.id, itemId: item.id, fileId }))
      const items = this.data.meal.items.map(entry => entry.id === item.id ? { ...entry,
        recordId: result.record.id, photoFileIds: result.record.photoFileIds,
        photoUrls: [...(entry.photoUrls || []), chosen.tempFilePath], photoUrl: chosen.tempFilePath, photoError: false } : entry)
      this.setData({ 'meal.items': items, 'meal.version': result.mealVersion })
      wx.showToast({ title: '照片已记录' })
    } catch (error) {
      if (fileId) {
        const linked = await request('listRecords', { mealId: this.id }).then(records =>
          records.some(record => (record.photoFileIds || []).includes(fileId))).catch(() => false)
        if (linked) {
          this.applyMeal(await request('getMeal', { id: this.id }))
          await this.retryPhotos()
          wx.showToast({ title: '照片已记录' })
          return
        }
        await request('discardMedia', { fileId }).catch(() => {})
      }
      if (!error.errMsg || !error.errMsg.includes('cancel')) alert(error)
    } finally { this.setData({ photoSaving: false }) }
  },
  async addAgain(e) {
    const item = this.data.meal.items.find(entry => entry.id === e.currentTarget.dataset.id)
    if (!item) return
    try {
      const data = await memberSpace()
      if (!data) return
      setSpaceTitle('这一顿饭')
      selection.configure(data)
      const source = { recipeId: item.recipeId || '', name: item.name }
      if (item.wishId) {
        const wish = await request('getWish', { id: item.wishId })
        source.recipeId = source.recipeId || wish.recipeId || ''
        if (wish.status === 'open' && wish.recipeId === source.recipeId) source.wishId = wish.id
      }
      if (!source.recipeId) {
        navigate(this, 'navigateTo', `/pages/recipe-edit/index?mode=wish&wishId=${item.wishId}`)
        return wx.showToast({ title: '先补全这条心愿的菜品资料', icon: 'none' })
      }
      selection.add(source)
      navigate(this, 'switchTab', '/pages/menu/index')
      wx.showToast({ title: '已选中，继续挑菜', icon: 'none' })
    } catch (error) { alert(error) }
  },
})
