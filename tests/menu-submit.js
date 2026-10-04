// 运行：node tests/menu-submit.js
const assert = require('node:assert/strict')
const selection = require('../miniprogram/utils/selection')

const storage = new Map()
const calls = []
const navigations = []
const toasts = []
let response
let config
global.getApp = () => ({ globalData: { configError: '' } })
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
  showLoading() {}, hideLoading() {}, showToast: value => toasts.push(value),
  navigateTo: value => navigations.push(value),
  cloud: { callFunction: async ({ data }) => { calls.push(data); return { result: response(data) } } },
}
global.Page = value => { config = value }
require('../miniprogram/pages/menu/index')

function page() {
  return { ...config, data: { ...config.data }, setData(fields) { Object.assign(this.data, fields) } }
}
function select() {
  selection.configure({ space: { id: 'space123' }, member: { id: 'member123' } })
  selection.clear()
  selection.add({ recipeId: 'recipe123', name: '番茄炒蛋' })
  calls.length = navigations.length = toasts.length = 0
}
const failed = { ok: false, error: { code: 'SERVER_ERROR', message: '暂时无法完成操作，请稍后重试' } }
const meal = { ok: true, data: { _id: 'meal1234' } }

async function main() {
  select()
  response = () => calls.length === 1 ? failed : meal
  await page().submit()
  assert.equal(calls.length, 2, 'transient server failure is retried once')
  assert.deepEqual(calls[0].payload, calls[1].payload, 'retry preserves requestId and items')
  assert.equal(navigations[0].url, '/pages/meal/index?id=meal1234')
  assert.equal(selection.items().length, 0, 'successful retry clears local picks')

  select()
  let commits = 0
  const receipts = new Map()
  response = ({ payload }) => {
    if (!receipts.has(payload.requestId)) { receipts.set(payload.requestId, meal); commits++ }
    return calls.length === 1 ? failed : receipts.get(payload.requestId)
  }
  await page().submit()
  assert.equal(commits, 1, 'a lost success response must not duplicate the meal')
  assert.equal(calls[0].payload.requestId, calls[1].payload.requestId)
  assert.equal(navigations.length, 1)

  select()
  response = () => failed
  await page().submit()
  assert.equal(calls.length, 2, 'persistent error is retried only once')
  assert.equal(toasts.length, 1, 'persistent error remains visible')
  assert.equal(selection.items().length, 1, 'failed submission retains local picks')
  assert.equal(navigations.length, 0)
  console.log('menu submission retry self-check passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
