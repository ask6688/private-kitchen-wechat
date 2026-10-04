const assert = require('node:assert/strict')
let definition
const app = { globalData: { configError: '', spaceName: '' } }
const pendingMeals = []
const storage = new Map()
let activePage
const settle = () => new Promise(resolve => setImmediate(resolve))
const ok = data => ({ result: { ok: true, data } })
const meal = title => ({ id: 'meal-loading-001', spaceId: 'space-loading', version: 1,
  title, date: '2026-10-02', diners: 2, note: '', status: 'draft', items: [], photoFileIds: [], reflection: '' })
global.Page = value => { definition = value }
global.getApp = () => app
global.getCurrentPages = () => activePage ? [activePage] : []
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key),
  setNavigationBarTitle() {}, showToast() {}, disableAlertBeforeUnload() {}, enableAlertBeforeUnload() {},
  cloud: { callFunction({ data: { action } }) {
    if (action === 'bootstrap') return Promise.resolve(ok({ space: { id: 'space-loading' }, member: { id: 'member-loading' } }))
    if (action === 'getMeal') return new Promise((resolve, reject) => pendingMeals.push({ resolve, reject }))
    throw new Error(`Unexpected request: ${action}`)
  } },
}
require('../miniprogram/pages/meal/index')
function makePage(options = { id: 'meal-loading-001' }) {
  const page = { ...definition, route: 'pages/meal/index', data: structuredClone(definition.data),
    setData(fields, callback) {
      for (const [key, value] of Object.entries(fields)) {
        const parts = key.split('.'); let target = this.data
        while (parts.length > 1) { const next = parts.shift(); target = target[next] ||= {} }
        target[parts[0]] = value
      }
      if (callback) callback()
    },
    withCovers: async value => value, initMemoryDraft: async () => {}, retryImages: async () => {}, restoreForm() {},
  }
  page.onLoad(options)
  activePage = page
  return page
}
async function main() {
  const page = makePage()
  const first = page.load(); await settle()
  const second = page.load(); await settle()
  pendingMeals.shift().resolve(ok(meal('旧响应')))
  await first
  assert.equal(page.data.loading, true, 'a stale response must not end the newer request loading state')
  assert.equal(page.data.meal, null, 'a stale response must not expose old meal content')
  pendingMeals.shift().resolve(ok(meal('当前响应')))
  await second
  assert.equal(page.data.meal.title, '当前响应')
  assert.equal(page.data.loading, false)
  assert.equal(page.data.loadReady, true, 'a successful meal request unlocks the form')

  const memoryWait = makePage()
  let releaseMemory
  memoryWait.initMemoryDraft = () => new Promise(resolve => { releaseMemory = resolve })
  const beforeMemory = memoryWait.load(); await settle()
  pendingMeals.shift().resolve(ok(meal('较早的记录')))
  await settle()
  const afterMemory = memoryWait.load(); await settle()
  releaseMemory()
  await beforeMemory
  assert.equal(memoryWait.data.loading, true, 'an older draft restore cannot dismiss a newer meal request')
  memoryWait.initMemoryDraft = async () => {}
  pendingMeals.shift().resolve(ok(meal('重新打开的记录')))
  await afterMemory
  assert.equal(memoryWait.data.meal.title, '重新打开的记录')

  const hidden = makePage()
  const inFlight = hidden.load(); await settle()
  hidden.onHide(); activePage = { route: 'pages/records/index' }
  pendingMeals.shift().resolve(ok(meal('离页后的响应')))
  await inFlight
  assert.equal(hidden.data.meal, null, 'a request finished after leaving does not publish stale form content')
  assert.notEqual(hidden.data.loadReady, true)

  const failed = makePage()
  const unavailable = failed.load(); await settle()
  pendingMeals.shift().reject(new Error('网络暂时不可用'))
  await unavailable
  assert.equal(failed.data.loading, false)
  assert.equal(failed.data.loadReady, false, 'cold-entry failure must not look like a loaded empty meal')
  assert.match(failed.data.error, /网络暂时不可用/)
  const retried = failed.load(); await settle()
  pendingMeals.shift().resolve(ok(meal('重试成功')))
  await retried
  assert.equal(failed.data.loadReady, true)
  assert.equal(failed.data.error, '')

  const direct = makePage({ mode: 'record' })
  await direct.load()
  assert.equal(direct.data.loading, false)
  assert.equal(direct.data.loadReady, true, 'direct recording becomes ready without requiring an existing meal')
  assert.equal(direct.data.meal.id, '')
  assert.equal(direct.data.recordMode, true)
  const routes = []
  wx.reLaunch = wx.switchTab = options => routes.push(options)
  require('../miniprogram/pages/welcome/index')
  const welcome = { ...definition, route: 'pages/welcome/index', data: structuredClone(definition.data),
    setData(fields) { Object.assign(this.data, fields) } }
  activePage = welcome
  app.globalData.returnAfterJoin = '/pages/meal/index?id=meal-loading-001'
  await welcome.onLoad({})
  assert.deepEqual(routes.map(route => route.url), ['/pages/meal/index?id=meal-loading-001'], 'identity recovery opens its saved destination without visiting home')
  routes[0].fail({ errMsg: 'navigation failed' })
  assert.equal(welcome.data.loading, false, 'welcome navigation failure ends loading')
  assert.ok(welcome.data.error)
  await welcome.retry()
  assert.equal(routes.at(-1).url, '/pages/meal/index?id=meal-loading-001', 'retry keeps the original destination')
  routes.at(-1).success()
  console.log('页面生命周期自检通过：慢响应竞争、离页失效、冷启动失败重试、直接补录、身份恢复直达原页')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
