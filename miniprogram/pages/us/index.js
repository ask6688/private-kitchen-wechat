const { request, alert, memberSpace, withLoading, setSpaceTitle } = require('../../utils/api')
const { navigate } = require('../../utils/navigation')

Page({
  data: { space: null, member: null, members: [], invite: null, loading: true, error: '', renaming: false, renameName: '', renameReady: false, savingName: false },
  onShow() { setSpaceTitle('我们'); this.load() },
  onHide() { this.loadToken = (this.loadToken || 0) + 1; this.setData({ loading: false }) },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  async load() {
    const token = this.loadToken = (this.loadToken || 0) + 1
    this.setData({ space: null, member: null, members: [], loading: true, error: '' })
    try {
      const data = await memberSpace()
      if (!data || token !== this.loadToken) return
      setSpaceTitle('我们')
      const members = await request('listMembers')
      if (token !== this.loadToken) return
      const space = { ...data.space, mediaUsage: `${((data.space.mediaBytes || 0) / 1024 / 1024).toFixed(1)} / 512 MB` }
      this.setData({ space, member: data.member, members,
        renameReady: this.data.renaming && !!this.data.renameName.trim() && this.data.renameName.trim() !== space.name,
        invite: data.space.memberCount < 2 ? this.data.invite : null,
        loading: false })
    } catch (error) { if (token === this.loadToken) this.setData({ loading: false, error: error.message }) }
  },
  startRename() {
    if (this.data.space) this.setData({ renaming: true, renameName: this.data.space.name, renameReady: false })
  },
  onRenameName(e) {
    const renameName = e.detail.value
    const name = renameName.trim()
    this.setData({ renameName, renameReady: !!name && name !== this.data.space.name })
  },
  cancelRename() {
    if (!this.data.savingName) this.setData({ renaming: false, renameName: '', renameReady: false })
  },
  async saveName() {
    if (this.data.savingName || !this.data.renameReady) return
    const name = this.data.renameName.trim()
    if (!name || name === this.data.space.name) return
    this.setData({ savingName: true })
    try {
      const space = await withLoading(() => request('renameSpace', { name }))
      this.setData({ space: { ...space, mediaUsage: this.data.space.mediaUsage }, renaming: false, renameName: '', renameReady: false })
      setSpaceTitle('我们')
      await this.load()
      wx.showToast({ title: '厨房名已更新' })
    } catch (error) { alert(error) }
    finally { this.setData({ savingName: false }) }
  },
  invite() {
    withLoading(() => request('createInvite')).then(invite => this.setData({ invite })).catch(alert)
  },
  copy() {
    wx.setClipboardData({ data: this.data.invite.code, success: () => wx.showToast({ title: '邀请码已复制' }) })
  },
  transfer(e) {
    const target = this.data.members.find(item => item.id === e.currentTarget.dataset.id)
    if (!target) return
    wx.showModal({ title: '移交负责人？', content: `${target.displayName}会成为厨房负责人，你仍能一起管理`, confirmText: '确认移交', success: ({ confirm }) => {
      if (confirm) withLoading(() => request('transferOwner', { userId: target.id })).then(() => this.load()).catch(alert)
    } })
  },
  remove(e) {
    const target = this.data.members.find(item => item.id === e.currentTarget.dataset.id)
    if (!target) return
    wx.showModal({ title: `移除${target.displayName}？`, content: '对方将无法进入厨房，共同保存的内容会保留', confirmText: '确认移除', confirmColor: '#A24D3D', success: ({ confirm }) => {
      if (confirm) withLoading(() => request('removeMember', { userId: target.id })).then(() => this.load()).catch(alert)
    } })
  },
  leave() {
    wx.showModal({ title: '退出这间厨房？', content: '退出后无法查看这里的菜谱、饭单和照片，共同内容会保留', confirmText: '确认退出', confirmColor: '#A24D3D', success: ({ confirm }) => {
      if (confirm) withLoading(() => request('leaveSpace')).then(() => navigate(this, 'reLaunch', '/pages/welcome/index')).catch(alert)
    } })
  },
  taxonomy() { navigate(this, 'navigateTo', '/pages/taxonomy/index') },
  async collectExport() {
    const names = ['recipes', 'wishes', 'meals', 'cooking_records', 'activity_logs']
    const collections = {}
    const photos = new Set()
    for (const collection of names) {
      const items = []
      let offset = 0
      while (true) {
        const page = await request('exportData', { collection, offset })
        items.push(...page.items)
        for (const fileId of page.fileIds) photos.add(fileId)
        offset += page.items.length
        if (!page.hasMore) break
        if (!page.items.length || offset > 10000) throw new Error('导出数据较多，请在云控制台分批导出')
      }
      collections[collection] = items
    }
    const space = (await request('bootstrap')).space
    const text = JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), spaceName: this.data.space.name,
      catalog: { categories: space.categories || [], tags: space.tags || [], catalogVersion: space.catalogVersion || 0 },
      note: '此 JSON 不含照片原图；photoFileIds 是照片的云存储标识', collections, photoFileIds: [...photos] }, null, 2)
    if (text.length > 2 * 1024 * 1024) throw new Error('记录过多，请在云控制台导出完整数据')
    return text
  },
  exportData() {
    withLoading(() => this.collectExport().then(text => new Promise((resolve, reject) => {
      const filePath = `${wx.env.USER_DATA_PATH}/private-kitchen-export.json`
      wx.getFileSystemManager().writeFile({ filePath, data: text, encoding: 'utf8', success: () => resolve(filePath), fail: reject })
    }))).then(filePath => {
      wx.shareFileMessage({ filePath, fileName: '私人厨房记录.json', fail: error => alert(new Error(error.errMsg || '文件分享失败，请在真机上重试')) })
    }).catch(alert)
  },
  onShareAppMessage() {
    const invite = this.data.invite
    return { title: `来加入${this.data.space.name}，一起安排下一顿饭`,
      path: invite ? `/pages/welcome/index?code=${invite.code}` : '/pages/welcome/index' }
  },
})
