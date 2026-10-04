const config = require('./config')

App({
  globalData: { configError: '', spaceName: '' },
  onLaunch() {
    if (!wx.cloud) {
      this.globalData.configError = '当前微信版本不支持云开发，请更新微信'
    } else if (!config.envId || config.envId === '请填写云开发环境ID') {
      this.globalData.configError = '请在 miniprogram/config.js 中填写云开发环境 ID'
    } else {
      wx.cloud.init({ env: config.envId, traceUser: true })
    }
  },
})
