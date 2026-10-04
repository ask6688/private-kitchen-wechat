const { request, alert, memberSpace, setSpaceTitle, mediaUrls, formatDate } = require('../../utils/api')
const { navigate } = require('../../utils/navigation')
const { photoRefs } = require('../../utils/photos')
const swipeHandlers = require('../../utils/swipe')

const statusLabels = { draft: '待确认', confirmed: '待开饭', completed: '已完成' }

function withPhotos(item, fileIds, previous = []) {
  const photos = [...new Set(fileIds)].map(fileId => previous.find(photo => photo.fileId === fileId) || { fileId, key: fileId, url: '', state: 'loading' })
  return { ...item, photos, photoCount: photos.length, previewPhotos: photos.slice(0, 3), photoUrl: photos[0] && photos[0].url || '' }
}

module.exports = {
  ...swipeHandlers,
  data: {
    mode: '', timeline: [], records: [], meals: [], currentMealId: '',
    recordOffset: 0, mealOffset: 0, moreRecords: true, moreMeals: true,
    loading: true, starting: false, error: '', showRecordMenu: false, highlightMealId: '',
    openId: '', openingKey: '', deleteTarget: null, deleting: false, deleteError: '', editing: false, selectedKeys: [],
  },
  onLoad(options = {}) {
    this.setData({ mode: ['cooking', 'meals'].includes(options.kind) ? options.kind : 'all', highlightMealId: options.kind === 'meals' ? options.mealId || '' : '' })
  },
  onShow() { this.hidden = false; this.swipeMoved = false; this.setData({ starting: false }); this.closeRecordMenu(); if (!this.data.deleting) return this.refresh() },
  onHide() { this.hidden = true; this.closeRecordMenu(); this.setData({ openId: '', openingKey: '', deleteTarget: null, deleteError: '', editing: false, selectedKeys: [] }); this.loadToken = (this.loadToken || 0) + 1 },
  onUnload() { this.onHide(); this.unloaded = true },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() {
    if (this.data.mode === 'cooking' && this.data.moreRecords || this.data.mode === 'meals' && this.data.moreMeals) return this.load(false)
  },
  refresh() {
    if (this.data.deleting) return Promise.resolve()
    setSpaceTitle(this.data.mode === 'cooking' ? '做一道菜' : this.data.mode === 'meals' ? '一起吃饭' : '记录')
    return this.load(true, true)
  },
  retry() { return this.refresh() },
  more() { return this.load(false) },
  async load(reset = true, restoreSpace = false) {
    if (this.data.loading && !reset) return
    const token = this.loadToken = (this.loadToken || 0) + 1
    const mode = this.data.mode
    this.setData({ loading: true, error: '', ...(reset ? { timeline: [], records: [], meals: [], openingKey: '' } : {}), ...(restoreSpace ? { currentMealId: '' } : {}) })
    try {
      const recordOffset = reset ? 0 : this.data.recordOffset
      let mealOffset = reset ? 0 : this.data.mealOffset
      let moreMeals = mode !== 'cooking' && (reset || this.data.moreMeals)
      const [spaceData, newRecords, newMeals] = await Promise.all([
        restoreSpace ? memberSpace() : null,
        mode !== 'meals' && (reset || this.data.moreRecords) ? request('listRecords', { offset: recordOffset }) : [],
        (async () => {
          if (!moreMeals) return []
          // Cancelled-only pages must not hide older, visible meals behind an empty screen.
          while (true) {
            const batch = await request('listMeals', { offset: mealOffset })
            mealOffset += batch.length
            moreMeals = batch.length === 50
            const visible = batch.filter(item => item.status !== 'cancelled')
            if (visible.length || !moreMeals || token !== this.loadToken) return visible
          }
        })(),
      ])
      if (token !== this.loadToken) return
      if (restoreSpace) {
        if (!spaceData) { this.setData({ loading: false }); return }
        setSpaceTitle(mode === 'cooking' ? '做一道菜' : mode === 'meals' ? '一起吃饭' : '记录')
        this.setData({ currentMealId: spaceData.space.currentMealId || '' })
      }
      const records = (reset ? [] : this.data.records).concat(newRecords)
      const meals = [...new Map((reset ? [] : this.data.meals).concat(newMeals).map(item => [item.id, item])).values()]
      if (reset || newMeals.some(item => item.id === this.extraMealId)) this.extraMealId = ''
      if (reset && this.data.highlightMealId && !meals.some(item => item.id === this.data.highlightMealId)) {
        const target = await request('getMeal', { id: this.data.highlightMealId })
        if (token !== this.loadToken) return
        if (target.status !== 'cancelled') { meals.push(target); this.extraMealId = target.id }
      }
      const previous = new Map(this.data.timeline.map(item => [item.key, item.photos]))
      const cooking = records.map(item => withPhotos({ ...item, key: `record:${item.id}`, kind: 'record',
        kindLabel: item.makerName ? `${item.makerName}做的菜` : '做菜记录',
        name: item.name || '一道家常菜',
        dateLabel: formatDate(item.date || item.createdAt), sortDate: new Date(item.date || item.createdAt || 0).getTime() || 0 },
      photoRefs(item.photoFileIds), previous.get(`record:${item.id}`)))
      const eating = meals.map(item => {
        const dishes = item.status === 'completed' ? item.menuSnapshot ? item.menuSnapshot.groups.flatMap(group => group.items) : (item.items || []).filter(dish => ['cooked', 'eaten'].includes(dish.state)) : item.items || []
        const statusLabel = statusLabels[item.status] || '待确认'
        return withPhotos({ ...item, key: `meal:${item.id}`, kind: 'meal', title: item.title || '一起开饭',
          statusLabel, kindLabel: item.status === 'completed' ? '吃饭记录' : `${statusLabel}饭单`,
          dishCount: dishes.length, dishSummary: dishes.map(dish => dish.name).filter(Boolean).join('、') || (item.status === 'completed' ? '本次未记录实际菜品' : '还没选菜'),
          dateLabel: formatDate(item.date || item.createdAt), sortDate: new Date(item.date || item.createdAt || 0).getTime() || 0 },
        photoRefs(item.photoFileIds), previous.get(`meal:${item.id}`))
      })
      let timeline = (mode === 'cooking' ? cooking : mode === 'meals' ? eating : [...cooking, ...eating])
        .sort((a, b) => b.sortDate - a.sortDate || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      if (mode === 'all') timeline = timeline.slice(0, 12)
      const selectedKeys = this.data.selectedKeys.filter(key => timeline.some(item => item.key === key))
      timeline = timeline.map(item => ({ ...item, selected: selectedKeys.includes(item.key) }))
      this.setData({ timeline, records, meals, selectedKeys, recordOffset: recordOffset + newRecords.length, mealOffset,
        moreRecords: newRecords.length === 50, moreMeals, loading: false }, () => {
        if (reset && this.data.highlightMealId && wx.pageScrollTo) wx.pageScrollTo({ selector: `#meal-${this.data.highlightMealId}`, duration: 0 })
      })
      const fileIds = timeline.flatMap(item => item.photos.filter(photo => !photo.url).map(photo => photo.fileId))
      const urls = await mediaUrls(fileIds).catch(() => ({}))
      if (token !== this.loadToken) return
      this.setData({ timeline: this.data.timeline.map(item => withPhotos(item, item.photos.map(photo => photo.fileId),
        item.photos.map(photo => photo.url ? photo : { ...photo, url: urls[photo.fileId] || '', state: urls[photo.fileId] ? 'loading' : 'error' }))) })
    } catch (error) { if (token === this.loadToken) this.setData({ loading: false, error: error.message, ...(reset ? { selectedKeys: [] } : {}) }) }
  },
  setPhotoState(e, state) {
    const { recordKey, fileId, url } = e.currentTarget.dataset
    this.setData({ timeline: this.data.timeline.map(item => item.key !== recordKey ? item : withPhotos(item,
      item.photos.map(photo => photo.fileId), item.photos.map(photo => photo.fileId === fileId && photo.url === url && !(state === 'ready' && photo.state === 'error') ? { ...photo, state } : photo))) })
  },
  photoLoaded(e) { this.setPhotoState(e, 'ready') },
  photoFailed(e) { this.setPhotoState(e, 'error') },
  async retryPhoto(e) {
    const { recordKey, fileId } = e.currentTarget.dataset
    if (this.data.editing) return this.selectRecord({ currentTarget: { dataset: { key: recordKey } } })
    const item = this.data.timeline.find(row => row.key === recordKey)
    const photo = item && item.photos.find(entry => entry.fileId === fileId)
    if (!photo || photo.state !== 'error') return
    const token = this.loadToken
    const update = values => this.setData({ timeline: this.data.timeline.map(row => row.key !== recordKey ? row : withPhotos(row,
      row.photos.map(entry => entry.fileId), row.photos.map(entry => entry.fileId === fileId ? { ...entry, ...values } : entry))) })
    update({ url: '', state: 'loading' })
    const urls = await mediaUrls([fileId]).catch(() => ({}))
    if (token === this.loadToken) update({ url: urls[fileId] || '', state: urls[fileId] ? 'loading' : 'error' })
  },
  openModule(e) {
    if (this.data.deleting) return
    const kind = e.currentTarget.dataset.kind
    if (['cooking', 'meals'].includes(kind)) navigate(this, 'navigateTo', `/pages/record-list/index?kind=${kind}`)
  },
  newRecord() {
    if (this.data.mode !== 'cooking' || this.routePending) return
    this.setData({ showRecordMenu: !this.data.showRecordMenu })
  },
  closeRecordMenu() { if (this.data.showRecordMenu) this.setData({ showRecordMenu: false }) },
  chooseRecord(e) {
    const kind = e.currentTarget.dataset.kind
    if (!this.data.showRecordMenu || this.routePending || !['existing', 'new'].includes(kind)) return
    this.closeRecordMenu()
    navigate(this, 'navigateTo', kind === 'new' ? '/pages/recipe-edit/index?mode=cooking' : '/pages/record-edit/index')
  },
  newMeal() {
    if (this.routePending || this.data.starting || this.data.loading) return
    this.setData({ starting: true })
    navigate(this, 'navigateTo', '/pages/meal/index?mode=record', () => this.setData({ starting: false }))
  },
  askDelete(e) {
    if (this.data.editing || this.data.deleting || this.data.deleteTarget) return
    const item = this.data.timeline.find(row => row.key === e.currentTarget.dataset.key)
    if (item) this.setData({ deleteTarget: item, deleteError: '' })
  },
  closeDelete() { if (!this.data.deleting) { this.swipeMoved = false; this.setData({ deleteTarget: null, deleteError: '', openId: '' }) } },
  stopDeleteScroll() {},
  swipeStart(e) { if (!this.data.editing) swipeHandlers.swipeStart.call(this, e) },
  swipeEnd(e) { if (!this.data.editing) swipeHandlers.swipeEnd.call(this, e) },
  toggleEditing() {
    if (this.data.mode !== 'all' || this.data.deleting || this.data.loading || this.data.openingKey || this.data.deleteTarget || !this.data.editing && !this.data.timeline.length) return
    this.swipeMoved = false
    this.setData({ editing: !this.data.editing, openId: '', selectedKeys: [], timeline: this.data.timeline.map(item => ({ ...item, selected: false })) })
  },
  selectRecord(e) {
    if (!this.data.editing || this.data.loading || this.data.deleting || this.data.deleteTarget) return
    const key = e.currentTarget.dataset.key
    if (!this.data.timeline.some(item => item.key === key)) return
    const selectedKeys = this.data.selectedKeys.includes(key) ? this.data.selectedKeys.filter(item => item !== key) : [...this.data.selectedKeys, key]
    this.setData({ selectedKeys, timeline: this.data.timeline.map(item => ({ ...item, selected: selectedKeys.includes(item.key) })) })
  },
  selectAll() {
    if (!this.data.editing || this.data.loading || this.data.deleting || this.data.deleteTarget) return
    const selected = this.data.selectedKeys.length !== this.data.timeline.length
    this.setData({ selectedKeys: selected ? this.data.timeline.map(item => item.key) : [], timeline: this.data.timeline.map(item => ({ ...item, selected })) })
  },
  askBatchDelete() {
    if (!this.data.editing || this.data.loading || this.data.deleting || this.data.deleteTarget) return
    const items = this.data.timeline.filter(item => this.data.selectedKeys.includes(item.key))
    if (items.length) this.setData({ deleteTarget: { kind: 'batch', items }, deleteError: '' })
  },
  removeDeleted(items) {
    const global = getApp().globalData
    for (const item of items.filter(item => item.kind === 'meal')) {
      for (const key of ['mealWishContext', 'mealDraftReturn', 'mealCompletion']) if (global[key] && global[key].mealId === item.id) global[key] = null
    }
    if (this.hidden || !items.length) return
    // Only server-confirmed deletions leave the list; the remaining rows and page offsets stay in place.
    this.loadToken = (this.loadToken || 0) + 1
    const keys = new Set(items.map(item => item.key)), recordIds = new Set(items.filter(item => item.kind === 'record').map(item => item.id))
    const records = this.data.records.filter(row => !keys.has(`record:${row.id}`))
    const meals = this.data.meals.filter(row => !keys.has(`meal:${row.id}`)).map(row => {
      if (!(row.items || []).some(dish => recordIds.has(dish.recordId))) return row
      const unlink = dish => recordIds.has(dish.recordId) ? { ...dish, recordId: '' } : dish
      return { ...row, items: row.items.map(unlink),
        ...(row.menuSnapshot ? { menuSnapshot: { ...row.menuSnapshot, groups: (row.menuSnapshot.groups || []).map(group => ({ ...group, items: group.items.map(unlink) })) } } : {}) }
    })
    this.setData({ openId: '', loading: false, records, meals,
      selectedKeys: this.data.selectedKeys.filter(key => !keys.has(key)),
      recordOffset: Math.max(0, this.data.recordOffset - (this.data.records.length - records.length)),
      mealOffset: Math.max(0, this.data.mealOffset - (this.data.meals.length - meals.length) + (keys.has(`meal:${this.extraMealId}`) ? 1 : 0)),
      currentMealId: keys.has(`meal:${this.data.currentMealId}`) ? '' : this.data.currentMealId,
      timeline: this.data.timeline.filter(row => !keys.has(row.key)).map(row => row.kind === 'meal' ? { ...row, ...meals.find(meal => meal.id === row.id) } : row) })
  },
  async confirmDelete() {
    if (this.data.deleting || !this.data.deleteTarget) return
    const target = this.data.deleteTarget, batch = target.kind === 'batch'
    const items = batch ? target.items : [target], deleted = [], failures = []
    this.setData({ deleting: true, deleteError: '' })
    try {
      // Meal deletion comes first: deleting a linked dish record can change that meal's version.
      for (const kind of ['meal', 'record']) {
        const group = items.filter(item => item.kind === kind)
        if (!group.length) continue
        const pending = new Map()
        await Promise.all(group.map(item => {
          const keys = kind === 'record' ? [item.recipeId && `recipe:${item.recipeId}`, item.mealId && `meal:${item.mealId}`].filter(Boolean) : []
          const waiting = [...new Set(keys.map(key => pending.get(key)).filter(Boolean))]
          const remove = async () => {
            try { await request('deleteRecord', { id: item.id, kind: item.kind, version: item.version || 1 }); deleted.push(item) }
            catch (error) { failures.push({ item, error }) }
          }
          // Records sharing a recipe counter or meal must not race the same transaction document.
          const job = waiting.length ? Promise.all(waiting).then(remove) : remove()
          keys.forEach(key => pending.set(key, job))
          return job
        }))
      }
      this.removeDeleted(deleted)
      if (this.hidden) return
      if (this.data.deleteTarget !== target) { this.setData({ deleting: false }); await this.refresh(); return }
      if (!failures.length) {
        this.setData({ deleteTarget: null, openId: '', deleteError: '' })
        wx.showToast({ title: batch ? `已删除 ${deleted.length} 条记录` : '记录已删除', icon: 'none' })
        return
      }
      const error = failures[0].error, prefix = deleted.length ? `已删除 ${deleted.length} 条，剩余 ${failures.length} 条` : ''
      if (failures.some(failure => failure.error.code === 'VERSION_CONFLICT')) {
        this.setData({ deleting: false, deleteTarget: null })
        await this.refresh()
        alert(new Error(`${prefix ? prefix + '请' : '记录有更新，请'}核对后再删除`))
        return
      }
      const message = !error.code || error.code === 'SERVER_ERROR' ? '删除结果尚未确认，请重试核对' : error.message
      this.setData({ deleteTarget: batch ? { kind: 'batch', items: failures.map(failure => failure.item) } : target,
        deleteError: prefix ? `${prefix}暂时保留；${message}` : message })
    } finally { if (!this.unloaded) this.setData({ deleting: false }) }
  },
  async open(e) {
    if (this.data.editing) return this.selectRecord({ currentTarget: { dataset: { key: `${e.currentTarget.dataset.kind}:${e.currentTarget.dataset.id}` } } })
    if (this.swipeMoved) return
    if (this.data.deleting || this.data.deleteTarget || this.data.openingKey) return
    if (this.data.openId) { this.setData({ openId: '' }); return }
    const { id, kind } = e.currentTarget.dataset
    const record = this.data.timeline.find(item => item.kind === 'record' && item.id === id)
    if (kind === 'record' && this.data.mode === 'all' && record && record.mealId) {
      const token = this.loadToken
      let parent = this.data.meals.find(item => item.id === record.mealId)
      if (!parent) {
        this.setData({ openingKey: record.key })
        try { parent = await request('getMeal', { id: record.mealId }) }
        catch (error) { if (error.code !== 'NOT_FOUND') { if (!this.hidden && token === this.loadToken) alert(error); return } }
        finally { if (!this.unloaded && token === this.loadToken) this.setData({ openingKey: '' }) }
        if (this.hidden || token !== this.loadToken) return
      }
      if (parent && !parent.deletedAt && parent.status === 'completed') return navigate(this, 'navigateTo', `/pages/menu-preview/index?id=${parent.id}&from=recent`)
    }
    const meal = this.data.timeline.find(item => item.kind === 'meal' && item.id === id)
    navigate(this, 'navigateTo', kind === 'meal' ? meal && meal.status === 'completed' ? `/pages/menu-preview/index?id=${id}&from=${this.data.mode === 'meals' ? 'list' : 'recent'}` : `/pages/meal/index?id=${id}` : `/pages/record-edit/index?id=${id}`)
  },
}
