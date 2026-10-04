function navigate(page, method, url, onFail) {
  const stack = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  if (page.routePending || page.route && stack.length && stack[stack.length - 1] !== page) return false
  page.routePending = true
  if (page.keepForm && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload()
  const fail = error => {
    page.routePending = false
    if (page.keepMemoryDraft) page.keepMemoryDraft()
    if (onFail) onFail(error)
    wx.showToast({ title: '页面未打开，请再试一次', icon: 'none' })
  }
  try {
    wx[method]({ ...(url ? { url } : {}), success: () => { page.routePending = false }, fail })
  } catch (error) { fail(error) }
  return true
}

function openMealDetail(page, meal, celebrate = false) {
  page.savedMealId = meal.id
  if (celebrate && meal.status === 'completed') {
    if (!page.completionToken) page.completionToken = `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`
    getApp().globalData.mealCompletion = { mealId: meal.id, token: page.completionToken }
  }
  return navigate(page, 'redirectTo', `/pages/menu-preview/index?id=${meal.id}&from=complete&event=${page.completionToken || ''}`, () => {
    page.setData({ openSaved: true, error: '记录已保存，详情未打开，点此重试即可' })
  })
}
module.exports = { navigate, openMealDetail }
