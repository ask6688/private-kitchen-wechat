function request(action, payload = {}) {
  const configError = getApp().globalData.configError
  if (configError) return Promise.reject(new Error(configError))
  return wx.cloud.callFunction({ name: 'kitchen', data: { action, payload } }).then(({ result, requestID }) => {
    if (!result || !result.ok) {
      const error = new Error(result && result.error && result.error.message || '请求失败，请稍后重试')
      error.code = result && result.error && result.error.code
      error.requestId = requestID
      throw error
    }
    const data = normalize(result.data)
    const globalData = getApp().globalData
    if (['bootstrap', 'createSpace', 'joinSpace'].includes(action)) globalData.spaceName = data.space ? data.space.name : ''
    else if (action === 'renameSpace') globalData.spaceName = data.name
    else if (action === 'leaveSpace') globalData.spaceName = ''
    return data
  }).catch(error => {
    console.warn('[kitchen-request]', { action, requestId: error && error.requestId || '', code: error && (error.code || error.errCode) || '', message: error && (error.message || error.errMsg) || '' })
    if (/^cloud\.callFunction:fail/.test(error && (error.message || error.errMsg) || '')) {
      const wrapped = new Error('暂时没收到结果，请重试')
      wrapped.code = error.code || error.errCode
      wrapped.requestId = error.requestId
      throw wrapped
    }
    if (error instanceof Error && error.message) throw error
    const wrapped = new Error(error && (error.message || error.errMsg) || '网络连接失败，请稍后重试')
    wrapped.code = error && error.code
    throw wrapped
  })
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  const item = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
  if (item._id && !item.id) item.id = item._id
  return item
}

function alert(error) {
  wx.showToast({ title: error && (error.message || error.errMsg) || '操作失败', icon: 'none', duration: 2800 })
}

async function withLoading(action) {
  wx.showLoading({ title: '正在处理…', mask: true })
  try { return await action() } finally { wx.hideLoading() }
}

let openingWelcome = false
function memberSpace() {
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
  const source = pages[pages.length - 1]
  return request('bootstrap').then(async data => {
    if (!data.space) {
      const currentPages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
      const active = currentPages[currentPages.length - 1]
      if (!openingWelcome && (!source || active === source) && (!active || active.route !== 'pages/welcome/index')) {
        if (source && source.route) {
          const query = Object.entries(source.options || {}).filter(([, value]) => value != null)
            .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
          getApp().globalData.returnAfterJoin = `/${source.route}${query ? `?${query}` : ''}`
        }
        openingWelcome = true
        try {
          await new Promise((resolve, reject) => wx.reLaunch({ url: '/pages/welcome/index', success: resolve,
            fail: () => reject(new Error('厨房入口未打开，请重试')) }))
        } finally { openingWelcome = false }
      }
      return null
    }
    openingWelcome = false
    return data
  })
}

function setSpaceTitle(section) {
  const name = getApp().globalData.spaceName
  wx.setNavigationBarTitle({ title: name ? `${name} · ${section}` : section })
}

async function mediaUrls(fileIds) {
  const ids = [...new Set((fileIds || []).filter(id => typeof id === 'string' && id))]
  if (!ids.length) return {}
  const fetch = async batch => {
    try { return await request('mediaUrls', { fileIds: batch }) }
    catch (error) {
      if (error.code !== 'INVALID_MEDIA' || batch.length === 1) throw error
      // One deleted or invalid reference must not hide the other, authorized photos.
      return merge(await Promise.allSettled(batch.map(fileId => request('mediaUrls', { fileIds: [fileId] }))))
    }
  }
  const merge = results => {
    const ok = results.filter(result => result.status === 'fulfilled')
    if (!ok.length) throw results[0].reason
    return Object.assign({}, ...ok.map(result => result.value.urls || result.value || {}))
  }
  const batches = []
  for (let i = 0; i < ids.length; i += 30) batches.push(fetch(ids.slice(i, i + 30)))
  return merge(await Promise.allSettled(batches))
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

module.exports = { request, alert, withLoading, memberSpace, setSpaceTitle, mediaUrls, formatDate }
