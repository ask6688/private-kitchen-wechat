const assert = require('node:assert/strict')
const storage = new Map(), routes = [], globals = { configError: '' }, receipts = new Map()
let stack = [], failSave = false, uncertain = false, failNavigation = false, modal, sourceSheet, submitted = 0
let stored = { id: 'meal-flow-001', _id: 'meal-flow-001', spaceId: 'space-flow-001', version: 1, title: '原饭名', date: '2026-10-01', diners: 2, note: '', status: 'draft', photoFileIds: [], reflection: '',
 items: [{ id: 'item-flow-001', name: '米饭', recipeId: 'recipe-flow-001', wishId: '', state: 'planned' }] }
const originalId = stored.id
const ok = data => ({ result: { ok: true, data: JSON.parse(JSON.stringify(data)) } })
global.getApp = () => ({ globalData: globals }); global.getCurrentPages = () => stack
const route = method => options => { routes.push({ method, url: options.url || '' }); if (failNavigation) { failNavigation = false; options.fail({ errMsg: 'test navigation failure' }) } else if (options.success) options.success() }
global.wx = {
 getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, JSON.parse(JSON.stringify(value))), removeStorageSync: key => storage.delete(key),
 showLoading() {}, hideLoading() {}, showToast() {}, setNavigationBarTitle() {}, enableAlertBeforeUnload() {}, disableAlertBeforeUnload() {},
 showActionSheet: options => { sourceSheet = options }, showModal: options => { modal = options }, navigateTo: route('navigateTo'), redirectTo: route('redirectTo'), navigateBack: route('navigateBack'), switchTab: route('switchTab'),
 getFileSystemManager: () => ({ unlink() {} }), getWindowInfo: () => ({ statusBarHeight: 24 }),
 cloud: { callFunction: async ({ data: { action, payload } }) => {
  if (action === 'bootstrap') return ok({ space: { id: stored.spaceId, currentMealId: originalId, categories: [] }, member: { id: 'member-flow-001' } })
  if (action === 'getMeal') return ok(stored)
  if (action === 'getRecipe') return ok({ id: payload.id, name: '青菜' })
  if (action === 'listRecipes') return ok([{ id: 'recipe-flow-001', name: '米饭' }, { id: 'recipe-flow-002', name: '青菜' }])
  if (action === 'listRecords') return ok([])
  if (action === 'mediaUrls') return ok({ urls: {} })
  if (action === 'addMealItem') { assert.equal(payload.mealId, originalId); stored.items.push({ ...payload.item, id: 'item-flow-002' }); stored.version++; return ok(stored) }
  if (action === 'removeMealItem') { stored.items = stored.items.filter(item => item.id !== payload.itemId); stored.version++; return ok(stored) }
  if (action === 'saveMeal' || action === 'saveEatingMeal') {
   if (failSave) return { result: { ok: false, error: { code: 'INVALID_INPUT', message: '模拟明确保存失败' } } }
   if (receipts.has(payload.requestId)) return ok(receipts.get(payload.requestId))
   submitted++; stored = { ...stored, ...payload, id: payload.id || 'manual-flow-001', status: action === 'saveEatingMeal' ? 'completed' : payload.status, version: stored.version + 1 }
   receipts.set(payload.requestId, stored)
   if (uncertain) { uncertain = false; throw new Error('模拟保存响应丢失') }
   return ok(stored)
  }
  throw new Error(action)
 } }
}
let definition
global.Page = value => { definition = value }
require('../miniprogram/pages/meal/index')
const mealDefinition = definition
function page(value, route) { return { ...value, route, data: JSON.parse(JSON.stringify(value.data)), setData(fields, callback) { for (const [key, value] of Object.entries(fields)) { const parts = key.split('.'); let object = this.data; while (parts.length > 1) { const part = parts.shift(); object = object[part] || (object[part] = {}) } object[parts[0]] = value } if (callback) callback() } } }
async function main() {
 const meal = page(mealDefinition, 'pages/meal/index'); meal.onLoad({ id: originalId }); stack = [meal]; await meal.load()
 meal.onTitle({ detail: { value: '周末朋友晚饭' } }); meal.onDiners({ detail: { value: '3' } }); meal.onNote({ detail: { value: '留一份' } }); meal.chooseRecipe()
 assert.equal(routes.at(-1).url, `/pages/menu-picker/index?mealId=${originalId}`)
 const picker = page(require('../miniprogram/pages/menu/page'), 'pages/menu-picker/index'); picker.onLoad({ mealId: originalId }); stack = [meal, picker]; await picker.onShow()
 assert.equal(picker.data.shown[0].selected, true)
 await picker.toggleDish({ currentTarget: { dataset: { id: 'recipe-flow-002' } } }); assert.equal(picker.data.selectedCount, 2)
 picker.returnMeal(); assert.equal(routes.at(-1).method, 'navigateBack'); stack = [meal]; await meal.load()
 assert.equal(meal.data.title, '周末朋友晚饭'); assert.equal(meal.data.diners, '3'); assert.equal(meal.data.note, '留一份'); assert.equal(meal.data.meal.items.length, 2)
 await meal.confirm(); assert.equal(stored.status, 'confirmed'); assert.equal(globals.mealCompletion, undefined)
 failNavigation = true; meal.complete(); await modal.success({ confirm: true }); await new Promise(resolve => setImmediate(resolve))
 assert.equal(stored.status, 'completed'); assert.equal(meal.data.openSaved, true); const count = submitted
 meal.openSavedRecord(); assert.equal(submitted, count, 'opening saved detail does not complete twice')
 assert.equal(routes.at(-1).url.split('&')[0], `/pages/menu-preview/index?id=${originalId}`)
 const token = globals.mealCompletion.token
 require('../miniprogram/pages/menu-preview/index'); const detailDefinition = definition
 const detail = page(detailDefinition, 'pages/menu-preview/index'); detail.onLoad({ id: originalId, from: 'complete', event: token }); detail.render = async () => {}; stack = [detail]; await detail.load()
 assert.equal(detail.data.overlay, true); assert.equal(globals.mealCompletion, undefined); await detail.load(); assert.equal(globals.mealCompletion, undefined)
 detail.closeOverlay(); await new Promise(resolve => setTimeout(resolve, 190)); assert.equal(detail.data.overlay, false); assert.equal(submitted, count)
 detail.back(); assert.equal(routes.at(-1).url, '/pages/record-list/index?kind=meals')
 const cold = page(detailDefinition, 'pages/menu-preview/index'); cold.onLoad({ id: originalId }); cold.render = async () => {}; stack = [cold]; await cold.load(); assert.equal(cold.data.overlay, false)
 const form = page(mealDefinition, 'pages/meal/index'); form.onLoad({ mode: 'record' }); stack = [form]; await form.load()
 assert.deepEqual(form.data.photos, []); assert.deepEqual(form.data.meal.items, [])
 form.addActualDish(); sourceSheet.success({ tapIndex: 2 }); form.onNewDish({ detail: { value: '朋友带来的饺子' } }); form.addCustomActual(); assert.equal(form.data.meal.items[0].state, 'eaten'); assert.equal(form.data.meal.items[0].addToMenu, true)
 failSave = true; await form.saveEating(); assert.equal(form.data.meal.items[0].name, '朋友带来的饺子'); assert.equal(form.savedMealId, undefined)
 failSave = false; uncertain = true; await form.saveEating(); assert.ok(form.data.pendingEatingPayload); const once = submitted
 const pending = JSON.stringify(form.data.pendingEatingPayload); form.onTitle({ detail: { value: '不能覆盖待核对请求' } }); assert.equal(JSON.stringify(form.data.pendingEatingPayload), pending)
 await form.saveEating(); assert.equal(submitted, once, 'unknown response replays same direct request')
 assert.equal(form.savedMealId, 'manual-flow-001'); assert.ok(routes.at(-1).url.startsWith('/pages/menu-preview/index?id=manual-flow-001'))
 form.onHide(); assert.equal(storage.has(form.formDraftKey), false, 'saved record must not recreate an edit draft')
 const cancelled = page(mealDefinition, 'pages/meal/index'); cancelled.onLoad({ id: stored.id, mode: 'record' }); stack = [cold, cancelled]; await cancelled.load(); cancelled.onTitle({ detail: { value: '放弃的饭名' } }); cancelled.cancelRecordEdit(); await modal.success({ confirm: true }); await new Promise(resolve => setImmediate(resolve)); cancelled.onHide(); cancelled.onUnload(); assert.equal(storage.has(cancelled.formDraftKey), false, 'cancelled draft stays discarded on exit')
 const conflictForm = page(mealDefinition, 'pages/meal/index'); conflictForm.onLoad({ id: stored.id, mode: 'record' }); stack = [cold, conflictForm]; await conflictForm.load(); conflictForm.onTitle({ detail: { value: '我的饭名' } }); const remote = { ...stored, title: '伙伴的饭名', note: '伙伴的新安排', version: stored.version + 1 }; conflictForm.rebaseRecord(remote); assert.deepEqual(conflictForm.data.recordConflictFields, ['title']); assert.equal(conflictForm.data.note, remote.note); assert.equal(conflictForm.data.title, '我的饭名'); conflictForm.resolveRecordFields(); modal.success({ confirm: true }); assert.deepEqual(conflictForm.data.recordConflictFields, []); assert.equal(conflictForm.data.title, '我的饭名'); conflictForm.onUnload()
 const records = page(require('../miniprogram/pages/records/page'), 'pages/records/index'); stack = [records]; records.setData({ timeline: [{ id: originalId, kind: 'meal', status: 'completed' }] }); records.open({ currentTarget: { dataset: { id: originalId, kind: 'meal' } } }); assert.equal(routes.at(-1).url, `/pages/menu-preview/index?id=${originalId}&from=recent`)
 const newFromList = page(require('../miniprogram/pages/records/page'), 'pages/record-list/index'); stack = [records, newFromList]; newFromList.setData({ loading: false }); newFromList.newMeal(); assert.equal(routes.at(-1).url, '/pages/meal/index?mode=record')
 detail.onUnload(); cold.onUnload(); meal.onUnload(); form.onUnload()
 console.log('Menu frontend flow passed: same-meal picks/form, confirm, complete, navigation retry, once-only overlay, cold view, direct record, uncertain retry and entry routing')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
