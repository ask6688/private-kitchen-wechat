const { request, alert, setSpaceTitle, mediaUrls, formatDate } = require('../../utils/api')
const selection = require('../../utils/selection')
const { navigate } = require('../../utils/navigation')
const { photoRefs } = require('../../utils/photos')

Page({
  data: { recipe: null, records: [], wishId: '', wishOpen: false, entryMealId: '', selected: false, loading: true, loadingMore: false, photosLoading: false, error: '', offset: 0, hasMore: true },
  onLoad(options = {}) { this.id = options.id || ''; this.entryMealId = options.mealId || ''; this.setData({ wishId: options.wishId || '', entryMealId: this.entryMealId }) },
  onShow() { this.hidden = false; setSpaceTitle('菜品详情'); if (this.previewing) { this.previewing = false; return } return this.load() },
  onHide() { this.hidden = true; this.loadToken = (this.loadToken || 0) + 1 },
  onUnload() { this.onHide(); this.unloaded = true },
  onReachBottom() { if (this.data.hasMore && !this.data.loadingMore) this.moreRecords() },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, loadingMore: false, error: '' })
    try {
      if (!this.id) throw new Error('缺少菜品信息，请返回菜单重新打开')
      const [recipe, records, bootstrap, wish] = await Promise.all([
        request('getRecipe', { id: this.id }), request('listRecords', { recipeId: this.id, offset: 0 }),
        request('bootstrap'), this.data.wishId ? request('getWish', { id: this.data.wishId }) : Promise.resolve(null),
      ])
      if (token !== this.loadToken || this.unloaded) return
      setSpaceTitle('菜品详情')
      selection.configure(bootstrap)
      const contextMeal = this.entryMealId ? await request('getMeal', { id: this.entryMealId }) : null
      const urls = await mediaUrls([recipe.coverFileId, ...records.map(item => photoRefs(item.photoFileIds)[0])]).catch(() => ({}))
      if (token !== this.loadToken || this.unloaded) return
      this.contextMeal = contextMeal
      this.setData({
        recipe: { ...recipe, ingredientsList: (recipe.ingredients || '').split('\n').filter(Boolean), stepsList: (recipe.steps || '').split('\n').filter(Boolean),
          coverUrl: urls[recipe.coverFileId] || '', coverError: !!recipe.coverFileId && !urls[recipe.coverFileId], coverReady: false },
        records: records.map(item => this.recordPhoto(item, urls)),
        offset: records.length, hasMore: records.length === 50, loading: false,
        wishOpen: !!(wish && wish.status === 'open' && wish.recipeId === this.id), selected: this.contextMeal ? this.contextMeal.items.some(item => item.recipeId === this.id) : selection.has({ recipeId: this.id }),
      })
    } catch (error) { if (token === this.loadToken && !this.unloaded) this.setData({ loading: false, error: error.message }) }
  },
  async moreRecords() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return
    const token = this.loadToken
    this.setData({ loadingMore: true })
    try {
      const items = await request('listRecords', { recipeId: this.id, offset: this.data.offset })
      const urls = await mediaUrls(items.map(item => photoRefs(item.photoFileIds)[0])).catch(() => ({}))
      if (token !== this.loadToken || this.unloaded) return
      this.setData({ records: this.data.records.concat(items.map(item => this.recordPhoto(item, urls))),
        offset: this.data.offset + items.length, hasMore: items.length === 50, loadingMore: false })
    } catch (error) { if (token === this.loadToken && !this.unloaded) { this.setData({ loadingMore: false }); alert(error) } }
  },
  recordPhoto(record, urls) {
    const photoFileId = photoRefs(record.photoFileIds)[0] || ''
    return { ...record, dateLabel: formatDate(record.date), photoFileId,
      photoUrl: urls[photoFileId] || '', photoError: !!photoFileId && !urls[photoFileId] }
  },
  imageError(e) {
    const { id, url } = e.currentTarget.dataset
    if (!id) {
      if (this.data.recipe && this.data.recipe.coverUrl === url) this.setData({ 'recipe.coverError': true, 'recipe.coverReady': false })
    } else this.setData({ records: this.data.records.map(item => item.id === id && item.photoUrl === url ? { ...item, photoError: true } : item) })
  },
  coverLoaded(e) {
    const recipe = this.data.recipe
    if (recipe && !recipe.coverError && recipe.coverUrl === e.currentTarget.dataset.url) this.setData({ 'recipe.coverReady': true })
  },
  async retryPhotos() {
    if (this.data.photosLoading || !this.data.recipe) return
    const recipeId = this.data.recipe.id
    this.setData({ photosLoading: true })
    try {
      const urls = await mediaUrls([this.data.recipe.coverFileId, ...this.data.records.map(item => item.photoFileId)])
      if (!this.data.recipe || this.data.recipe.id !== recipeId) return
      const coverFileId = this.data.recipe.coverFileId
      const coverReady = !!(this.data.recipe.coverReady && !this.data.recipe.coverError && this.data.recipe.coverUrl === urls[coverFileId])
      this.setData({ 'recipe.coverUrl': urls[coverFileId] || '', 'recipe.coverError': !!coverFileId && !urls[coverFileId],
        'recipe.coverReady': coverReady,
        records: this.data.records.map(item => this.recordPhoto(item, urls)) })
      if (this.data.recipe.coverError || this.data.records.some(item => item.photoError)) alert(new Error('部分照片暂时无法加载，请稍后重试'))
    } catch (error) { alert(error) }
    finally { this.setData({ photosLoading: false }) }
  },
  edit() { navigate(this, 'navigateTo', this.data.wishId ? `/pages/recipe-edit/index?mode=wish&wishId=${this.data.wishId}` : `/pages/recipe-edit/index?id=${this.id}`) },
  add() {
    if (this.entryMealId) return this.toggleInMeal()
    try {
      const source = { recipeId: this.id, wishId: this.data.wishOpen ? this.data.wishId : '',
        name: this.data.recipe.name, coverFileId: this.data.recipe.coverFileId }
      selection.toggle(source)
      this.setData({ selected: selection.has(source) })
      wx.showToast({ title: this.data.selected ? '已选好，回菜单查看饭单' : '已取消选择', icon: 'none' })
    } catch (error) { alert(error) }
  },
  async toggleInMeal() {
    if (!this.contextMeal || this.pickSaving) return
    this.pickSaving = true
    try {
      const existing = this.contextMeal.items.find(item => item.recipeId === this.id)
      this.contextMeal = await request(existing ? 'removeMealItem' : 'addMealItem', existing
        ? { mealId: this.entryMealId, itemId: existing.id, requestId: `p${Date.now()}` }
        : { mealId: this.entryMealId, requestId: `p${Date.now()}`, item: { recipeId: this.id,
          wishId: this.data.wishOpen ? this.data.wishId : '', name: this.data.recipe.name, state: 'planned' } })
      this.setData({ selected: this.contextMeal.items.some(item => item.recipeId === this.id) })
      wx.showToast({ title: this.data.selected ? '已加入这次饭单' : '已移出这次饭单', icon: 'none' })
    } catch (error) { alert(error) }
    finally { this.pickSaving = false }
  },
  menu() { navigate(this, this.entryMealId ? 'redirectTo' : 'switchTab', this.entryMealId ? `/pages/meal/index?id=${this.entryMealId}` : '/pages/menu/index') },
  preview() {
    if (!this.data.recipe || !this.data.recipe.coverUrl || this.data.recipe.coverError) return
    this.previewing = true
    wx.previewImage({ urls: [this.data.recipe.coverUrl], current: this.data.recipe.coverUrl,
      fail: () => { this.previewing = false; alert(new Error('照片暂时无法预览，请重试')) } })
  },
  copyLink() { if (this.data.recipe.externalUrl) wx.setClipboardData({ data: this.data.recipe.externalUrl, fail: () => alert(new Error('复制失败，请长按链接手动复制')) }) },
  publish() {
    wx.showModal({ title: '收进我们的菜单？', content: '这道菜会加入菜单，心愿和以前的记录会保留', confirmText: '收进菜单', success: ({ confirm }) => {
      if (confirm) request('saveRecipe', { ...this.data.recipe, available: true }).then(() => this.load()).catch(alert)
    } })
  },
  restore() {
    request('unarchiveRecipe', { id: this.id, version: this.data.recipe.version }).then(() => this.load()).catch(alert)
  },
  record() { navigate(this, 'navigateTo', `/pages/record-edit/index?recipeId=${this.id}${this.data.wishId ? `&wishId=${this.data.wishId}` : ''}`) },
  openRecord(e) { navigate(this, 'navigateTo', `/pages/record-edit/index?id=${e.currentTarget.dataset.id}`) },
  archive() {
    wx.showModal({ title: '归档这道菜？', content: '归档后从菜单移走，以前的做菜记录会保留', confirmText: '归档', success: ({ confirm }) => {
      if (!confirm) return
      request('archiveRecipe', { id: this.id, version: this.data.recipe.version }).then(() => {
        if (this.unloaded) return
        wx.showToast({ title: '已归档' })
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
        navigate(this, pages.length > 1 ? 'navigateBack' : 'switchTab', pages.length > 1 ? '' : '/pages/menu/index')
      }).catch(alert)
    } })
  },
})
