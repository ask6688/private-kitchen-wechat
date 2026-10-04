const { request, alert, memberSpace, setSpaceTitle, mediaUrls, withLoading } = require('../../utils/api')
const selection = require('../../utils/selection')
const { navigate } = require('../../utils/navigation')

module.exports = {
  data: { wishes: [], shown: [], loading: true, saving: false, error: '', offset: 0, hasMore: true, selectedCount: 0, fromMeal: false, failedCovers: {}, openId: '' },
  onLoad(options) { this.entryMealId = this.route === 'pages/wish-picker/index' ? options.mealId || '' : '' },
  onShow() {
    setSpaceTitle('心愿单')
    const token = this.showToken = (this.showToken || 0) + 1
    this.setData({ loading: true, wishes: [], shown: [], selectedCount: 0, error: '',
      fromMeal: !!this.entryMealId })
    return memberSpace().then(async data => {
      if (!data || token !== this.showToken) return
      selection.configure(data)
      const context = getApp().globalData.mealWishContext
      this.mealContext = this.entryMealId ? context && context.spaceId === data.space.id && context.mealId === this.entryMealId ? context : { mealId: this.entryMealId, spaceId: data.space.id } : null
      this.contextMeal = this.mealContext ? await request('getMeal', { id: this.mealContext.mealId }) : null
      if (token !== this.showToken) return
      if (this.contextMeal && ['completed', 'cancelled'].includes(this.contextMeal.status)) throw new Error('这顿饭已结束，不能继续选菜')
      this.setData({ fromMeal: !!this.mealContext })
      await this.load(true)
    }).catch(error => { if (token === this.showToken) this.setData({ loading: false, error: error.message }) })
  },
  retry() { return this.onShow() },
  onHide() {
    this.showToken = (this.showToken || 0) + 1
    if (this.entryMealId || this.keepContextOnHide) { this.keepContextOnHide = false; return }
    getApp().globalData.mealWishContext = null
    this.mealContext = null
    this.contextMeal = null
    this.setData({ fromMeal: false })
  },
  onUnload() {
    if (this.route === 'pages/wish-picker/index') getApp().globalData.mealWishContext = null
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() { if (this.data.hasMore) this.load(false) },
  async load(reset = true) {
    if (this.data.loading && !reset) return
    const token = this.showToken
    this.setData({ loading: true, error: '', ...(reset ? { failedCovers: {}, openId: '' } : {}) })
    const offset = reset ? 0 : this.data.offset
    try {
      const items = await request('listWishes', { offset, status: 'open' })
      if (token !== this.showToken) return
      const urls = await mediaUrls(items.map(item => item.recipe && item.recipe.coverFileId)).catch(() => ({}))
      if (token !== this.showToken) return
      const wishes = (reset ? [] : this.data.wishes).concat(items.map(item => ({ ...item,
        name: item.recipe ? item.recipe.name : item.title, coverUrl: item.recipe ? urls[item.recipe.coverFileId] || '' : '',
        category: item.recipe ? item.recipe.category || '未分类' : '未分类', tags: item.recipe ? item.recipe.tags || [] : [],
      })))
      this.setData({ wishes, offset: offset + items.length, hasMore: items.length === 50, loading: false })
      this.syncSelection()
    } catch (error) { if (token === this.showToken) this.setData({ loading: false, error: error.message }) }
  },
  source(wish) { return { ...(wish.recipe ? { recipeId: wish.recipe.id, coverFileId: wish.recipe.coverFileId } : {}), wishId: wish.id, name: wish.name } },
  mealItem(wish) { return this.contextMeal && this.contextMeal.items.find(item => item.wishId === wish.id || wish.recipeId && item.recipeId === wish.recipeId) },
  syncSelection() { this.setData({ shown: this.data.wishes.map(item => ({ ...item,
    selected: this.contextMeal ? !!this.mealItem(item) : selection.has(this.source(item)) })),
    selectedCount: this.contextMeal ? this.contextMeal.items.length : selection.items().length }) },
  openChild(url) {
    this.keepContextOnHide = !!this.mealContext
    if (!navigate(this, 'navigateTo', url, () => { this.keepContextOnHide = false })) this.keepContextOnHide = false
  },
  create() { this.openChild('/pages/recipe-edit/index?mode=wish') },
  coverError(e) { this.setData({ failedCovers: { ...this.data.failedCovers, [e.currentTarget.dataset.id]: true } }) },
  edit(e) { this.openChild(`/pages/recipe-edit/index?mode=wish&wishId=${e.currentTarget.dataset.id}`) },
  more(e) {
    const id = e.currentTarget.dataset.id
    wx.showActionSheet({ itemList: ['编辑心愿'], success: ({ tapIndex }) => { if (tapIndex === 0) this.edit({ currentTarget: { dataset: { id } } }) } })
  },
  rowTap(e) {
    if (this.data.openId) return this.setData({ openId: '' })
    this.detail(e)
  },
  swipeStart(e) { this.swipeOrigin = { id: e.currentTarget.dataset.id, x: e.touches[0].clientX, y: e.touches[0].clientY } },
  swipeEnd(e) {
    const start = this.swipeOrigin
    this.swipeOrigin = null
    if (!start || start.id !== e.currentTarget.dataset.id || !e.changedTouches.length) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) this.setData({ openId: dx < 0 ? start.id : '' })
  },
  remove(e) {
    const wish = this.data.wishes.find(item => item.id === e.currentTarget.dataset.id)
    if (!wish || this.data.saving) return
    this.setData({ openId: '' })
    wx.showModal({ title: `删除“${wish.name}”？`, content: '只移除这条心愿，菜品、饭单和做菜记录会保留', confirmText: '删除', confirmColor: '#A24D3D', success: ({ confirm }) => { if (confirm) this.deleteWish(wish) } })
  },
  async deleteWish(wish) {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await withLoading(() => request('deleteWish', { id: wish.id, version: wish.version }))
      const selectedWish = selection.items().find(item => item.wishId === wish.id)
      if (selectedWish) {
        selection.remove(selectedWish)
        if (selectedWish.recipeId) selection.add({ ...selectedWish, wishId: '' })
      }
      this.setData({ wishes: this.data.wishes.filter(item => item.id !== wish.id) })
      this.syncSelection()
      wx.showToast({ title: '已删除', icon: 'none' })
      await this.load(true)
    } catch (error) { alert(error) }
    finally { this.setData({ saving: false }) }
  },
  detail(e) {
    const wish = this.data.wishes.find(item => item.id === e.currentTarget.dataset.id)
    if (!wish) return
    if (wish.recipe) this.openChild(`/pages/recipe/index?id=${wish.recipe.id}&wishId=${wish.id}${this.entryMealId ? `&mealId=${this.entryMealId}` : ''}`)
    else this.openChild(`/pages/recipe-edit/index?mode=wish&wishId=${wish.id}`)
  },
  complete(e) {
    const wish = this.data.wishes.find(item => item.id === e.currentTarget.dataset.id)
    if (!wish || this.data.saving || this.data.loading) return
    wx.showModal({ title: '实现这个心愿？', content: '从心愿单收进菜单，下次就能选这道菜', confirmText: '实现', success: ({ confirm }) => { if (confirm) this.finish(wish) } })
  },
  async finish(wish) {
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await withLoading(() => request('completeWish', { id: wish.id, version: wish.version }))
      this.setData({ wishes: this.data.wishes.filter(item => item.id !== wish.id) })
      this.syncSelection()
      wx.showToast({ title: '已加入我们的菜单', icon: 'none' })
      await this.load(true)
    }
    catch (error) { alert(error) }
    finally { this.setData({ saving: false }) }
  },
  addToMeal(e) {
    const wish = this.data.wishes.find(item => item.id === e.currentTarget.dataset.id)
    if (!wish || this.data.saving) return
    if (this.mealContext) return this.toggleInMeal(wish)
    if (!wish.recipe) {
      this.openChild(`/pages/recipe-edit/index?mode=wish&wishId=${wish.id}`)
      return wx.showToast({ title: '先保存这道菜，再加入今天的选择', icon: 'none' })
    }
    if (wish.recipe.archivedAt) return wx.showToast({ title: '这道菜已归档，请先打开详情恢复', icon: 'none' })
    try { selection.toggle(this.source(wish)); this.syncSelection() } catch (error) { alert(error) }
  },
  async toggleInMeal(wish) {
    if (!this.contextMeal || this.data.saving) return
    const existing = this.mealItem(wish)
    this.setData({ saving: true })
    try {
      const meal = await withLoading(() => existing
        ? request('removeMealItem', { mealId: this.mealContext.mealId, itemId: existing.id, requestId: `w${Date.now()}` })
        : request('addMealItem', { mealId: this.mealContext.mealId, requestId: `w${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
          item: { recipeId: wish.recipeId || '', wishId: wish.id, name: wish.name, state: 'planned' } }))
      this.contextMeal = meal
      this.syncSelection()
    } catch (error) { alert(error) }
    finally { this.setData({ saving: false }) }
  },
  returnMeal() {
    if (!this.mealContext || this.data.saving || this.data.loading) return
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const previous = pages[pages.length - 2]
    const back = previous && previous.route === 'pages/meal/index' && previous.id === this.mealContext.mealId
    navigate(this, back ? 'navigateBack' : 'redirectTo', back ? '' : `/pages/meal/index?id=${this.mealContext.mealId}`)
  },
  menu() { navigate(this, 'switchTab', '/pages/menu/index') },
}
