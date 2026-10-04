const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

let page
let modal
let failSave = false
let failSaveOnce = false
let definiteFailure = false
let loadingAction
let commitButFailOnce = false
let holdSave = false
let failRemove = true
let releaseSave
let saveCalls = 0
const navigation = []
const toasts = []
const base = { _id: 'meal00001', id: 'meal00001', version: 1, status: 'draft', title: '周末晚饭',
  date: '2026-09-29', diners: 2, note: '很长的备注'.repeat(80),
  items: [{ id: 'item00001', recipeId: 'recipe00001', name: '越南粉', state: 'planned' }] }
let stored = { ...base }
const ok = data => ({ result: { ok: true, data } })
global.getApp = () => ({ globalData: { configError: '', spaceName: '我们的厨房' } })
const drafts = new Map()
global.wx = {
  getStorageSync: key => drafts.get(key), setStorageSync: (key, value) => drafts.set(key, value), removeStorageSync: key => drafts.delete(key),
  redirectTo: options => { navigation.push(options.url); if (options.success) options.success() },
  showLoading() { loadingAction = mealPage.data.savingAction; assert.equal(mealPage.data.saving, true, 'busy state renders before loading') }, hideLoading() {}, setNavigationBarTitle() {},
  showToast: options => toasts.push(options.title), showModal: options => { modal = options },
  switchTab: options => { navigation.push(options.url); if (options.success) options.success() },
  cloud: { callFunction: async ({ data }) => {
    const { action, payload } = data
    if (action === 'bootstrap') return ok({ space: { _id: 'space00001', currentMealId: stored.id }, member: { _id: 'member00001' } })
    if (action === 'getMeal') return ok(stored)
    if (action === 'getRecipe') return ok({ _id: payload.id, coverFileId: 'cloud://dish-photo' })
    if (action === 'mediaUrls') return ok({ urls: { 'cloud://dish-photo': 'https://example.test/dish.jpg' } })
    if (action === 'listRecords') return ok([])
    if (action === 'listMeals') return ok([stored, { ...base, id: 'cancelled01', _id: 'cancelled01', status: 'cancelled' }])
    if (action === 'removeMealItem') return failRemove
      ? { result: { ok: false, error: { code: 'SERVER_ERROR', message: '移出失败' } } }
      : ok(stored = { ...stored, version: stored.version + 1, items: stored.items.filter(item => item.id !== payload.itemId) })
    if (action !== 'saveMeal') throw new Error(`unexpected ${action}`)
    saveCalls++
    if (definiteFailure) return { result: { ok: false, error: { code: 'INVALID_STATE', message: '模拟明确失败' } } }
    if (holdSave) await new Promise(resolve => { releaseSave = resolve })
    if (failSaveOnce) { failSaveOnce = false; return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '暂时无法完成操作' } } } }
    if (failSave) return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '暂时无法保存' } } }
    assert.equal(payload.id, base.id)
    assert.equal(payload.version, stored.version)
    stored = { ...stored, ...payload, version: stored.version + 1 }
    if (commitButFailOnce) { commitButFailOnce = false; return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '暂时无法完成操作' } } } }
    return ok(stored)
  } }
}
global.Page = definition => { page = { ...definition, data: { ...definition.data }, setData(fields, callback) { for (const [key, value] of Object.entries(fields)) { const parts = key.split('.'); let target = this.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = value } if (callback) callback() } } }
require('../miniprogram/pages/meal/index')
const mealPage = page

async function main() {
  mealPage.id = base.id
  await mealPage.load()
  assert.equal(mealPage.data.meal.items[0].coverUrl, 'https://example.test/dish.jpg')
  assert.equal(mealPage.data.note, base.note, 'old long notes remain intact')
  failSave = true
  await mealPage.saveCurrent()
  assert.equal(navigation.length, 0, 'failed save stays on the page')
  assert.equal(mealPage.data.note, base.note, 'failed save keeps entered text')
  failSave = false
  holdSave = true
  const beforeHold = saveCalls
  const first = mealPage.saveCurrent()
  await mealPage.saveCurrent()
  assert.equal(saveCalls, beforeHold + 1, 'double tap sends one new request')
  holdSave = false
  releaseSave()
  await first
  assert.deepEqual(navigation, ['/pages/menu/index'])
  assert.equal(stored.id, base.id)
  assert.equal(stored.version, 2)
  mealPage.setData({ openId: 'item00001' })
  await mealPage.removeItem('item00001')
  assert.equal(stored.items.length, 1, 'failed removal keeps the dish in this meal')
  assert.equal(mealPage.data.openId, '', 'failed removal closes the swipe action')
  assert.ok(toasts.includes('移出失败'))

  mealPage.applyMeal(stored)
  failSave = true
  await mealPage.confirm()
  assert.ok(!mealPage.data.successNote.includes('创建成功'), 'failed confirmation shows no success')
  failSave = false
  failSaveOnce = true
  await mealPage.confirm()
  assert.equal(mealPage.data.confirmationVisible, true, 'successful confirmation shows actionable prompt')
  assert.equal(mealPage.data.confirmationParticles.length, 18)
  mealPage.closeConfirmation()
  assert.equal(mealPage.data.confirmationVisible, false)
  assert.equal(mealPage.data.confirmationParticles.length, 0)
  assert.equal(stored.id, base.id, 'confirmation updates the same meal')
  assert.equal(stored.version, 3)
  const dish = { currentTarget: { dataset: { id: 'item00001' } } }
  holdSave = true
  const marking = mealPage.mark(dish)
  assert.equal(mealPage.data.meal.items[0].state, 'cooked', 'circle responds before the request finishes')
  assert.equal(mealPage.data.savingAction, 'mark')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(loadingAction, 'mark')
  const markCalls = saveCalls
  await mealPage.saveCurrent()
  await mealPage.mark(dish)
  mealPage.complete()
  assert.equal(saveCalls, markCalls, 'busy actions remain guarded without native disabled buttons')
  holdSave = false; releaseSave(); await marking
  assert.equal(stored.items[0].state, 'cooked', 'one tap marks the dish as cooked')
  await mealPage.mark(dish)
  assert.equal(stored.items[0].state, 'planned', 'second tap clears the cooked mark')
  definiteFailure = true
  await mealPage.mark(dish)
  assert.equal(mealPage.data.meal.items[0].state, 'planned', 'failed circle rolls back immediately')
  assert.equal(mealPage.data.savingAction, '')
  assert.equal(stored.items[0].state, 'planned')
  definiteFailure = false
  commitButFailOnce = true
  await mealPage.unconfirm()
  assert.equal(mealPage.data.status, 'draft', 'lost response after commit is reconciled without a second write')
  mealPage.onTitle({ detail: { value: '   ' } });assert.equal(mealPage.data.pageTitle,'这顿饭')
  mealPage.onTitle({ detail: { value: '周末晚饭第二版' } })
  assert.equal(mealPage.data.pageTitle,'周末晚饭第二版');assert.equal(stored.title,'周末晚饭','typing a title is not autosaving')
  await mealPage.saveCurrent()
  assert.equal(stored.id, base.id, 'repeated edits still update the original meal')
  assert.equal(stored.title, '周末晚饭第二版')
  assert.equal(stored.version, 7)

  mealPage.applyMeal({ ...stored, items: [] })
  const beforeEmpty = saveCalls
  await mealPage.saveCurrent()
  await mealPage.confirm()
  assert.equal(saveCalls, beforeEmpty, 'empty meal cannot be saved or confirmed')
  assert.ok(toasts.includes('先选择至少一道菜'))

  mealPage.applyMeal(stored)
  await mealPage.save('confirmed', stored.items.map(item => ({ ...item, state: 'skipped' })))
  mealPage.complete()
  assert.equal(modal.title, '把这一顿收进回忆吧')
  const beforeCancel = saveCalls
  modal.success({ confirm: false })
  assert.equal(saveCalls, beforeCancel, 'cancelled completion sends no request')
  assert.equal(stored.items[0].state, 'skipped', 'cancelled completion keeps the previous mark')
  mealPage.complete()
  modal.success({ confirm: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stored.status, 'completed', 'completion includes every remaining dish')
  assert.equal(stored.items[0].state, 'cooked')
  assert.ok(navigation.at(-1).startsWith('/pages/menu-preview/index?id=meal00001&from=complete'), 'completion opens this same record directly')
  mealPage.onUnload()

  require('../miniprogram/pages/records/index')
  const recordsPage = page
  await recordsPage.load(true)
  assert.equal(recordsPage.data.timeline.length, 1, 'cancelled meal stays stored but is hidden')
  assert.equal(recordsPage.data.timeline[0].kindLabel, '吃饭记录')
  stored = { ...stored, status: 'draft' }
  await recordsPage.load(true)
  assert.equal(recordsPage.data.timeline[0].kindLabel, '待确认饭单')
  stored = { ...stored, status: 'confirmed' }
  await recordsPage.load(true)
  assert.equal(recordsPage.data.timeline[0].kindLabel, '待开饭饭单')

  const view = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/meal/index.wxml'), 'utf8')
  assert.ok(view.indexOf('这顿饭的安排') < view.indexOf('选好的菜'))
  assert.match(view, /<textarea[^>]*auto-height/)
  assert.doesNotMatch(view, /fixed-bottom/, 'actions must stay in document flow')
  for (const button of view.matchAll(/<button[^>]*class="meal-(?:save|primary)[^>]*>/g)) {
    assert.doesNotMatch(button[0], /\sdisabled=/, 'native disabled must not replace meal button colors')
  }
  console.log('饭单保存、确认、空单、全菜完成、记录可见性与布局自检通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
