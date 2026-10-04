const assert = require('node:assert/strict')
const pages = []
let stack = []
const globals = { configError: '', spaceName: '我们的厨房' }
const storage = new Map()
const nav = []
const toasts = []
let failAdd = true
let holdBootstrap = false
let releaseBootstrap
let addCalls = 0
const wish = { _id: 'wish00001', id: 'wish00001', title: '想吃面包', recipeId: '', status: 'open' }
let stored = { _id: 'meal00001', id: 'meal00001', spaceId: 'space00001', version: 1, status: 'draft',
  title: '一起开饭', date: '2026-09-29', diners: 2, note: '',
  items: [{ id: 'item00001', recipeId: 'recipe00001', wishId: '', name: '米饭', state: 'planned' }] }
const ok = data => ({ result: { ok: true, data } })
global.getCurrentPages = () => stack
global.getApp = () => ({ globalData: globals })
global.wx = {
  showLoading() {}, hideLoading() {}, setNavigationBarTitle() {}, showToast: ({ title }) => toasts.push(title),
  switchTab: options => { nav.push(options.url); if (options.success) options.success() },
  navigateTo: options => { nav.push(options.url); if (options.success) options.success() },
  navigateBack: options => { nav.push('上一页'); if (options.success) options.success() },
  redirectTo: options => { nav.push(options.url); if (options.success) options.success() },
  getStorageSync: key => storage.get(key), removeStorageSync: key => storage.delete(key), setStorageSync: (key, value) => storage.set(key, value),
  cloud: { callFunction: async ({ data: { action, payload } }) => {
    if (action === 'bootstrap') {
      if (holdBootstrap) await new Promise(resolve => { releaseBootstrap = resolve })
      return ok({ space: { _id: 'space00001', currentMealId: stored.id }, member: { _id: 'member00001' } })
    }
    if (action === 'getMeal') return ok(stored)
    if (action === 'getRecipe') return ok({ _id: payload.id, name: '米饭' })
    if (action === 'listWishes') return ok([wish])
    if (action === 'addMealItem') {
      addCalls++
      if (failAdd) return { result: { ok: false, error: { code: 'SERVER_ERROR', message: '加入失败' } } }
      assert.equal(payload.mealId, stored.id)
      if (!stored.items.some(item => item.wishId === wish.id)) stored = { ...stored, version: stored.version + 1,
        items: [...stored.items, { id: 'item00002', recipeId: '', wishId: wish.id, name: wish.title, state: 'planned' }] }
      return ok(stored)
    }
    if (action === 'removeMealItem') {
      assert.equal(payload.mealId, stored.id)
      stored = { ...stored, version: stored.version + 1, items: stored.items.filter(item => item.id !== payload.itemId) }
      return ok(stored)
    }
    throw new Error(`unexpected ${action}`)
  } }
}
global.Page = definition => pages.push({ ...definition, data: { ...definition.data }, setData(fields, callback) { for (const [key, value] of Object.entries(fields)) { const parts = key.split('.'); let target = this.data; while (parts.length > 1) target = target[parts.shift()]; target[parts[0]] = value } if (callback) callback() } })
require('../miniprogram/pages/meal/index')
require('../miniprogram/pages/wishes/index')
const [mealPage, wishPage] = pages
async function main() {
  wishPage.route = 'pages/wish-picker/index'
  wishPage.onLoad({ mealId: stored.id })
  mealPage.route = 'pages/meal/index'
  mealPage.onLoad({ id: stored.id })
  stack = [mealPage]
  await mealPage.load()
  mealPage.onTitle({ detail: { value: '周末晚饭' } })
  mealPage.onNote({ detail: { value: '给朋友留一份' } })
  mealPage.chooseWish()
  assert.equal(globals.mealWishContext.mealId, stored.id)
  assert.equal(nav.at(-1), `/pages/wish-picker/index?mealId=${stored.id}`)
  stack = [mealPage, wishPage]
  holdBootstrap = true
  const enteringWish = wishPage.onShow()
  assert.equal(wishPage.data.loading, true, 'wish tab hides old content while restoring meal context')
  assert.deepEqual(wishPage.data.shown, [])
  holdBootstrap = false
  releaseBootstrap()
  await enteringWish
  assert.equal(wishPage.data.fromMeal, true)
  assert.equal(wishPage.data.selectedCount, 1)
  const event = { currentTarget: { dataset: { id: wish.id } } }
  await wishPage.addToMeal(event)
  assert.equal(stored.items.length, 1, 'failed selection does not appear synced')
  assert.equal(wishPage.data.shown[0].selected, false)
  assert.ok(toasts.includes('加入失败'))
  failAdd = false
  await wishPage.addToMeal(event)
  assert.equal(addCalls, 2)
  assert.equal(stored.items.length, 2)
  assert.equal(stored.items[1].state, 'planned')
  assert.equal(wish.status, 'open', 'adding a wish does not complete it')
  assert.equal(wishPage.data.selectedCount, 2, 'footer counts all meal dishes')
  await wishPage.addToMeal(event)
  assert.equal(stored.items.length, 1, 'deselecting removes only this meal item')
  assert.equal(wish.status, 'open')
  await wishPage.addToMeal(event)
  assert.equal(stored.items.length, 2, 'the same wish can be selected again without duplicates')
  wishPage.returnMeal()
  assert.equal(nav.at(-1), '上一页', 'return reuses the existing meal page')
  wishPage.onUnload()
  assert.equal(globals.mealWishContext, null, 'closing the picker clears meal-only context')
  stack = [mealPage]
  await mealPage.onShow()
  assert.equal(mealPage.data.meal.items.length, 2)
  assert.equal(mealPage.data.title, '周末晚饭')
  assert.equal(mealPage.data.note, '给朋友留一份')
  assert.equal(storage.get(mealPage.formDraftKey).title, '周末晚饭')
  wishPage.route = 'pages/wishes/index'
  wishPage.onLoad({})
  stack = [wishPage]
  await wishPage.onShow()
  assert.equal(wishPage.data.fromMeal, false, 'direct tab visit has no old meal context')
  assert.equal(wishPage.data.selectedCount, 0)
  console.log('饭单与心愿往返、失败重试、同一 mealId、表单保留及普通 Tab 自检通过')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
