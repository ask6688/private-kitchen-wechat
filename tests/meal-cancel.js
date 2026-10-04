const assert = require('node:assert/strict')

let page
let modal
let mode
let saveCalls = 0
let latest
const navigation = []
const baseMeal = { _id: 'meal00001', id: 'meal00001', version: 1, status: 'draft',
  title: '一起开饭', date: '2026-09-29', diners: 2, note: '', items: [{ id: 'item00001', name: '越南粉' }] }
const success = data => ({ result: { ok: true, data } })
const serverError = () => ({ result: { ok: false, error: { code: 'SERVER_ERROR', message: '暂时无法完成操作，请稍后重试' } } })
global.getApp = () => ({ globalData: { configError: '' } })
global.wx = {
  showModal: options => { modal = options },
  showLoading() {}, hideLoading() {}, showToast() {}, setNavigationBarTitle() {},
  switchTab: options => { navigation.push(options.url); if (options.success) options.success() },
  cloud: { callFunction: async ({ data }) => {
    if (data.action === 'getMeal') return success(latest)
    assert.equal(data.action, 'saveMeal')
    assert.equal(data.payload.status, 'cancelled')
    saveCalls++
    if (saveCalls === 1 && mode !== 'success') {
      if (mode === 'committed') latest = { ...latest, status: 'cancelled', version: 2 }
      if (mode === 'conflict') latest = { ...latest, version: 2 }
      return serverError()
    }
    latest = { ...latest, status: 'cancelled', version: 2 }
    return success(latest)
  } }
}
global.Page = definition => { page = { ...definition, data: { ...definition.data }, setData(fields, callback) { for (const [key, value] of Object.entries(fields)) { const parts = key.split('.'); let target = this.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = value } if (callback) callback() } } }
require('../miniprogram/pages/meal/index')

async function cancel(testMode) {
  mode = testMode
  saveCalls = 0
  latest = { ...baseMeal }
  navigation.length = 0
  page.id = baseMeal.id
  page.setData({ meal: latest, status: 'draft', title: latest.title, date: latest.date,
    diners: String(latest.diners), note: '', error: '' })
  page.cancel()
  await modal.success({ confirm: true })
}

async function main() {
  await cancel('transient')
  assert.equal(saveCalls, 2, 'retry once only when the first request did not commit')
  assert.deepEqual(navigation, ['/pages/menu/index'])
  await cancel('committed')
  assert.equal(saveCalls, 1, 'a committed response lost in transit must not write twice')
  assert.deepEqual(navigation, ['/pages/menu/index'])
  await cancel('conflict')
  assert.equal(saveCalls, 1, 'a partner update must not be overwritten')
  assert.deepEqual(navigation, [], 'conflict keeps the meal page open')
  assert.match(page.data.error, /伙伴改了饭单.*输入还在/)
  console.log('饭单取消状态核对与导航自检通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
