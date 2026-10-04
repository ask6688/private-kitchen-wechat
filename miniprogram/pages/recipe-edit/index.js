const { request, alert, withLoading, setSpaceTitle, mediaUrls, formatDate, memberSpace } = require('../../utils/api')
const { chooseImage, uploadImage, uploadRecordPhotos } = require('../../utils/upload')
const { navigate } = require('../../utils/navigation')
const { photoItems, photoHandlers } = require('../../utils/photos')

function extractLink(value) {
  const text = (value || '').trim()
  if (!text) return ''
  const links = [...new Set((text.match(/https?:\/\/[^\s<>"'，。！？、；（）【】]+/gi) || []).map(link => link.replace(/[.,;!]+$/, '')))]
  if (links.length !== 1 || links[0].length > 2048) throw new Error('请粘贴一条完整的 http 或 https 菜谱链接')
  return links[0]
}

Page({
  ...photoHandlers,
  data: {
    mode: 'recipe', wishId: '', wishVersion: null, id: '', version: null, name: '',
    categoryId: '', category: '', categories: [], selectedCategoryId: '', categoryMissing: false, categoryTouched: false,
    categoryQuery: '', editingTaxonomy: '', taxonomyFocus: false, catalogVersion: 0,
    tagIds: [], tags: [], tagQuery: '', legacyTags: [], legacyTagsText: '', tagsTouched: false, externalUrl: '',
    pendingCategoryName: '', pendingTagNames: [], pendingTagsText: '', draftVersionChanged: false,
    description: '', showDescription: false,
    ingredientsText: '', stepsText: '', coverFileId: '', photoFileIds: null, coverLocalPath: '', coverUrl: '', coverUploadRequestId: '',
    date: '', note: '', photos: [], addToMenu: true, requestId: '', savedRecordId: '', recipeDetailsOpen: false, pendingRecordPayload: null,
    available: true, archivedAt: null, error: '', saving: false, taxonomySaving: false, loading: true,
  },
  async onLoad(options = {}) {
    this.initialOptions = options
    this.setData({ loading: true, error: '' })
    const cooking = options.mode === 'cooking'
    this.setData({ mode: cooking ? 'cooking' : options.mode === 'wish' || options.wishId ? 'wish' : 'recipe',
      wishId: cooking ? '' : options.wishId || '', id: cooking ? '' : options.id || '',
      available: cooking || !(options.mode === 'wish' || options.wishId),
      ...(cooking ? { date: formatDate(new Date()), requestId: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}` } : {}) })
    try {
      await this.refreshCatalog()
      if (!this.spaceId || this.unloaded) return
      this.draftKey = `dishDraft:${this.spaceId}:${this.data.mode}:${this.data.wishId || this.data.id || 'new'}`
      if (this.data.id || this.data.wishId) await this.loadRecipe()
      else this.setData({ photoFileIds: [] })
      await this.restoreDraft()
      this.ready = true
    } catch (error) { this.setData({ error: error.message }) }
    finally { this.setData({ loading: false }) }
  },
  retryLoad() { this.keepDraft(); return this.onLoad(this.initialOptions) },
  onShow() { setSpaceTitle(this.data.mode === 'cooking' ? '做一道菜' : this.data.mode === 'wish' ? '心愿菜品' : '菜品编辑'); if (this.ready) this.refreshCatalog().catch(alert) },
  async refreshCatalog() {
    const context = await memberSpace()
    if (this.unloaded) return
    if (!context) throw new Error('请先加入厨房，再编辑菜品')
    const { space } = context
    setSpaceTitle(this.data.mode === 'cooking' ? '做一道菜' : this.data.mode === 'wish' ? '心愿菜品' : '菜品编辑')
    if (this.spaceId && this.spaceId !== space.id) throw new Error('厨房已切换，请返回后重新打开')
    this.spaceId = space.id
    this.applyCatalog(space)
  },
  applyCatalog(catalog) {
    const categories = (catalog.categories || []).filter(item => !item.deletedAt)
    this.setData({ categories, tags: (catalog.tags || []).filter(item => !item.deletedAt), catalogVersion: catalog.catalogVersion || 0 })
    this.resolvePendingLegacy()
  },
  resolvePendingLegacy() {
    const match = (items, name) => items.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    const categoryName = this.data.pendingCategoryName
    if (categoryName) {
      const category = match(this.data.categories, categoryName)
      if (category) this.setData({ categoryId: category.id, category: category.name, pendingCategoryName: '' })
    }
    const tagIds = [...this.data.tagIds]
    const pendingTagNames = []
    for (const name of this.data.pendingTagNames) {
      const tag = match(this.data.tags, name)
      if (tag) { if (!tagIds.includes(tag.id)) tagIds.push(tag.id) }
      else pendingTagNames.push(name)
    }
    this.setData({ tagIds, pendingTagNames })
    this.syncSelection()
  },
  syncSelection() {
    const categoryById = this.data.categories.find(item => item.id === this.data.categoryId)
    const selectedCategory = categoryById || (!this.data.categoryId && !this.data.categoryTouched && this.data.categories.find(item => item.name.toLocaleLowerCase() === this.data.category.toLocaleLowerCase()))
    const tags = this.data.tags.map(item => ({ ...item, selected: this.data.tagIds.includes(item.id) || (!this.data.tagsTouched && this.data.legacyTags.some(name => name.toLocaleLowerCase() === item.name.toLocaleLowerCase())) }))
    this.setData({ selectedCategoryId: selectedCategory ? selectedCategory.id : '', categoryMissing: !!this.data.categoryId && !categoryById, legacyTagsText: this.data.legacyTags.join('、'),
      pendingTagsText: this.data.pendingTagNames.join('、'), tags })
  },
  async loadRecipe() {
    let recipe
    if (this.data.mode === 'wish' && this.data.wishId) {
      const wish = await request('getWish', { id: this.data.wishId })
      this.wish = wish
      this.setData({ wishVersion: wish.version })
      recipe = wish.recipe || { name: wish.title, available: false, photoFileIds: [] }
    } else recipe = await request('getRecipe', { id: this.data.id })
    const urls = await mediaUrls([recipe.coverFileId]).catch(() => ({}))
    this.originalCoverFileId = recipe.coverFileId || ''
    this.setData({
      id: recipe.id || '', version: recipe.version || null, name: recipe.name || '', categoryId: recipe.categoryId || '', category: recipe.category || '', archivedAt: recipe.archivedAt || null,
      categoryTouched: Object.prototype.hasOwnProperty.call(recipe, 'categoryId'), tagIds: recipe.tagIds || [],
      legacyTags: Object.prototype.hasOwnProperty.call(recipe, 'tagIds') ? [] : recipe.tags || [], tagsTouched: Object.prototype.hasOwnProperty.call(recipe, 'tagIds'),
      externalUrl: recipe.externalUrl || '', description: recipe.description || '', showDescription: !!recipe.description,
      pendingCategoryName: '', pendingTagNames: [], draftVersionChanged: false,
      ingredientsText: recipe.ingredients || '', stepsText: recipe.steps || '',
      coverFileId: recipe.coverFileId || '', photoFileIds: recipe.photoFileIds || [], coverLocalPath: '', coverUploadRequestId: '', coverUrl: urls[recipe.coverFileId] || '', available: recipe.available !== false, error: '',
    })
    this.syncSelection()
  },
  onHide() { this.keepDraft() },
  onUnload() { this.keepDraft(); this.unloaded = true },
  keepDraft() {
    if (this.saved || !this.dirty || !this.draftKey) return
    const fields = ['id', 'version', 'wishVersion', 'name', 'categoryId', 'category', 'categoryTouched', 'tagIds', 'legacyTags', 'tagsTouched', 'pendingCategoryName', 'pendingTagNames', 'description', 'showDescription', 'externalUrl', 'ingredientsText', 'stepsText', 'coverFileId', 'photoFileIds', 'coverLocalPath', 'coverUploadRequestId', 'available']
    const draft = Object.fromEntries(fields.map(key => [key, this.data[key]]))
    if (this.data.mode === 'cooking') Object.assign(draft, { date: this.data.date, note: this.data.note,
      photos: this.data.photos.map(({ fileId, localPath, uploadRequestId }) => ({ fileId, localPath, uploadRequestId })),
      addToMenu: this.data.addToMenu, requestId: this.data.requestId, recipeDetailsOpen: this.data.recipeDetailsOpen,
      pendingRecordPayload: this.data.pendingRecordPayload })
    wx.setStorageSync(this.draftKey, draft)
  },
  async restoreDraft() {
    let draft = wx.getStorageSync(this.draftKey)
    let fromLegacyDraft = false
    // Existing recipe drafts are restored only after the server verifies the recipe belongs to this kitchen.
    if (!draft && this.data.mode === 'recipe' && this.data.id && this.data.version) {
      draft = wx.getStorageSync(`recipeDraft:${this.data.id}`)
      if (draft) { this.legacyDraftKey = `recipeDraft:${this.data.id}`; fromLegacyDraft = true }
    }
    if (!draft) return
    const draftVersionChanged = !!this.data.id && draft.version !== this.data.version
    this.dirty = true
    this.setData({ ...draft, photoFileIds: Array.isArray(draft.photoFileIds) ? draft.photoFileIds : this.data.photoFileIds,
      legacyTags: draft.legacyTags || (draft.tagsText ? draft.tagsText.split(/[、,，\n]/).map(item => item.trim()).filter(Boolean) : this.data.legacyTags),
      showDescription: this.data.showDescription || Object.prototype.hasOwnProperty.call(draft, 'description') || !!draft.showDescription,
      draftVersionChanged, coverUrl: draft.coverLocalPath || this.data.coverUrl })
    if (fromLegacyDraft) {
      const category = (draft.category || '').trim()
      const tagNames = [...new Set((draft.tagsText || '').split(/[、,，\n]/).map(item => item.trim()).filter(Boolean))]
      this.setData({ categoryId: '', categoryTouched: true, pendingCategoryName: category === '未分类' ? '' : category,
        tagIds: [], tagsTouched: true, legacyTags: [], pendingTagNames: tagNames })
    }
    this.resolvePendingLegacy()
    if (this.data.mode === 'cooking') {
      this.setData({ id: '', wishId: '', photos: photoItems(draft.photos || []) })
      await this.retryImages()
    }
    if (draft.coverFileId && !draft.coverLocalPath) {
      try {
        const urls = await mediaUrls([draft.coverFileId])
        if (this.data.coverFileId === draft.coverFileId) this.setData({ coverUrl: urls[draft.coverFileId] || '' })
      } catch (_) {}
    }
  },
  change(e) { if (this.cookingLocked()) return; this.dirty = true; this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
  cookingLocked() { return this.data.mode === 'cooking' && (this.data.saving || !!this.data.pendingRecordPayload || this.saved) },
  openTaxonomyInput(e) {
    if (this.data.taxonomySaving || this.cookingLocked()) return
    this.setData({ editingTaxonomy: e.currentTarget.dataset.kind, taxonomyFocus: false, categoryQuery: '', tagQuery: '' }, () => this.setData({ taxonomyFocus: true }))
  },
  taxonomyBlur(e) {
    const kind = e.currentTarget.dataset.kind
    if (this.data.editingTaxonomy === kind && !this.data[kind === 'category' ? 'categoryQuery' : 'tagQuery'].trim()) this.setData({ editingTaxonomy: '', taxonomyFocus: false })
  },
  categoryInput(e) { if (!this.cookingLocked()) this.setData({ categoryQuery: e.detail.value }) },
  tagInput(e) { if (!this.cookingLocked()) this.setData({ tagQuery: e.detail.value }) },
  selectCategory(e) {
    if (this.cookingLocked()) return
    const category = this.data.categories.find(item => item.id === e.currentTarget.dataset.id)
    if (!category) return
    if (category.id === this.data.selectedCategoryId) return this.clearCategory()
    this.dirty = true
    this.setData({ categoryId: category.id, category: category.name, categoryTouched: true, pendingCategoryName: '', categoryQuery: '', editingTaxonomy: '', taxonomyFocus: false })
    this.syncSelection()
    this.keepDraft()
  },
  clearCategory() { if (this.cookingLocked()) return; this.dirty = true; this.setData({ categoryId: '', category: '', categoryTouched: true, pendingCategoryName: '', categoryQuery: '', editingTaxonomy: '', taxonomyFocus: false }); this.syncSelection(); this.keepDraft() },
  tag(e) {
    if (this.cookingLocked()) return
    const id = e.currentTarget.dataset.id
    const selectedIds = this.data.tags.filter(item => item.selected).map(item => item.id)
    const tagIds = selectedIds.includes(id) ? selectedIds.filter(item => item !== id) : selectedIds.concat(id)
    if (tagIds.length > 8) return wx.showToast({ title: '每道菜最多选 8 个标签', icon: 'none' })
    this.dirty = true
    this.setData({ tagIds, legacyTags: [], pendingTagNames: [], tagsTouched: true, tagQuery: '', editingTaxonomy: '', taxonomyFocus: false })
    this.syncSelection()
    this.keepDraft()
  },
  categoryConfirm(e) { return this.confirmTaxonomy('category', e.detail && e.detail.value) },
  tagConfirm(e) { return this.confirmTaxonomy('tag', e.detail && e.detail.value) },
  async confirmTaxonomy(kind, value) {
    if (this.data.taxonomySaving || this.cookingLocked()) return
    const name = String(value == null ? this.data[kind === 'category' ? 'categoryQuery' : 'tagQuery'] : value).trim()
    if (!name) return this.setData({ editingTaxonomy: '', taxonomyFocus: false })
    const items = kind === 'category' ? this.data.categories : this.data.tags
    const existing = items.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (existing) return this.useTaxonomy(kind, existing)
    if (kind === 'tag' && this.data.tags.filter(item => item.selected).length >= 8) return alert(new Error('每道菜最多选 8 个标签'))
    this.setData({ taxonomySaving: true })
    try {
      await withLoading(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const catalog = await request('manageTaxonomy', { kind, op: 'create', name, version: this.data.catalogVersion })
            this.applyCatalog(catalog)
            break
          } catch (error) {
            if (error.code !== 'VERSION_CONFLICT' || attempt) throw error
            await this.refreshCatalog()
            const updatedItems = kind === 'category' ? this.data.categories : this.data.tags
            if (updatedItems.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) break
          }
        }
      })
      const updatedItems = kind === 'category' ? this.data.categories : this.data.tags
      const created = updatedItems.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
      if (created) this.useTaxonomy(kind, created)
    } catch (error) { alert(error) }
    finally { this.setData({ taxonomySaving: false }) }
  },
  useTaxonomy(kind, item) {
    if (kind === 'category') {
      this.dirty = true
      this.setData({ categoryId: item.id, category: item.name, categoryTouched: true, pendingCategoryName: '', categoryQuery: '', editingTaxonomy: '', taxonomyFocus: false })
    } else {
      const selectedIds = this.data.tags.filter(tag => tag.selected).map(tag => tag.id)
      const tagIds = selectedIds.includes(item.id) ? selectedIds : [...selectedIds, item.id]
      if (tagIds.length > 8) return alert(new Error('每道菜最多选 8 个标签'))
      this.dirty = true
      this.setData({ tagIds, tagsTouched: true, legacyTags: [], pendingTagNames: this.data.pendingTagNames.filter(name => name.toLocaleLowerCase() !== item.name.toLocaleLowerCase()), tagQuery: '', editingTaxonomy: '', taxonomyFocus: false })
    }
    this.syncSelection()
    this.keepDraft()
  },
  manage(e) { if (this.data.taxonomySaving || this.cookingLocked()) return; this.keepDraft(); navigate(this, 'navigateTo', `/pages/taxonomy/index?kind=${e.currentTarget.dataset.kind}`) },
  available(e) { this.dirty = true; this.setData({ available: e.detail.value }) },
  onAddToMenu(e) { if (this.cookingLocked()) return; this.dirty = true; this.setData({ addToMenu: e.detail.value }); this.keepDraft() },
  toggleRecipeDetails() { if (!this.cookingLocked()) this.setData({ recipeDetailsOpen: !this.data.recipeDetailsOpen }) },
  copyLink() {
    const data = this.data.externalUrl
    if (data.trim()) wx.setClipboardData({ data, fail: () => alert(new Error('复制失败，请长按链接手动复制')) })
  },
  photo() {
    if (this.data.saving || this.cookingLocked()) return
    if (this.data.mode === 'cooking' && this.data.photos.length >= 12) return wx.showToast({ title: '最多 12 张照片', icon: 'none' })
    return withLoading(() => chooseImage({ persist: true })).then(({ tempFilePath }) => {
      this.dirty = true
      if (this.data.mode === 'cooking') this.setData({ photos: [...this.data.photos,
        { fileId: '', localPath: tempFilePath, key: `${tempFilePath}:${Date.now()}`, url: tempFilePath, state: 'loading' }] })
      else this.setData({ coverLocalPath: tempFilePath, coverUrl: tempFilePath, coverUploadRequestId: '' })
      this.keepDraft()
    }).catch(error => { if (error.errMsg && error.errMsg.includes('cancel')) return; alert(error) })
  },
  removePhoto(e) {
    if (this.data.saving || this.cookingLocked()) return
    this.dirty = true
    this.setData({ photos: this.data.photos.filter((_, index) => index !== Number(e.currentTarget.dataset.index)) })
    this.keepDraft()
  },
  save() {
    if (this.data.saving || this.data.loading || this.data.taxonomySaving) return
    if (this.data.savedRecordId) return navigate(this, 'redirectTo', `/pages/record-edit/index?id=${this.data.savedRecordId}`)
    if (this.saved) return this.openSavedRecipe()
    if (this.data.mode === 'cooking' && this.data.pendingRecordPayload) return this.saveCooking()
    if (this.data.archivedAt) return alert(new Error('这道菜已归档，请先在详情页恢复'))
    const name = this.data.name.trim()
    if (!name) return wx.showToast({ title: '请填写菜名', icon: 'none' })
    const data = this.data
    if (!Array.isArray(data.photoFileIds)) return wx.showToast({ title: '请先重新载入菜品', icon: 'none' })
    if (data.categoryQuery.trim() || data.tagQuery.trim()) return alert(new Error('请先按回车添加自定义分类或标签'))
    if (data.pendingCategoryName || data.pendingTagNames.length) return alert(new Error('旧草稿的分类或标签尚未匹配，请自定义同名项目或重新选择'))
    if (data.tagIds.length > 8) return alert(new Error('每道菜最多选择 8 个标签，请先调整'))
    if (data.categoryId && !data.categories.some(item => item.id === data.categoryId)) return alert(new Error('这个分类已被删除，请重新选择分类'))
    if (data.tagIds.some(id => !data.tags.some(item => item.id === id))) return alert(new Error('有标签已被删除，请重新选择标签'))
    let externalUrl
    try { externalUrl = extractLink(data.externalUrl) } catch (error) { alert(error); return }
    const recipe = {
      name, externalUrl, ingredients: data.ingredientsText.trim(), steps: data.stepsText.trim(),
      ...(data.showDescription ? { description: data.description.trim() } : {}),
      coverFileId: data.coverFileId, photoFileIds: data.photoFileIds, available: data.available,
      ...(data.categoryTouched ? { categoryId: data.categoryId } : { category: data.category }),
      ...(data.tagsTouched ? { tagIds: data.tagIds } : { tags: data.legacyTags }),
    }
    if (data.mode === 'cooking') return this.saveCooking(recipe, externalUrl)
    if (data.id) { recipe.id = data.id; recipe.version = data.version }
    const payload = data.mode === 'wish' ? { recipe, ...(this.wish ? { type: this.wish.type, note: this.wish.note || '' } : {}) } : recipe
    if (data.mode === 'wish' && data.wishId) { payload.id = data.wishId; payload.version = data.wishVersion }
    this.setData({ saving: true, externalUrl })
    return withLoading(async () => {
      if (data.coverLocalPath) {
        const uploadRequestId = data.coverUploadRequestId || `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
        this.setData({ coverUploadRequestId: uploadRequestId })
        this.keepDraft()
        recipe.coverFileId = (await uploadImage(data.coverLocalPath, uploadRequestId)).fileId
        this.setData({ coverFileId: recipe.coverFileId, coverLocalPath: '' })
        this.keepDraft()
      }
      return request(data.mode === 'wish' ? 'saveWish' : 'saveRecipe', payload)
    }).then(async result => {
      this.saved = true
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const previous = pages[pages.length - 2]
      const returnToSource = previous && (data.mode === 'wish'
        ? ['pages/wish-picker/index', 'pages/wishes/index'].includes(previous.route) || previous.route === 'pages/recipe/index' && previous.data && previous.data.wishId === data.wishId
        : previous.route === 'pages/menu-picker/index' || previous.route === 'pages/recipe/index' && previous.id === result.id)
      this.savedDestination = returnToSource ? { method: 'navigateBack', url: '' }
        : { method: data.mode === 'wish' ? 'switchTab' : 'redirectTo', url: data.mode === 'wish' ? '/pages/wishes/index' : `/pages/recipe/index?id=${result.id}` }
      wx.removeStorageSync(this.draftKey)
      if (this.legacyDraftKey) wx.removeStorageSync(this.legacyDraftKey)
      if (this.originalCoverFileId && this.originalCoverFileId !== recipe.coverFileId) await request('discardMedia', { fileId: this.originalCoverFileId }).catch(() => {})
      wx.showToast({ title: data.mode === 'wish' ? '心愿已保存' : '菜品已保存' })
      this.openSavedRecipe()
    }).catch(error => {
      if (error.code !== 'VERSION_CONFLICT') return alert(error)
      this.keepDraft()
      wx.showModal({ title: '内容已被更新', content: '伙伴已先保存，你的修改已存为草稿；重新载入会放弃本次修改', cancelText: '稍后处理', confirmText: '重新载入', success: async ({ confirm }) => {
        if (!confirm) return
        try {
          await this.refreshCatalog()
          await this.loadRecipe()
          wx.removeStorageSync(this.draftKey)
          if (this.legacyDraftKey) wx.removeStorageSync(this.legacyDraftKey)
          this.dirty = false
          wx.showToast({ title: '已载入最新内容', icon: 'none' })
        } catch (loadError) { alert(loadError) }
      } })
    }).finally(() => this.setData({ saving: false }))
  },
  openSavedRecipe() {
    if (!this.unloaded && this.savedDestination) return navigate(this, this.savedDestination.method, this.savedDestination.url)
  },
  saveCooking(recipe, externalUrl) {
    this.dirty = true
    this.setData({ saving: true, ...(externalUrl === undefined ? {} : { externalUrl }) })
    this.keepDraft()
    return withLoading(async () => {
      if (!this.data.pendingRecordPayload) {
        const photoFileIds = await uploadRecordPhotos(this)
        this.setData({ pendingRecordPayload: { requestId: this.data.requestId,
          newRecipe: { ...recipe, coverFileId: photoFileIds[0] || '', photoFileIds },
          addToMenu: this.data.addToMenu, date: this.data.date, note: this.data.note.trim(), photoFileIds } })
        this.keepDraft()
      }
      return request('saveRecord', this.data.pendingRecordPayload)
    }).then(record => {
      this.saved = true
      this.setData({ savedRecordId: record.id, pendingRecordPayload: null })
      wx.removeStorageSync(this.draftKey)
      wx.showToast({ title: '记下来啦' })
      if (!this.unloaded) navigate(this, 'redirectTo', `/pages/record-edit/index?id=${record.id}`)
    }).catch(error => {
      if (['INVALID_INPUT', 'INVALID_MEDIA', 'NOT_FOUND', 'FORBIDDEN', 'NO_SPACE', 'VERSION_CONFLICT', 'INVALID_STATE'].includes(error.code)) this.setData({ pendingRecordPayload: null })
      this.keepDraft()
      alert(error)
    })
      .finally(() => this.setData({ saving: false }))
  },
})
