const assert = require('node:assert/strict')
const appConfig = require('../miniprogram/app.json')
const { navigate } = require('../miniprogram/utils/navigation')
const pages = [{ route: 'pages/meal/index' }]
const calls = []
const toasts = []
let loading = false
const settle = () => new Promise(resolve => setImmediate(resolve))
global.getCurrentPages = () => pages
global.getApp = () => ({ globalData: { configError: '' } })
global.wx = {
  navigateTo: options => calls.push(options),
  reLaunch: options => calls.push(options),
  showToast: options => toasts.push(options.title),
  showLoading: () => { loading = true },
  hideLoading: () => { loading = false },
  cloud: { callFunction: async () => ({ result: { ok: true, data: { space: null } } }) },
}

async function main() {
  assert.equal(appConfig.pages[0], 'pages/menu/index', 'normal launch starts on its real destination')
  const page = pages[0]
  navigate(page, 'navigateTo', '/pages/wish-picker/index?mealId=meal00001')
  navigate(page, 'navigateTo', '/pages/wish-picker/index?mealId=meal00001')
  assert.deepEqual(calls.map(item => item.url), ['/pages/wish-picker/index?mealId=meal00001'], 'rapid taps create one direct transition')
  calls[0].fail({ errMsg: 'navigation failed' })
  assert.ok(toasts.includes('页面未打开，请再试一次'))
  navigate(page, 'navigateTo', '/pages/wish-picker/index?mealId=meal00001')
  assert.deepEqual(calls.map(item => item.url), ['/pages/wish-picker/index?mealId=meal00001', '/pages/wish-picker/index?mealId=meal00001'], 'failed route can be retried')
  calls[1].success()
  pages[0] = { route: 'pages/wishes/index' }
  assert.equal(navigate(page, 'navigateTo', '/pages/meal/index?id=meal00001'), false)
  assert.equal(calls.length, 2, 'a late save response cannot navigate away from the page the user has opened')

  const { request, memberSpace, withLoading } = require('../miniprogram/utils/api')
  await assert.rejects(() => withLoading(() => { throw new Error('同步失败') }), /同步失败/)
  assert.equal(loading, false, 'synchronous action failures also dismiss the loading indicator')

  let finishBootstrap
  wx.cloud.callFunction = () => new Promise(resolve => { finishBootstrap = resolve })
  const stale = memberSpace()
  pages[0] = { route: 'pages/records/index' }
  finishBootstrap({ result: { ok: true, data: { space: null } } })
  await stale
  assert.equal(calls.length, 2, 'an old page cannot redirect the new page after a slow identity response')

  let resolved = false
  const current = memberSpace().then(value => { resolved = true; return value })
  finishBootstrap({ result: { ok: true, data: { space: null } } })
  await settle()
  assert.equal(calls.at(-1).url, '/pages/welcome/index')
  assert.equal(resolved, false, 'identity recovery waits for the welcome page to open')
  calls.at(-1).success()
  assert.equal(await current, null)

  const failed = memberSpace()
  const rejected = assert.rejects(failed, /未打开.*重试|navigation failed/)
  finishBootstrap({ result: { ok: true, data: { space: null } } })
  await settle()
  calls.at(-1).fail({ errMsg: 'navigation failed' })
  await rejected
  const retry = memberSpace()
  finishBootstrap({ result: { ok: true, data: { space: null } } })
  await settle()
  assert.equal(calls.at(-1).url, '/pages/welcome/index', 'failed identity navigation can be retried')
  calls.at(-1).success()
  await retry
  wx.cloud.callFunction = async () => { throw { errMsg: 'cloud.callFunction:fail Error: network timeout', errCode: -1 } }
  await assert.rejects(() => request('saveMeal'), { message: '暂时没收到结果，请重试', code: -1 })
  wx.cloud.callFunction = async () => ({ result: { ok: false, error: { code: 'VERSION_CONFLICT', message: '伙伴刚修改了这条记录，请刷新后核对' } } })
  await assert.rejects(() => request('saveMeal'), { message: '伙伴刚修改了这条记录，请刷新后核对', code: 'VERSION_CONFLICT' })
  console.log('导航自检通过：直达、防重复、离页后迟到响应、身份跳转失败重试、同步异常结束加载')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
