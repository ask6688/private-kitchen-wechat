const { request, alert, withLoading, memberSpace, setSpaceTitle, mediaUrls } = require('../../utils/api')
const selection = require('../../utils/selection')
const { navigate } = require('../../utils/navigation')

async function submitSelection(payload) {
  try { return await request('submitMealSelection', payload) } catch (error) {
    if (error.code !== 'SERVER_ERROR') throw error
    // The server deduplicates this requestId even if the first response was lost.
    return request('submitMealSelection', payload)
  }
}

module.exports = {
  data: {
    space: null, recipes: [], shown: [], categories: [{ id: 'all', name: '全部' }], categoryId: 'all', keyword: '',
    showAll: false, showArchived: false, showManagement: false, showSelection: false,
    selectedItems: [], selectedCount: 0, currentMeal: null, fromMeal: false, mealTitle: '',
    loading: true, submitting: false, error: '', offset: 0, hasMore: true, failedCovers: {},
  },
  onLoad(options = {}) { this.entryMealId = this.route === 'pages/menu-picker/index' ? options.mealId || '' : '' },
  onShow() { setSpaceTitle('菜单'); return this.refresh() },
  onHide() { this.refreshToken = (this.refreshToken || 0) + 1; this.loadToken = (this.loadToken || 0) + 1 },
  onPullDownRefresh() { return this.refresh().finally(() => wx.stopPullDownRefresh()) },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false) },
  async refresh() {
    const token = this.refreshToken = (this.refreshToken || 0) + 1
    this.setData({ space: null, recipes: [], shown: [], currentMeal: null, loading: true, error: '' })
    try {
      const data = await memberSpace()
      if (!data || token !== this.refreshToken) return
      setSpaceTitle('菜单')
      selection.configure(data)
      const categories = [{ id: 'all', name: '全部' }, { id: 'uncategorized', name: '未分类' },
        ...(data.space.categories || []).filter(item => !item.deletedAt).map(item => ({ id: item.id, name: item.name }))]
      const categoryId = categories.some(item => item.id === this.data.categoryId) ? this.data.categoryId : 'all'
      this.contextMeal = this.entryMealId ? await request('getMeal', { id: this.entryMealId }) : null
      if (token !== this.refreshToken) return
      if (this.contextMeal && ['completed', 'cancelled'].includes(this.contextMeal.status)) throw new Error('这顿饭已结束，不能继续选菜')
      const selectedItems = this.contextMeal ? this.contextMeal.items : selection.items()
      this.setData({ space: data.space, categories, categoryId, selectedItems,
        selectedCount: selectedItems.length, showSelection: selectedItems.length ? this.data.showSelection : false,
        currentMeal: null, fromMeal: !!this.contextMeal, mealTitle: this.contextMeal ? this.contextMeal.title : '' })
      const mealId = data.space.currentMealId
      const mealRequest = mealId ? request('getMeal', { id: mealId }).then(meal => {
        if (token === this.refreshToken && this.data.space && this.data.space.currentMealId === mealId) this.setData({ currentMeal: ['draft', 'confirmed'].includes(meal.status) ? meal : null })
      }).catch(alert) : Promise.resolve()
      await Promise.all([this.load(true), mealRequest])
    } catch (error) { if (token === this.refreshToken) this.setData({ loading: false, error: error.message }) }
  },
  async load(reset) {
    if (this.data.loading && !reset) return
    const token = reset ? (this.loadToken = (this.loadToken || 0) + 1) : this.loadToken
    const offset = reset ? 0 : this.data.offset
    const categoryId = this.data.categoryId
    this.setData({ loading: true, error: '', ...(reset ? { recipes: [], shown: [], offset: 0, hasMore: true, failedCovers: {} } : {}) })
    try {
      const items = await request('listRecipes', { offset, includeArchived: true,
        ...(this.data.showArchived ? { archivedOnly: true } : !this.data.showAll ? { availableOnly: true } : {}),
        ...(categoryId !== 'all' ? { categoryId } : {}) })
      if (token !== this.loadToken) return
      const urls = await mediaUrls(items.map(item => item.coverFileId)).catch(() => ({}))
      if (token !== this.loadToken) return
      const recipes = (reset ? [] : this.data.recipes).concat(items.map(item => ({ ...item,
        coverUrl: urls[item.coverFileId] || '',
        metaLabel: [item.category, ...(item.tags || []).slice(0, 2)].filter(Boolean).join(' · ') })))
      this.setData({ recipes, offset: offset + items.length, hasMore: items.length === 50, loading: false })
      this.filter()
      if (reset && this.data.keyword.trim()) this.searchAll(token)
    } catch (error) {
      if (token === this.loadToken) this.setData({ loading: false, error: error.message })
    }
  },
  filter() {
    if (!this.data.space) return
    const { recipes, keyword, showAll, showArchived } = this.data
    const q = keyword.trim().toLowerCase()
    const selectedIds = new Set((this.contextMeal ? this.contextMeal.items : selection.items()).map(item => item.recipeId))
    this.setData({ shown: recipes.filter(item =>
      (showArchived ? !!item.archivedAt : !item.archivedAt && (showAll || item.available !== false)) &&
      (!q || item.name.toLowerCase().includes(q) || (item.tags || []).some(tag => tag.toLowerCase().includes(q))))
      .map(item => ({ ...item, selected: selectedIds.has(item.id) })) })
  },
  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
    this.filter()
    clearTimeout(this.searchTimer)
    if (e.detail.value.trim()) this.searchTimer = setTimeout(() => this.searchAll(this.loadToken), 300)
  },
  async searchAll(token) {
    if (this.searchingToken === token) return
    this.searchingToken = token
    // ponytail: 按分类分页读到末尾，私人厨房超过数百道菜时再考虑全文索引。
    while (token === this.loadToken && this.data.keyword.trim() && this.data.hasMore) {
      const before = this.data.offset
      await this.load(false)
      if (this.data.offset === before) break
    }
    if (this.searchingToken === token) this.searchingToken = null
  },
  onCategory(e) {
    const categoryId = e.currentTarget.dataset.id
    if (categoryId === this.data.categoryId) return
    this.setData({ categoryId })
    this.load(true)
  },
  onShowAll(e) { this.setData({ showAll: e.detail.value }); this.load(true) },
  toggleManagement() { this.setData({ showManagement: !this.data.showManagement }) },
  archived() {
    this.setData({ showArchived: !this.data.showArchived, categoryId: 'all', keyword: '' })
    this.load(true)
  },
  retry() { return this.refresh() },
  coverError(e) { this.setData({ failedCovers: { ...this.data.failedCovers, [e.currentTarget.dataset.id]: true } }) },
  detail(e) { navigate(this, 'navigateTo', `/pages/recipe/index?id=${e.currentTarget.dataset.id}${this.entryMealId ? `&mealId=${this.entryMealId}` : ''}`) },
  toggleDish(e) {
    const recipe = this.data.recipes.find(item => item.id === e.currentTarget.dataset.id)
    if (!recipe || this.data.submitting) return
    if (this.contextMeal) return this.toggleInMeal(recipe)
    try {
      selection.toggle({ recipeId: recipe.id, name: recipe.name,
        coverFileId: recipe.coverFileId })
      this.syncSelection()
    } catch (error) { alert(error) }
  },
  syncSelection() {
    const selectedItems = this.contextMeal ? this.contextMeal.items : selection.items()
    this.setData({ selectedItems, selectedCount: selectedItems.length,
      showSelection: selectedItems.length ? this.data.showSelection : false })
    this.filter()
  },
  toggleSelection() { this.setData({ showSelection: !this.data.showSelection }) },
  closeSelection() { this.setData({ showSelection: false }) },
  noop() {},
  removeSelected(e) {
    if (this.contextMeal) return this.toggleInMeal({ id: e.currentTarget.dataset.recipeId })
    selection.remove({ recipeId: e.currentTarget.dataset.recipeId, wishId: e.currentTarget.dataset.wishId })
    this.syncSelection()
  },
  clearSelected() { if (this.contextMeal) return; selection.clear(); this.syncSelection(); this.closeSelection() },
  async submit() {
    if (this.data.submitting) return
    if (this.contextMeal) return this.returnMeal()
    let payload
    try { payload = selection.prepareSubmit() } catch (error) { return alert(error) }
    this.setData({ submitting: true })
    try {
      let meal
      try {
        meal = await withLoading(() => submitSelection(payload))
      } catch (error) {
        if (error.code !== 'RECONFIRM_REQUIRED') throw error
        const confirmed = await new Promise(resolve => wx.showModal({ title: '调整已确认的菜单？',
          content: '加菜后饭单会回到待确认，需要重新确认菜单', confirmText: '继续加菜',
          success: result => resolve(result.confirm), fail: () => resolve(false) }))
        if (!confirmed) return
        meal = await withLoading(() => submitSelection({ ...payload, allowReconfirm: true }))
      }
      selection.completeSubmit(payload.requestId)
      this.syncSelection()
      this.setData({ showSelection: false })
      navigate(this, 'navigateTo', `/pages/meal/index?id=${meal.id}`, () => this.refresh())
    } catch (error) {
      if (error.code === 'MEAL_DATE_CONFLICT') {
        wx.showModal({ title: '还有一份以前的饭单', content: '先完成或取消那顿饭，已选的菜会保留',
          confirmText: '打开饭单', success: result => { if (result.confirm) this.meal() } })
      } else alert(error)
    } finally { this.setData({ submitting: false }) }
  },
  async toggleInMeal(recipe) {
    if (!this.contextMeal || this.data.submitting) return
    const existing = this.contextMeal.items.find(item => item.recipeId === recipe.id)
    this.setData({ submitting: true })
    try {
      this.contextMeal = await withLoading(() => existing
        ? request('removeMealItem', { mealId: this.contextMeal.id, itemId: existing.id, requestId: `s${Date.now()}` })
        : request('addMealItem', { mealId: this.contextMeal.id, requestId: `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
          item: { recipeId: recipe.id, name: recipe.name, state: 'planned' } }))
      this.syncSelection()
    } catch (error) { alert(error) }
    finally { this.setData({ submitting: false }) }
  },
  returnMeal() {
    if (this.data.submitting || this.data.loading || !this.contextMeal) return
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const previous = pages[pages.length - 2]
    navigate(this, previous && previous.route === 'pages/meal/index' && previous.id === this.contextMeal.id ? 'navigateBack' : 'redirectTo',
      previous && previous.route === 'pages/meal/index' && previous.id === this.contextMeal.id ? '' : `/pages/meal/index?id=${this.contextMeal.id}`)
  },
  restore(e) {
    const recipe = this.data.recipes.find(item => item.id === e.currentTarget.dataset.id)
    if (!recipe) return
    request('unarchiveRecipe', { id: recipe.id, version: recipe.version }).then(() => this.load(true)).catch(alert)
  },
  newRecipe() { navigate(this, 'navigateTo', '/pages/recipe-edit/index') },
  meal() {
    const id = this.data.currentMeal && this.data.currentMeal.id
    navigate(this, 'navigateTo', '/pages/meal/index' + (id ? `?id=${id}` : ''))
  },
}
