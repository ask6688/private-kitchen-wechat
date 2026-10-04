const { request, alert, withLoading } = require('../../utils/api')
const { navigate } = require('../../utils/navigation')

Page({
  data: { name: '', displayName: '', code: '', loading: true, error: '' },
  onLoad(options = {}) {
    this.setData({ code: options.code || '' })
    return this.retry()
  },
  onUnload() { this.unloaded = true },
  retry() {
    this.setData({ loading: true, error: '' })
    if (this.kitchenReady) return this.openKitchen()
    return request('bootstrap').then(({ space }) => {
      if (this.unloaded) return
      if (space) { this.kitchenReady = true; this.openKitchen() }
      else this.setData({ loading: false })
    }).catch(error => { if (!this.unloaded) this.setData({ loading: false, error: error.message }) })
  },
  openKitchen() {
    this.destination = this.destination || getApp().globalData.returnAfterJoin || '/pages/menu/index'
    delete getApp().globalData.returnAfterJoin
    const tab = ['/pages/menu/index', '/pages/wishes/index', '/pages/records/index', '/pages/us/index'].includes(this.destination.split('?')[0])
    navigate(this, tab ? 'switchTab' : 'reLaunch', tab ? this.destination.split('?')[0] : this.destination,
      () => this.setData({ loading: false, error: '厨房已准备好，但页面未打开' }))
  },
  onName(e) { this.setData({ name: e.detail.value }) },
  onDisplayName(e) { this.setData({ displayName: e.detail.value }) },
  onCode(e) { this.setData({ code: e.detail.value }) },
  create() {
    const name = this.data.name.trim()
    if (!name) return wx.showToast({ title: '给厨房起个名字吧', icon: 'none' })
    withLoading(() => request('createSpace', { name, displayName: this.data.displayName.trim() })).then(() => {
      this.kitchenReady = true
      this.openKitchen()
    }).catch(alert)
  },
  join() {
    const code = this.data.code.trim()
    if (!code) return wx.showToast({ title: '请输入邀请码', icon: 'none' })
    withLoading(() => request('joinSpace', { code, displayName: this.data.displayName.trim() })).then(() => {
      this.kitchenReady = true
      this.openKitchen()
    }).catch(alert)
  },
})
