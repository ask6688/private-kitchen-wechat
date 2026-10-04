const { request, alert, memberSpace, setSpaceTitle } = require('../../utils/api')

Page({
  data: { kind: 'category', label: '分类', items: [], name: '', editingId: '', openId: '', showEditor: false, version: 0, loading: true, saving: false, error: '' },
  onLoad(options) { this.setData({ kind: options.kind === 'tag' ? 'tag' : 'category', label: options.kind === 'tag' ? '标签' : '分类' }) },
  onShow() { setSpaceTitle('分类与标签'); return this.load() },
  onHide() { this.loadToken = (this.loadToken || 0) + 1 },
  onUnload() { this.onHide() },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ loading: true, error: '' })
    try { const data = await memberSpace(); if (data && token === this.loadToken) { setSpaceTitle('分类与标签'); this.apply(data.space) } }
    catch (error) { if (token === this.loadToken) this.setData({ error: error.message }) }
    finally { if (token === this.loadToken) this.setData({ loading: false }) }
  },
  apply(catalog) {
    this.catalog = catalog
    this.setData({ items: (catalog[this.data.kind === 'tag' ? 'tags' : 'categories'] || []).filter(item => !item.deletedAt), version: catalog.catalogVersion || 0 })
  },
  switchKind(e) {
    if (this.data.saving || this.data.loading) return
    const kind = e.currentTarget.dataset.kind
    if (kind === this.data.kind) return
    this.setData({ kind, label: kind === 'tag' ? '标签' : '分类', name: '', editingId: '', openId: '', showEditor: false })
    if (this.catalog) this.apply(this.catalog)
    else this.load()
  },
  input(e) { this.setData({ name: e.detail.value }) },
  openEditor() { if (!this.data.loading && !this.data.saving) this.setData({ editingId: '', name: '', openId: '', showEditor: true }) },
  edit(e) { const item = this.data.items.find(item => item.id === e.currentTarget.dataset.id); if (item) this.setData({ editingId: item.id, name: item.name, openId: '', showEditor: true }) },
  reset() { if (!this.data.saving) this.setData({ editingId: '', name: '', showEditor: false }) },
  noop() {},
  rowTap() { if (this.data.openId) this.setData({ openId: '' }) },
  swipeStart(e) { this.swipeOrigin = { id: e.currentTarget.dataset.id, x: e.touches[0].clientX, y: e.touches[0].clientY } },
  swipeEnd(e) {
    const start = this.swipeOrigin
    this.swipeOrigin = null
    if (!start || start.id !== e.currentTarget.dataset.id || !e.changedTouches.length) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) this.setData({ openId: dx < 0 ? start.id : '' })
  },
  async save() {
    if (this.data.saving || this.data.loading) return
    const name = this.data.name.trim()
    if (!name) return wx.showToast({ title: `请填写${this.data.label}名称`, icon: 'none' })
    await this.mutate({ op: this.data.editingId ? 'rename' : 'create', ...(this.data.editingId ? { id: this.data.editingId } : {}), name })
  },
  remove(e) {
    const item = this.data.items.find(item => item.id === e.currentTarget.dataset.id)
    if (!item || this.data.saving) return
    this.setData({ openId: '' })
    wx.showModal({ title: `删除“${item.name}”？`, content: this.data.kind === 'category' ? '相关菜品会变为未分类，菜品和记录都会保留' : '从菜品上移除这个标签，菜品和记录都会保留', confirmText: '删除', confirmColor: '#A24D3D', success: ({ confirm }) => { if (confirm) this.mutate({ op: 'delete', id: item.id }) } })
  },
  async mutate(payload) {
    this.setData({ saving: true })
    try {
      const catalog = await request('manageTaxonomy', { kind: this.data.kind, version: this.data.version, ...payload })
      this.apply(catalog)
      this.setData({ editingId: '', name: '', showEditor: false })
      wx.showToast({ title: payload.op === 'delete' ? '已删除' : '已保存' })
    } catch (error) {
      alert(error)
      if (error.code === 'VERSION_CONFLICT') await this.load()
    } finally { this.setData({ saving: false }) }
  },
})
