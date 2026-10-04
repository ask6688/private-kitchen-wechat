const { request, alert, withLoading, formatDate } = require('../../utils/api')
const { uploadImage } = require('../../utils/upload')
const { navigate, openMealDetail } = require('../../utils/navigation')
const itemValues = items => JSON.stringify((items || []).map(({ id, name, state }) => ({ id, name, state })))
const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
module.exports = {
  loadNewRecord() {
    const draft = wx.getStorageSync(this.formDraftKey)
    const meal = { id: '', spaceId: this.context.space.id, version: 0, title: '一起吃饭', date: formatDate(new Date()), diners: 2,
      note: '', status: 'completed', items: [], photoFileIds: [], reflection: '' }
    this.formBase = { title: meal.title, date: meal.date, diners: '2', note: '' }
    this.newRecordRequest = draft && draft.requestId || newId()
    this.memoryDraftKey = `mealMemory:${this.context.space.id}:${this.context.member.id}:new`
    const memory = wx.getStorageSync(this.memoryDraftKey)
    this.memoryBase = { photoFileIds: [], reflection: '' }
    this.setData({ meal, status: 'completed', title: meal.title, date: meal.date, diners: '2', note: '',
      photos: memory && memory.photos ? require('../../utils/photos').photoItems(memory.photos).map((photo, i) => ({ ...photo, ...memory.photos[i], url: memory.photos[i].localPath || '' })) : [],
      reflection: memory && memory.reflection || '', loading: false, loadReady: true })
    this.restoreForm()
    this.keepMemoryDraft()
    return this.retryImages()
  },
  cancelRecordEdit() {
    if (this.data.saving || this.data.pendingEatingPayload) return alert(new Error('保存结果待确认，请先核对并重试'))
    const leave = async () => {
      if (this.id) await this.cancelMemory()
      else { this.removeMemoryLocal(this.data.photos); wx.removeStorageSync(this.memoryDraftKey) }
      wx.removeStorageSync(this.formDraftKey)
      this.discardForm = true
      this.setData({ formDirty: false, memoryDirty: false }); this.recordItemsDirty = false
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload()
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      navigate(this, pages.length > 1 ? 'navigateBack' : 'redirectTo', pages.length > 1 ? '' : '/pages/record-list/index?kind=meals')
    }
    if (this.data.formDirty || this.data.memoryDirty) wx.showModal({ title: '放弃本次修改？', content: '已保存的记录会保留', success: ({ confirm }) => { if (confirm) leave().catch(alert) } })
    else return leave().catch(alert)
  },
  onNewDish(e) { this.setData({ newDishName: e.detail.value }) },
  addActualDish() {
    if (this.data.saving || this.data.pendingEatingPayload || this.data.actualSource) return
    wx.showActionSheet({ itemList: ['从菜单导入', '从心愿单导入', '自定义新增'], success: ({ tapIndex }) => {
      this.setData({ actualSource: ['recipes', 'wishes', 'custom'][tapIndex], actualChoices: [], actualOffset: 0, actualMore: false, actualError: '', newDishName: '' })
      if (tapIndex !== 2) this.loadActualChoices()
    } })
  },
  closeActualSource() { if (!this.data.actualLoading) this.setData({ actualSource: '' }) },
  stopActualScroll() {},
  async loadActualChoices() {
    if (this.data.actualLoading || !['recipes', 'wishes'].includes(this.data.actualSource)) return
    const kind = this.data.actualSource, offset = this.data.actualOffset || 0
    this.setData({ actualLoading: true, actualError: '' })
    try {
      const rows = await request(kind === 'recipes' ? 'listRecipes' : 'listWishes', { offset, ...(kind === 'wishes' ? { status: 'open' } : {}) })
      if (this.data.actualSource !== kind) return
      this.setData({ actualChoices: [...this.data.actualChoices, ...rows.map(row => ({ id: row.id, name: row.name || row.title,
        recipeId: kind === 'recipes' ? row.id : row.recipeId || '', wishId: kind === 'wishes' ? row.id : '' }))],
        actualOffset: offset + rows.length, actualMore: rows.length === 50 })
    } catch (error) { this.setData({ actualError: error.message }) }
    finally { this.setData({ actualLoading: false }) }
  },
  selectActualDish(e) {
    const choice = this.data.actualChoices.find(item => item.id === e.currentTarget.dataset.id)
    if (choice) this.appendActualDish(choice)
  },
  addCustomActual() {
    const name = this.data.newDishName.trim()
    if (!name) return alert(new Error('先写下这道菜的名字吧'))
    this.appendActualDish({ name, recipeId: '', wishId: '', addToMenu: true })
  },
  appendActualDish(choice) {
    if (this.data.saving || this.data.pendingEatingPayload) return
    if (this.data.meal.items.length >= 20) return alert(new Error('一顿最多 20 道菜'))
    if (this.data.meal.items.some(item => choice.recipeId ? item.recipeId === choice.recipeId : choice.wishId ? item.wishId === choice.wishId : item.name === choice.name)) return alert(new Error('这道菜已经在本餐里啦'))
    this.setData({ 'meal.items': [...this.data.meal.items, { ...choice, id: newId(), state: 'eaten', category: '' }], newDishName: '', actualSource: '' })
    this.recordItemsDirty = true
    this.keepForm()
  },
  removeActualDish(e) {
    if (this.data.saving || this.data.pendingEatingPayload) return
    this.setData({ 'meal.items': this.data.meal.items.filter(item => item.id !== e.currentTarget.dataset.id) })
    this.recordItemsDirty = true
    this.keepForm()
  },
  rebaseRecord(latest) {
    const conflicts = [], values = {}, labels = { title: '饭名', date: '日期', diners: '人数', note: '安排备注', items: '菜品' }
    for (const key of ['title', 'date', 'diners', 'note']) {
      const remote = key === 'diners' ? String(latest[key]) : latest[key] || ''
      if (String(this.data[key]) !== String(this.formBase[key]) && remote !== this.formBase[key] && remote !== this.data[key]) conflicts.push(key)
      else {
        if (String(this.data[key]) === String(this.formBase[key])) values[key] = remote
        this.formBase[key] = remote
      }
    }
    if (this.recordItemsDirty && itemValues(latest.items) !== itemValues(this.recordItemsBase) && itemValues(latest.items) !== itemValues(this.data.meal.items)) conflicts.push('items')
    if (!this.recordItemsDirty) values['meal.items'] = latest.items
    this.recordRemote = latest
    this.setData({ ...values, 'meal.version': latest.version, status: latest.status, recordConflictFields: conflicts,
      ...(conflicts.length ? { successNote: `伙伴也修改了${conflicts.map(key => labels[key]).join('、')}，你的修改还在，保存前请核对` } : {}) })
    this.keepForm()
  },
  resolveRecordFields() {
    const fields = this.data.recordConflictFields || [], latest = this.recordRemote
    if (!fields.length || !latest) return
    wx.showModal({ title: '选择保留哪份修改', content: `${this.data.successNote}\n最新饭名：${latest.title}；日期：${latest.date}；人数：${latest.diners}；菜品：${latest.items.map(item => item.name).join('、')}`,
      confirmText: '保留我的', cancelText: '用伙伴的', success: ({ confirm }) => {
        const values = { recordConflictFields: [], successNote: '已保留你的选择，保存后生效' }
        for (const key of fields) {
          if (key === 'items') { if (!confirm) { values['meal.items'] = latest.items; this.recordItemsDirty = false } }
          else { this.formBase[key] = key === 'diners' ? String(latest[key]) : latest[key] || ''; if (!confirm) values[key] = this.formBase[key] }
        }
        this.recordItemsBase = latest.items
        this.setData(values); this.keepForm()
      } })
  },
  openSavedRecord() { if (this.savedMealId) openMealDetail(this, { id: this.savedMealId, status: 'completed' }, !!this.completionToken) },
  async saveEating() {
    if (this.savedMealId) return this.openSavedRecord()
    if (this.data.saving || this.data.memorySaving || this.albumChoosing) return
    if ((this.data.recordConflictFields || []).length) return this.resolveRecordFields()
    if (this.data.memoryConflictPhotos || this.data.memoryConflictReflection) return alert(new Error('请先核对伙伴修改的照片或心得'))
    if (this.data.status !== 'completed') return alert(new Error('伙伴改了这顿饭的状态，草稿已保留，请返回核对'))
    const diners = Number(this.data.diners)
    if (!Number.isInteger(diners) || diners < 1 || diners > 20) return alert(new Error('用餐人数需为 1 到 20 人'))
    if (!this.id && !this.data.meal.items.length) return alert(new Error('请填写至少一道实际吃过的菜'))
    this.setData({ saving: true })
    try {
      await withLoading(async () => {
        if (!this.data.pendingEatingPayload) {
          for (const photo of this.data.photos) {
            if (photo.fileId || !photo.localPath) continue
            if (!photo.uploadRequestId) photo.uploadRequestId = newId()
            if (!this.keepMemoryDraft()) throw new Error('草稿暂存失败，请留在本页重试')
            const uploaded = await uploadImage(photo.localPath, photo.uploadRequestId)
            this.setData({ photos: this.data.photos.map(item => item.key === photo.key ? { ...item, fileId: uploaded.fileId } : item) })
            this.keepMemoryDraft()
          }
          const fields = { title: this.data.title.trim() || '一起吃饭', date: this.data.date, diners,
            note: this.data.note.trim(), ...this.memoryPatch() }
          if (this.id) for (const key of ['title', 'date', 'diners', 'note']) {
            if (String(fields[key]) === String(this.formBase[key])) delete fields[key]
          }
          if (!this.id || this.recordItemsDirty) fields.items = this.data.meal.items.map(({ id, name, recipeId, wishId, state, addToMenu }) => ({ id, name, recipeId, wishId, state, ...(addToMenu ? { addToMenu: true } : {}) }))
          this.setData({ pendingEatingPayload: { ...fields, ...(this.id ? { id: this.id, version: this.data.meal.version } : {}), requestId: this.id ? newId() : this.newRecordRequest } })
        }
        this.keepForm(); this.keepMemoryDraft()
        const meal = await request('saveEatingMeal', this.data.pendingEatingPayload)
        const wasNew = !this.id
        this.id = meal.id; this.recordItemsDirty = false
        this.formBase = { title: meal.title, date: meal.date, diners: String(meal.diners), note: meal.note || '' }
        this.setData({ title: meal.title, date: meal.date, diners: String(meal.diners), note: meal.note || '', pendingEatingPayload: null, formDirty: false })
        wx.removeStorageSync(this.formDraftKey)
        await this.finishMemory(meal)
        wx.removeStorageSync(this.formDraftKey)
        this.savedMealId = meal.id
        if (this.returnToDetail) {
          const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
          const previous = pages[pages.length - 2]
          if (previous && previous.route === 'pages/menu-preview/index' && previous.id === meal.id) navigate(this, 'navigateBack', '', () => this.setData({ openSaved: true, error: '记录已保存，点此打开详情' }))
          else openMealDetail(this, meal)
        } else openMealDetail(this, meal, wasNew)
      })
    } catch (error) {
      if (error.code && error.code !== 'SERVER_ERROR') this.setData({ pendingEatingPayload: null })
      if (error.code === 'VERSION_CONFLICT' && this.id) {
        try { const latest = await request('getMeal', { id: this.id }); const items = this.data.meal.items; this.rebaseMemory(latest); if (this.recordItemsDirty) this.setData({ 'meal.items': items }); this.rebaseRecord(latest) } catch (refreshError) { alert(refreshError) }
      }
      this.keepForm(); this.keepMemoryDraft()
      if (error.code !== 'VERSION_CONFLICT') this.setData({ successNote: !error.code || error.code === 'SERVER_ERROR' ? '保存结果待确认，输入已保留，再次保存会核对结果' : error.message })
      alert(error)
    } finally { this.setData({ saving: false }) }
  },
}
