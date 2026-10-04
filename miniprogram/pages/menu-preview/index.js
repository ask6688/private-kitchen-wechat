const { request, alert, setSpaceTitle } = require('../../utils/api')
const { photoItems, resolvePhotos } = require('../../utils/photos')
const { navigate } = require('../../utils/navigation')
const { groupsFor, layout, draw, decoration } = require('./render')
const { loadMenuFont } = require('./font')
const celebrationParticles = require('../../utils/celebration')
Page({
  data: { loading: true, error: '', renderError: '', exporting: false, image: '', overlay: false, closing: false,
    meal: null, dishGroups: [], menuHeight: 680, topInset: 44, particles: [] },
  onLoad(options = {}) {
    this.id = options.id || ''
    this.source = options.from || 'list'
    this.event = options.event || ''
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    this.setData({ topInset: info.statusBarHeight || 24 })
  },
  onReady() { this.ready = true; return this.load() },
  onShow() { setSpaceTitle(this.data.meal && this.data.meal.title || '这顿饭'); if (this.previewing) { this.previewing = false; return } if (this.ready) return this.load() },
  onHide() { clearTimeout(this.confettiTimer); clearTimeout(this.closeTimer); this.setData({ particles: [], ...(this.data.closing ? { overlay: false, closing: false } : {}) }) },
  onUnload() { this.unloaded = true; this.loadToken++; clearTimeout(this.confettiTimer); clearTimeout(this.closeTimer) },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try {
      if (!this.id) throw new Error('缺少这顿饭的记录信息，请返回列表选择')
      const [meal, records] = await Promise.all([request('getMeal', { id: this.id }), request('listRecords', { mealId: this.id })])
      if (token !== this.loadToken || this.unloaded) return
      setSpaceTitle(meal.title || '这顿饭')
      this.setData({ meal })
      this.menu = meal.menuSnapshot || { title: meal.title, date: meal.date, diners: meal.diners,
        groups: groupsFor((meal.items || []).filter(item => ['cooked', 'eaten'].includes(item.state)).map(item => ({ ...item, category: item.category || '未分类' })), []) }
      this.menu = { ...this.menu, statusLabel: meal.status === 'completed' ? '已完成 · 吃饭记录' : meal.status === 'confirmed' ? '待开饭 · 饭单' : meal.status === 'cancelled' ? '已取消' : '待确认 · 饭单' }
      this.setData({ image: '', renderError: '' })
      const dishGroups = this.menu.groups.map(group => ({ ...group, items: group.items.map(snapshot => {
        const item = (meal.items || []).find(item => item.id === snapshot.id) || snapshot
        const record = records.find(record => record.id === item.recordId)
        const memory = record || item.dishMemory || {}
        const photos = photoItems(memory.photoFileIds)
        return { ...snapshot, photos, displayPhotos: photos.slice(0, 1), reflection: record ? record.note || '' : memory.reflection || '',
          hasMemory: !!((memory.photoFileIds || []).length || (record ? record.note : memory.reflection)) }
      }) }))
      this.setData({ loading: false, menuView: this.menu, dishGroups })
      // Only dishes without a meal photo need a source cover; duplicate sources share one request.
      const sources = new Map()
      await Promise.all(dishGroups.flatMap(group => group.items).map(async dish => {
        if (dish.displayPhotos.length) return
        const item = (meal.items || []).find(item => item.id === dish.id) || dish
        const action = item.recipeId ? 'getRecipe' : item.wishId ? 'getWish' : ''
        if (!action) return
        const id = item.recipeId || item.wishId, key = action + id
        if (!sources.has(key)) sources.set(key, request(action, { id }).catch(() => null))
        const source = await sources.get(key)
        dish.displayPhotos = photoItems(source && (source.coverFileId || source.recipe && source.recipe.coverFileId))
      }))
      if (token !== this.loadToken || this.unloaded) return
      this.setData({ dishGroups })
      const celebration = getApp().globalData.mealCompletion
      if (meal.status === 'completed' && celebration && celebration.mealId === this.id && celebration.token === this.event) {
        delete getApp().globalData.mealCompletion
        this.showCompletion()
      }
      await this.retryDishPhotos()
      if (token === this.loadToken && !this.unloaded) await this.render()
    } catch (error) { if (!this.unloaded && token === this.loadToken) this.setData({ loading: false, error: error.message }) }
  },
  retry() { return this.load() },
  async render() {
    if (!this.menu || this.unloaded) return
    if (this.data.exporting) { this.renderAgain = true; return }
    const menu = this.menu, token = this.loadToken
    const current = () => !this.unloaded && menu === this.menu && token === this.loadToken
    this.setData({ exporting: true, renderError: '' })
    try {
      const canvas = await new Promise((resolve, reject) => this.createSelectorQuery().select('#paperCanvas').fields({ node: true, size: true })
        .exec(res => res[0] && res[0].node ? resolve(res[0].node) : reject(new Error('Menu 暂未生成，点此重试'))))
      if (!current()) return
      // Read local glyph contours once; draw them without the device font loader.
      if (!this.menuFontReady) this.menuFontReady = loadMenuFont().catch(error => { this.menuFontReady = null; throw error })
      const font = await this.menuFontReady
      if (!current()) return
      const fullMenu = { ...menu, groups: this.data.dishGroups.length ? this.data.dishGroups : menu.groups || [] }
      const urls = [...new Set(fullMenu.groups.flatMap(group => group.items.flatMap(item => (item.displayPhotos || []).map(photo => photo.url).filter(Boolean))))]
      if (fullMenu.groups.some(group => group.items.some(item => (item.displayPhotos || []).some(photo => !photo.url)))) throw new Error('有照片未加载')
      const images = new Map(await Promise.all(urls.map(url => new Promise((resolve, reject) => {
        const image = canvas.createImage()
        const finish = (error) => { clearTimeout(timer); image.onload = image.onerror = null; error ? reject(new Error('照片未能载入 Menu')) : resolve([url, image]) }
        const timer = setTimeout(() => finish(true), 15000)
        image.onload = () => finish(false); image.onerror = () => finish(true)
        // Canvas decodes the platform's local image, rather than a signed remote URL.
        wx.getImageInfo({ src: url, success: info => { if (image.onload) image.src = info.path }, fail: () => finish(true) })
      }))))
      if (!current()) return
      const ctx = canvas.getContext('2d'), page = layout(ctx, fullMenu, font)
      canvas.width = page.width * 2; canvas.height = page.height * 2; ctx.scale(2, 2); draw(ctx, fullMenu, page, images, font)
      const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: 'png', width: canvas.width,
        height: canvas.height, destWidth: canvas.width, destHeight: canvas.height, success: resolve, fail: reject }, this))
      if (!current()) return
      this.setData({ image: result.tempFilePath, menuHeight: page.height })
      // Reuse the same original decorations without exporting them again after every edit.
      if (this.data.cornerTop && this.data.cornerBottom) return
      ctx.clearRect(0, 0, page.width, page.height); decoration(ctx, page.height)
      const corner = (x, y, width, height) => new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas,
        x, y, width, height, destWidth: width * 2, destHeight: height * 2,
        fileType: 'png', success: result => resolve(result.tempFilePath), fail: reject }, this))
      const [cornerTop, cornerBottom] = await Promise.all([corner(0, 0, 120, 180), corner(480, page.height - 125, 120, 125)])
      if (current()) this.setData({ cornerTop, cornerBottom })
    } catch (error) { if (current()) this.setData({ renderError: error.message || error.errMsg || 'Menu 生成失败，记录已保存' }) }
    finally {
      if (!this.unloaded) {
        this.setData({ exporting: false })
        if (this.renderAgain) { this.renderAgain = false; await this.render() }
      }
    }
  },
  showCompletion() {
    this.setData({ overlay: true, closing: false, particles: celebrationParticles() })
    this.confettiTimer = setTimeout(() => { if (!this.unloaded) this.setData({ particles: [] }) }, 1250)
  },
  closeOverlay() {
    if (this.data.closing) return
    clearTimeout(this.confettiTimer)
    this.setData({ closing: true, particles: [] })
    this.closeTimer = setTimeout(() => { if (!this.unloaded) this.setData({ overlay: false, closing: false }) }, 180)
  },
  addCompletionMemory() {
    if (this.data.closing || this.routePending) return
    clearTimeout(this.confettiTimer); clearTimeout(this.closeTimer)
    this.setData({ overlay: false, closing: false, particles: [] })
    this.editInfo()
  },
  async retryDishPhotos() {
    const token = this.dishPhotoToken = (this.dishPhotoToken || 0) + 1, loadToken = this.loadToken
    const photos = this.data.dishGroups.flatMap(group => group.items.flatMap(item => item.displayPhotos))
    const resolved = await resolvePhotos(photos), byId = new Map(resolved.map(photo => [photo.fileId, photo]))
    if (token !== this.dishPhotoToken || loadToken !== this.loadToken || this.unloaded) return
    this.setData({ dishGroups: this.data.dishGroups.map(group => ({ ...group, items: group.items.map(item => ({ ...item,
      displayPhotos: item.displayPhotos.map(photo => byId.get(photo.fileId) || photo) })) })) })
  },
  dishPhotoEvent(e, state) {
    const { id, key, url } = e.currentTarget.dataset
    this.setData({ dishGroups: this.data.dishGroups.map(group => ({ ...group, items: group.items.map(item => item.id !== id ? item : ({ ...item,
      displayPhotos: item.displayPhotos.map(photo => photo.key === key && photo.url === url ? { ...photo, state } : photo) })) })) })
  },
  dishPhotoLoaded(e) { this.dishPhotoEvent(e, 'ready') },
  dishPhotoFailed(e) { this.dishPhotoEvent(e, 'error') },
  async previewDishPhoto(e) {
    const item = this.data.dishGroups.flatMap(group => group.items).find(item => item.id === e.currentTarget.dataset.id)
    if (!item) return
    const photos = await resolvePhotos(item.displayPhotos)
    if (photos.some(photo => !photo.url)) return alert(new Error('这道菜的照片暂时未加载，请重试'))
    if (photos.length) this.previewPhotos(photos.map(photo => photo.url))
  },
  noop() {},
  previewPhotos(urls) {
    this.previewing = true
    wx.previewImage({ urls, current: urls[0], fail: () => { this.previewing = false; alert(new Error('照片暂时无法预览，请重试')) } })
  },
  async retryMenu() { await this.retryDishPhotos(); return this.render() },
  async preview() {
    if (this.data.image) return this.previewPhotos([this.data.image])
    if (this.data.exporting) return wx.showToast({ title: 'Menu 正在绘制…', icon: 'none' })
    await this.retryMenu()
    if (this.data.image) this.previewPhotos([this.data.image])
  },
  editInfo() { if (this.data.meal && this.data.meal.status === 'completed') navigate(this, 'navigateTo', `/pages/meal/index?id=${this.id}&mode=record&return=detail`) },
  dish(e) {
    const item = (this.data.meal.items || []).find(item => item.id === e.currentTarget.dataset.id)
    if (!item) return
    if (this.data.meal.status === 'completed') navigate(this, 'navigateTo', `/pages/record-edit/index?mealId=${this.id}&itemId=${item.id}`)
  },
  back() {
    if (this.data.overlay) return this.closeOverlay()
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    const previous = pages[pages.length - 2]
    const expected = this.source === 'recent' ? 'pages/records/index' : 'pages/record-list/index'
    navigate(this, previous && previous.route === expected ? 'navigateBack' : this.source === 'recent' ? 'switchTab' : 'redirectTo',
      previous && previous.route === expected ? '' : this.source === 'recent' ? '/pages/records/index' : '/pages/record-list/index?kind=meals')
  },
})
