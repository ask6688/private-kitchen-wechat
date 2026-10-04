const assert = require('node:assert/strict')
const Module = require('node:module')
const { EventEmitter } = require('node:events')

let openid = ''
let tables = new Map()
let queue = Promise.resolve()
let nextDeleteStatus = null
let nextReceiptRace = false
let nextRecordFailure = false
let nextRecordRace = false
let nextMediaFailure = false
let nextMediaCommitLoss = false
let mediaCommitLost = false
let nextUploadLoss = false
let uploadGate = null
let onUpload = null
let uploadCount = 0
const storedFiles = new Set()
const storedBodies = new Map()
let stagedResponse = null
let metadataFailure = false
let stagedReadCount = 0
let stagedReadAborted = false
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value))
const table = (name, store) => {
  if (!store.has(name)) store.set(name, new Map())
  return store.get(name)
}

function database(store = tables) {
  let reading = false
  return {
    command: { all: values => ({ _op: 'all', values }), in: values => ({ _op: 'in', values }) },
    collection(name) {
      const data = table(name, store)
      return {
        doc(id) {
          return {
            async get() {
              const transaction = store !== tables
              if (transaction && reading) {
                const error = new Error('document.get:fail -501001 [ResourceUnavailable.TransactionBusy] Transaction is busy')
                error.errCode = -501001
                throw error
              }
              if (transaction) reading = true
              try {
                // Keep the first request pending while a sibling Promise.all read starts.
                if (transaction) await Promise.resolve()
                if (id === 'quota-test') {
                  const error = new Error('database exceed collection limit')
                  error.errCode = -502004
                  throw error
                }
                if (!data.has(id)) throw new Error(`document.get:fail document with _id ${id} does not exist`)
                return { data: copy(data.get(id)) }
              } finally {
                if (transaction) reading = false
              }
            },
            async update({ data: changes }) {
              if (!data.has(id)) throw new Error('missing document')
              data.set(id, { ...data.get(id), ...copy(changes) })
            },
            async remove() { data.delete(id) }
          }
        },
        async add({ data: row }) {
          if (data.has(row._id)) throw new Error('duplicate document')
          data.set(row._id, copy(row))
          if (store !== tables && name === 'media_assets' && !row.kind) {
            if (nextMediaFailure) { nextMediaFailure = false; throw new Error('simulated media write failure') }
            if (nextMediaCommitLoss) { nextMediaCommitLoss = false; mediaCommitLost = true }
          }
          if (nextRecordFailure && store !== tables && name === 'cooking_records') {
            nextRecordFailure = false
            throw new Error('simulated record write failure')
          }
          if (nextRecordRace && store !== tables && name === 'cooking_records') {
            nextRecordRace = false
            tables.clear()
            for (const [tableName, rows] of store) tables.set(tableName, new Map([...rows].map(([key, value]) => [key, copy(value)])))
            throw new Error('duplicate document')
          }
          if (nextReceiptRace && store !== tables && name === 'activity_logs' && row.action === 'submitMealSelection') {
            nextReceiptRace = false
            // Simulate the other identical transaction committing just before this add reports a duplicate.
            tables.clear()
            for (const [tableName, rows] of store) tables.set(tableName, new Map([...rows].map(([key, value]) => [key, copy(value)])))
            throw new Error('duplicate document')
          }
        },
        where(filter) {
          let order = null
          let offset = 0
          let count = 100
          const query = {
            orderBy(key, direction) { order = [key, direction]; return query },
            skip(value) { offset = value; return query },
            limit(value) { count = value; return query },
            async get() {
              let rows = [...data.values()].filter(row => Object.entries(filter).every(([key, value]) =>
                value && value._op === 'all' ? Array.isArray(row[key]) && value.values.every(item => row[key].includes(item))
                  : value && value._op === 'in' ? value.values.includes(row[key]) : row[key] === value))
              if (order) rows.sort((a, b) => order[1] === 'desc' ? String(b[order[0]]).localeCompare(String(a[order[0]])) : String(a[order[0]]).localeCompare(String(b[order[0]])))
              return { data: copy(rows.slice(offset, offset + count)) }
            }
          }
          return query
        }
      }
    },
    async runTransaction(callback) {
      let release
      const prior = queue
      queue = new Promise(resolve => { release = resolve })
      await prior
      const snapshot = new Map([...tables].map(([name, rows]) => [name, new Map([...rows].map(([key, value]) => [key, copy(value)]))]))
      try {
        const result = await callback(database(snapshot))
        tables.clear()
        for (const [name, rows] of snapshot) tables.set(name, rows)
        if (mediaCommitLost) { mediaCommitLost = false; throw new Error('simulated media commit response loss') }
        return result
      } finally {
        release()
      }
    }
  }
}

const fakeCloud = {
  DYNAMIC_CURRENT_ENV: Symbol('current'),
  init() {},
  database: () => database(),
  getWXContext: () => ({ OPENID: openid, SOURCE: 'wx_client' }),
  uploadFile: async ({ cloudPath, fileContent }) => {
    const fileID = `cloud://test/${cloudPath}`
    uploadCount += 1
    storedFiles.add(fileID)
    storedBodies.set(fileID, Buffer.from(fileContent))
    if (onUpload) onUpload()
    if (uploadGate) await uploadGate
    if (nextUploadLoss) { nextUploadLoss = false; throw new Error('simulated storage response loss') }
    return { fileID }
  },
  deleteFile: async ({ fileList }) => ({ fileList: fileList.map(fileID => {
    if (nextDeleteStatus != null) { const status = nextDeleteStatus; nextDeleteStatus = null; return { fileID, status } }
    return { fileID, status: storedFiles.delete(fileID) ? 0 : -503003 }
  }) }),
  getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(({ fileID }) => ({ fileID, status: 0, tempFileURL: `https://example.test/${fileID}` })) })
}

const fakeStorage = {
  async getUploadMetadata({ cloudPath }) {
    if (metadataFailure) { metadataFailure = false; throw new Error('credential must not reach logs') }
    return { data: { url: `https://bucket.cos.test/${encodeURIComponent(`cloud://test/${cloudPath}`)}`,
      fileId: `cloud://test/${cloudPath}`, authorization: 'test-signature', token: 'test-token', cosFileId: 'test-cos-id' } }
  },
  async getTempFileURL({ fileList }) {
    assert.equal(fileList[0].urlType, 'COS_URL', 'read the storage endpoint, not the previous CDN endpoint')
    return { fileList: fileList.map(({ fileID }) => ({ fileID, code: 'SUCCESS', tempFileURL: `https://bucket.cos.test/${encodeURIComponent(fileID)}` })) }
  }
}
const fakeHttps = {
  get(url, callback) {
    const request = new EventEmitter()
    request.destroy = () => { stagedReadAborted = true }
    process.nextTick(() => {
      stagedReadCount += 1
      const fixture = stagedResponse || {}, body = storedBodies.get(decodeURIComponent(new URL(url).pathname.slice(1)))
      stagedResponse = null
      if (fixture.error) { request.emit('error', new Error('network error with secret URL')); return }
      const response = new EventEmitter()
      response.destroy = () => { response.destroyed = true }
      response.statusCode = fixture.status || (body ? 200 : 404)
      response.headers = fixture.noLength ? {} : { 'content-length': String((fixture.body || body || []).length) }
      callback(response)
      if (response.destroyed) return
      if (fixture.hang) return
      if (fixture.aborted) { response.emit('aborted'); return }
      response.emit('data', fixture.body || body || Buffer.alloc(0))
      if (!response.destroyed) response.emit('end')
    })
    return request
  }
}

const originalLoad = Module._load
Module._load = function (name, parent, isMain) {
  if (name === 'wx-server-sdk') return fakeCloud
  if (name === '@cloudbase/node-sdk') return { SYMBOL_CURRENT_ENV: Symbol('current'), init: () => fakeStorage }
  if (name === 'node:https') return fakeHttps
  return originalLoad.call(this, name, parent, isMain)
}
const { main } = require('./index')
Module._load = originalLoad

function call(who, action, payload = {}) {
  openid = who
  return main({ action, payload })
}

async function ok(who, action, payload) {
  const result = await call(who, action, payload)
  assert.equal(result.ok, true, `${action}: ${JSON.stringify(result.error)}`)
  return result.data
}

async function rejected(who, action, payload, code) {
  const result = await call(who, action, payload)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, code)
}

async function transactionReadGuardTest() {
  await assert.rejects(database().runTransaction(async tx => {
    await tx.collection('users').add({ data: { _id: 'transaction-read-probe' } })
    await Promise.all([tx.collection('users').doc('transaction-read-probe').get(), tx.collection('users').doc('transaction-read-probe').get()])
  }), error => error.errCode === -501001 && error.message.includes('TransactionBusy'))
  assert.equal(tables.get('users') && tables.get('users').has('transaction-read-probe') || false, false)
}

async function mainTest() {
  await transactionReadGuardTest()
  const a = 'openid-A'
  const b = 'openid-B'
  const c = 'openid-C'
  await ok(a, 'createSpace', { name: '我们的厨房' })
  const invite = await ok(a, 'createInvite')
  await ok(b, 'joinSpace', { code: invite.code })
  await ok(c, 'createSpace', { name: '另一间厨房' })
  const cInvite = await ok(c, 'createInvite')
  const d = 'openid-D'
  await ok(d, 'joinSpace', { code: cInvite.code })
  const categoryUpdate = await ok(c, 'manageTaxonomy', { kind: 'category', op: 'create', name: '热菜', version: 1 })
  await rejected(c, 'manageTaxonomy', { kind: 'category', op: 'create', name: '未分类', version: categoryUpdate.catalogVersion }, 'INVALID_INPUT')
  const category = categoryUpdate.categories[0]
  const tagUpdate = await ok(d, 'manageTaxonomy', { kind: 'tag', op: 'create', name: '喜欢', version: categoryUpdate.catalogVersion })
  const tag = tagUpdate.tags[0]
  await rejected(c, 'manageTaxonomy', { kind: 'tag', op: 'rename', id: tag.id, name: '常做', version: 1 }, 'VERSION_CONFLICT')
  const renamedTag = await ok(c, 'manageTaxonomy', { kind: 'tag', op: 'rename', id: tag.id, name: '常做', version: tagUpdate.catalogVersion })
  const catalogRecipe = await ok(c, 'saveRecipe', { name: '土豆丝', categoryId: category.id, tagIds: [tag.id],
    externalUrl: 'https://www.xiaohongshu.com/example', description: '旧介绍' })
  assert.equal((await ok(d, 'getRecipe', { id: catalogRecipe.id })).tags[0], '常做')
  await rejected(c, 'saveRecipe', { id: catalogRecipe.id, version: catalogRecipe.version, name: catalogRecipe.name,
    category: '凉菜', tags: ['常做'] }, 'UPGRADE_REQUIRED')
  await rejected(c, 'saveRecipe', { id: catalogRecipe.id, version: catalogRecipe.version, name: catalogRecipe.name,
    category: '热菜', tags: ['新标签'] }, 'UPGRADE_REQUIRED')
  const legacySameRecipe = await ok(c, 'saveRecipe', { id: catalogRecipe.id, version: catalogRecipe.version, name: catalogRecipe.name,
    category: '热菜', tags: ['常做'] })
  assert.equal(legacySameRecipe.categoryId, category.id, 'unchanged legacy strings keep canonical IDs')
  assert.equal((await ok(c, 'listRecipes', { categoryId: category.id })).length, 1)
  await rejected(c, 'saveRecipe', { name: '坏链接', externalUrl: 'javascript:alert(1)' }, 'INVALID_INPUT')
  const deletedCategory = await ok(d, 'manageTaxonomy', { kind: 'category', op: 'delete', id: category.id, version: renamedTag.catalogVersion })
  await ok(c, 'manageTaxonomy', { kind: 'tag', op: 'delete', id: tag.id, version: deletedCategory.catalogVersion })
  assert.equal((await ok(c, 'getRecipe', { id: catalogRecipe.id })).category, '未分类')
  assert.equal((await ok(c, 'listRecipes', { categoryId: 'uncategorized' })).length, 1)
  const wishPhoto = await ok(c, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const linked = await ok(c, 'saveWish', { type: 'eat', recipe: { name: '鱼香肉丝', categoryId: '', tagIds: [], available: false,
    coverFileId: wishPhoto.fileId, description: '保留旧资料' } })
  assert.equal(linked.recipe.available, false)
  const editedLinked = await ok(d, 'saveWish', { id: linked.id, version: linked.version,
    recipe: { id: linked.recipe.id, version: linked.recipe.version, name: '鱼香肉丝（新）' } })
  assert.equal(editedLinked.recipe.description, '保留旧资料')
  assert.equal(editedLinked.recipe.coverFileId, wishPhoto.fileId, 'editing a wish keeps its existing photo')
  const legacySavedWish = await ok(c, 'saveWish', { id: editedLinked.id, version: editedLinked.version,
    title: editedLinked.recipe.name, type: 'eat', note: '仍想一起吃' })
  assert.equal(legacySavedWish.recipeId, editedLinked.recipe.id, 'legacy client omitting recipeId must preserve the link')
  await rejected(c, 'saveWish', { id: legacySavedWish.id, version: legacySavedWish.version,
    title: '旧端改菜名', type: 'eat', note: legacySavedWish.note }, 'UPGRADE_REQUIRED')
  await rejected(c, 'saveWish', { id: legacySavedWish.id, version: legacySavedWish.version,
    title: legacySavedWish.title, type: 'eat', recipeId: '' }, 'UPGRADE_REQUIRED')
  await rejected(c, 'saveWish', { id: linked.id, version: legacySavedWish.version,
    recipe: { id: linked.recipe.id, version: linked.recipe.version, name: '旧版覆盖' } }, 'VERSION_CONFLICT')
  assert.equal((await ok(c, 'getWish', { id: linked.id })).recipe.name, '鱼香肉丝（新）')
  const otherRecipe = await ok(d, 'saveRecipe', { name: '米饭', categoryId: '', tagIds: [] })
  nextReceiptRace = true
  const parallelSelections = await Promise.all([
    call(c, 'submitMealSelection', { requestId: 'parallel-C-001', items: [{ recipeId: catalogRecipe.id }] }),
    call(d, 'submitMealSelection', { requestId: 'parallel-D-001', items: [{ recipeId: linked.recipe.id, wishId: linked.id }] })
  ])
  assert.equal(parallelSelections.every(result => result.ok), true)
  assert.equal(parallelSelections[0].data.id, parallelSelections[1].data.id, 'two members share one current meal')
  assert.equal((await ok(c, 'getMeal', { id: parallelSelections[0].data.id })).items.length, 2)
  const selectionId = 'selection-C-001'
  const selected = await ok(c, 'submitMealSelection', { requestId: selectionId,
    items: [{ recipeId: catalogRecipe.id }, { recipeId: linked.recipe.id, wishId: linked.id }] })
  assert.equal(selected.items.length, 2)
  assert.equal((await ok(c, 'submitMealSelection', { requestId: selectionId,
    items: [{ recipeId: catalogRecipe.id }, { recipeId: linked.recipe.id, wishId: linked.id }] })).id, selected.id)
  await rejected(c, 'submitMealSelection', { requestId: selectionId, items: [{ recipeId: catalogRecipe.id }] }, 'REQUEST_CONFLICT')
  const confirmedSelection = await ok(c, 'saveMeal', { id: selected.id, version: selected.version, title: selected.title,
    date: selected.date, diners: 2, items: selected.items, status: 'confirmed' })
  await rejected(d, 'submitMealSelection', { requestId: 'selection-D-001', items: [{ recipeId: otherRecipe.id }] }, 'RECONFIRM_REQUIRED')
  const amendedSelection = await ok(d, 'submitMealSelection', { requestId: 'selection-D-001', allowReconfirm: true,
    items: [{ recipeId: otherRecipe.id }] })
  assert.equal(amendedSelection.status, 'draft')
  assert.equal(amendedSelection.items.length, 3)
  const completedSelection = await ok(c, 'saveMeal', { id: selected.id, version: amendedSelection.version, title: selected.title,
    date: selected.date, diners: 2, items: amendedSelection.items.map(item => ({ ...item, state: 'cooked' })), status: 'completed' })
  assert.equal(completedSelection.status, 'completed')
  assert.equal((await ok(d, 'submitMealSelection', { requestId: 'selection-D-001', allowReconfirm: true,
    items: [{ recipeId: otherRecipe.id }] })).status, 'completed', 'receipt survives a completed meal')
  const movedRecord = await ok(c, 'saveRecord', { recipeId: otherRecipe.id })
  assert.equal((await ok(c, 'getRecipe', { id: otherRecipe.id })).cookCount, 2)
  await ok(d, 'saveRecord', { id: movedRecord.id, version: movedRecord.version, recipeId: catalogRecipe.id })
  assert.equal((await ok(c, 'getRecipe', { id: otherRecipe.id })).cookCount, 1, 'moving a record decreases the old dish count')
  assert.equal((await ok(c, 'getRecipe', { id: catalogRecipe.id })).cookCount, 2, 'moving a record increases the new dish count')
  delete tables.get('recipes').get(catalogRecipe.id).cookCount
  const legacyListed = await ok(c, 'listRecipes', { categoryId: 'uncategorized' })
  assert.equal(legacyListed.find(item => item.id === catalogRecipe.id).cookCount, 2, 'legacy dishes show meal and direct records in menu lists')
  assert.equal(tables.get('recipes').get(catalogRecipe.id).cookCount, 2, 'legacy count is persisted after its first read')
  delete tables.get('recipes').get(catalogRecipe.id).cookCount
  assert.equal((await ok(c, 'getRecipe', { id: catalogRecipe.id })).cookCount, 2, 'legacy dish detail also backfills the count')
  const hiddenWish = await ok(c, 'saveWish', { recipe: { name: '暂不公开的汤', categoryId: '', tagIds: [], available: false } })
  await ok(d, 'completeWish', { id: hiddenWish.id, version: hiddenWish.version })
  assert.equal((await ok(c, 'getRecipe', { id: hiddenWish.recipeId })).available, true, 'completed wish joins the menu')
  const publishedSelection = await ok(c, 'submitMealSelection', { requestId: 'completed-hidden-01',
    items: [{ recipeId: hiddenWish.recipeId, wishId: hiddenWish.id }] })
  assert.equal(publishedSelection.items.find(item => item.recipeId === hiddenWish.recipeId).wishId, '',
    'completed wish is selected as a regular menu dish')
  const availableWishRecipe = await ok(c, 'saveRecipe', { id: editedLinked.recipe.id, version: editedLinked.recipe.version,
    name: editedLinked.recipe.name, available: true, coverFileId: wishPhoto.fileId })
  await ok(d, 'completeWish', { id: editedLinked.id, version: legacySavedWish.version })
  const staleWishSelection = await ok(c, 'submitMealSelection', { requestId: 'completed-available-01',
    items: [{ recipeId: availableWishRecipe.id, wishId: editedLinked.id }] })
  assert.equal(staleWishSelection.items.find(item => item.recipeId === availableWishRecipe.id).wishId, '',
    'completed wish falls back to an available recipe')
  const oldPhoto = await ok(c, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const oldRecipe = await ok(c, 'saveRecipe', { name: '老式煎饼', category: '早餐', tags: ['面食'], coverFileId: oldPhoto.fileId })
  const oldDeletedRecipe = await ok(c, 'saveRecipe', { name: '老标签菜', category: '热菜', tags: ['常做'] })
  assert.equal(oldRecipe.category, '早餐')
  const oldWish = await ok(c, 'saveWish', { title: '试做汤包' })
  const oldRecord = await ok(c, 'saveRecord', { wishId: oldWish.id })
  const recipeCandidates = []
  let recipeMigrated = 0
  for (let offset = 0; ; offset += 5) {
    const preview = await ok(c, 'migrateLegacy', { kind: 'recipes', offset })
    recipeCandidates.push(...preview.candidates)
    recipeMigrated += (await ok(c, 'migrateLegacy', { kind: 'recipes', offset, dryRun: false })).changed
    if (!preview.hasMore) break
  }
  assert.ok(recipeCandidates.some(item => item.id === oldRecipe.id))
  assert.equal(recipeMigrated >= 2, true)
  assert.equal((await ok(d, 'getRecipe', { id: oldRecipe.id })).category, '早餐')
  assert.equal((await ok(d, 'getRecipe', { id: oldRecipe.id })).coverFileId, oldPhoto.fileId, 'migration does not replace photos')
  assert.equal((await ok(d, 'getRecipe', { id: oldDeletedRecipe.id })).category, '未分类', 'migration must not revive a deleted category')
  assert.deepEqual((await ok(d, 'getRecipe', { id: oldDeletedRecipe.id })).tags, [], 'migration must not revive a deleted tag')
  assert.equal((await ok(c, 'bootstrap')).space.categories.filter(item => item.name === '热菜' && !item.deletedAt).length, 0)
  assert.equal((await ok(c, 'migrateLegacy', { kind: 'recipes', offset: 0, dryRun: false })).changed, 0, 'migration can be retried')
  const wishPreview = await ok(c, 'migrateLegacy', { kind: 'wishes', offset: 0 })
  assert.ok(wishPreview.candidates.some(item => item.id === oldWish.id))
  await ok(c, 'migrateLegacy', { kind: 'wishes', offset: 0, dryRun: false })
  const migratedWish = await ok(c, 'getWish', { id: oldWish.id })
  assert.equal(migratedWish.recipe.available, false)
  assert.equal((await ok(c, 'migrateLegacy', { kind: 'wishes', offset: 0, dryRun: false })).changed, 0)
  await ok(c, 'migrateLegacy', { kind: 'cooking_records', offset: 0, dryRun: false })
  assert.equal((await ok(c, 'getRecord', { id: oldRecord.id })).recipeId, migratedWish.recipeId)
  assert.equal((await ok(c, 'getRecipe', { id: migratedWish.recipeId })).cookCount, 1, 'migrated records count as cooked')
  const legacyCompleteWish = await ok(c, 'saveWish', { title: '想做蛋糕' })
  const legacyCompleteRecord = await ok(c, 'saveRecord', { wishId: legacyCompleteWish.id })
  const completedLegacyWish = await ok(c, 'completeWish', { id: legacyCompleteWish.id, version: legacyCompleteWish.version, recordId: legacyCompleteRecord.id })
  assert.equal((await ok(c, 'getRecipe', { id: completedLegacyWish.recipeId })).available, true, 'old wishes also become menu dishes')
  assert.equal((await ok(c, 'getRecipe', { id: completedLegacyWish.recipeId })).cookCount, 1, 'the linked record counts once')
  await rejected(c, 'saveRecord', { id: oldRecord.id, version: (await ok(c, 'getRecord', { id: oldRecord.id })).version,
    wishId: oldWish.id, recipeId: '', date: '2026-09-28' }, 'INVALID_INPUT')
  const catalogExport = await ok(c, 'exportData', { collection: 'catalog' })
  assert.equal(catalogExport.schemaVersion, 2)
  assert.equal(catalogExport.items[0].categories.length >= 2, true)
  await rejected(d, 'migrateLegacy', { kind: 'recipes' }, 'FORBIDDEN')
  const breakfast = (await ok(c, 'bootstrap')).space.categories.find(item => item.name === '早餐')
  const cSpaceId = (await ok(c, 'bootstrap')).space.id
  for (let index = 0; index < 55; index++) tables.get('recipes').set(`filter-test-${String(index).padStart(3, '0')}`, {
    _id: `filter-test-${String(index).padStart(3, '0')}`, spaceId: cSpaceId, name: `测试菜 ${index}`,
    categoryId: breakfast.id, tagIds: [], cookCount: 0, archivedAt: null, available: true,
    updatedAt: `2026-09-28T08:${String(index).padStart(2, '0')}:00.000Z`, version: 1
  })
  assert.equal((await ok(c, 'listRecipes', { categoryId: breakfast.id, offset: 50 })).length, 6,
    'category filtering happens before paging, including matches after the first 50 rows')
  for (let index = 0; index < 55; index++) tables.get('recipes').set(`hidden-test-${String(index).padStart(3, '0')}`, {
    _id: `hidden-test-${String(index).padStart(3, '0')}`, spaceId: cSpaceId, name: `隐藏心愿 ${index}`,
    categoryId: '', tagIds: [], cookCount: 0, archivedAt: null, available: false,
    updatedAt: `2026-10-01T08:${String(index).padStart(2, '0')}:00.000Z`, version: 1
  })
  assert.equal((await ok(c, 'listRecipes', { includeArchived: true, availableOnly: true })).length, 50,
    'available dishes remain visible even when a full earlier page contains hidden wishes')
  for (let index = 0; index < 55; index++) tables.get('recipes').set(`archived-test-${String(index).padStart(3, '0')}`, {
    _id: `archived-test-${String(index).padStart(3, '0')}`, spaceId: cSpaceId, name: `归档菜 ${index}`,
    categoryId: '', tagIds: [], cookCount: 0, archivedAt: '2026-09-30T00:00:00.000Z', available: false,
    updatedAt: `2026-08-01T08:${String(index).padStart(2, '0')}:00.000Z`, version: 1
  })
  assert.equal((await ok(c, 'listRecipes', { archivedOnly: true })).length, 50,
    'archived dishes are paged after filtering even when earlier pages contain active recipes')
  await rejected(c, 'listRecipes', { availableOnly: true, archivedOnly: true }, 'INVALID_INPUT')
  await rejected(b, 'renameSpace', { name: '太'.repeat(41) }, 'INVALID_INPUT')
  const renamed = await ok(b, 'renameSpace', { name: '两个人的厨房' })
  assert.equal(renamed.name, '两个人的厨房')
  assert.equal((await ok(a, 'bootstrap')).space.name, renamed.name, 'both members see the shared name')
  assert.equal((await ok(a, 'listActivities')).filter(item => item.action === 'renameSpace').length, 0, 'routine activity is no longer stored')
  await ok(a, 'renameSpace', { name: renamed.name })
  assert.equal((await ok(a, 'listActivities')).filter(item => item.action === 'renameSpace').length, 0)
  await ok(a, 'renameSpace', { name: '周末厨房' })
  assert.equal((await ok(b, 'bootstrap')).space.name, '周末厨房', 'owner can also rename')
  const recipe = await ok(a, 'saveRecipe', { name: '番茄炒蛋' })
  const wish = await ok(b, 'saveWish', { title: '试做面包' })
  const disposable = await ok(a, 'saveWish', { title: '暂不做的菜' })
  await rejected(c, 'deleteWish', { id: disposable.id, version: disposable.version }, 'NOT_FOUND')
  const deletedWish = await ok(b, 'deleteWish', { id: disposable.id, version: disposable.version })
  assert.equal(deletedWish.status, 'deleted')
  assert.equal((await ok(a, 'listWishes', { status: 'open' })).some(item => item.id === disposable.id), false)
  assert.equal((await ok(a, 'listWishes')).some(item => item.id === disposable.id), false)
  assert.equal((await ok(a, 'getWish', { id: disposable.id })).status, 'deleted', 'historical references keep resolving')
  await rejected(a, 'deleteWish', { id: disposable.id, version: disposable.version }, 'VERSION_CONFLICT')
  await rejected(a, 'completeWish', { id: disposable.id, version: deletedWish.version }, 'INVALID_STATE')
  await rejected(a, 'saveWish', { id: disposable.id, version: deletedWish.version, title: '又想做了' }, 'INVALID_STATE')
  await rejected(a, 'getRecipe', { id: 'missing-doc' }, 'NOT_FOUND')
  await rejected(a, 'getRecipe', { id: 'quota-test' }, 'SERVER_ERROR')
  await rejected(c, 'getRecipe', { id: recipe.id }, 'NOT_FOUND')
  await rejected(c, 'saveRecipe', { id: recipe.id, version: recipe.version, name: '偷改' }, 'NOT_FOUND')
  const photo = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  await rejected(c, 'mediaUrls', { fileIds: [photo.fileId] }, 'INVALID_MEDIA')
  await rejected(c, 'discardMedia', { fileId: photo.fileId }, 'INVALID_MEDIA')
  const withPhoto = await ok(a, 'saveRecipe', { id: recipe.id, version: recipe.version, name: recipe.name, coverFileId: photo.fileId })
  await rejected(b, 'discardMedia', { fileId: photo.fileId }, 'MEDIA_IN_USE')
  assert.equal(storedFiles.has(photo.fileId), true, 'a referenced cover must remain in cloud storage')
  const unused = await ok(b, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const beforeDiscard = (await ok(a, 'bootstrap')).space.mediaBytes
  await ok(a, 'discardMedia', { fileId: unused.fileId })
  assert.equal((await ok(b, 'bootstrap')).space.mediaBytes, beforeDiscard - 4, 'discarding one unused image returns its quota')
  assert.equal(storedFiles.has(unused.fileId), false)
  await rejected(a, 'mediaUrls', { fileIds: [unused.fileId] }, 'INVALID_MEDIA')
  const gallery = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const withGallery = await ok(a, 'saveRecipe', { id: recipe.id, version: withPhoto.version, name: recipe.name,
    coverFileId: photo.fileId, photoFileIds: [gallery.fileId] })
  await rejected(b, 'discardMedia', { fileId: gallery.fileId }, 'MEDIA_IN_USE')
  const withoutGallery = await ok(a, 'saveRecipe', { id: recipe.id, version: withGallery.version, name: recipe.name, coverFileId: photo.fileId })
  await ok(b, 'discardMedia', { fileId: gallery.fileId })
  const editedByPartner = await ok(b, 'saveRecipe', { id: recipe.id, version: withoutGallery.version, name: '越南粉', coverFileId: photo.fileId })
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).name, '越南粉', 'both members can rename a recipe and keep its cover')

  const [first, second] = await Promise.all([
    call(a, 'addMealItem', { item: { recipeId: recipe.id }, requestId: 'request-A-01' }),
    call(b, 'addMealItem', { item: { wishId: wish.id }, requestId: 'request-B-01' })
  ])
  assert.equal(first.ok, true, JSON.stringify(first.error))
  assert.equal(second.ok, true, JSON.stringify(second.error))
  const [meal] = await ok(a, 'listMeals')
  assert.equal(meal.items.length, 2, 'simultaneous picks must remain in one meal')
  assert.deepEqual(new Set(meal.items.map(item => item.name)), new Set(['越南粉', '试做面包']))
  const [extraA, extraB] = await Promise.all([
    call(a, 'addMealItem', { mealId: meal.id, item: { name: '米饭' }, requestId: 'request-A-02' }),
    call(b, 'addMealItem', { mealId: meal.id, item: { name: '青菜' }, requestId: 'request-B-02' })
  ])
  assert.equal(extraA.ok, true, JSON.stringify(extraA.error))
  assert.equal(extraB.ok, true, JSON.stringify(extraB.error))
  assert.equal((await ok(a, 'getMeal', { id: meal.id })).items.length, 4, 'simultaneous picks on one meal must not overwrite each other')
  await ok(a, 'addMealItem', { mealId: meal.id, item: { recipeId: recipe.id }, requestId: 'request-A-01' })
  assert.equal((await ok(a, 'getMeal', { id: meal.id })).items.length, 4, 'retry must not duplicate an item')
  await rejected(c, 'getMeal', { id: meal.id }, 'NOT_FOUND')
  await rejected(a, 'saveMeal', { id: meal.id, version: meal.version, title: meal.title, date: meal.date, diners: 2, items: meal.items, status: 'completed' }, 'VERSION_CONFLICT')
  await ok(b, 'saveWish', { id: wish.id, version: wish.version, title: wish.title, type: wish.type, recipeId: recipe.id })
  const latestMeal = await ok(a, 'getMeal', { id: meal.id })
  const marked = await ok(a, 'saveMeal', { id: meal.id, version: latestMeal.version, title: latestMeal.title,
    date: latestMeal.date, diners: latestMeal.diners, status: 'confirmed', items: latestMeal.items.map(item => ({ ...item,
      state: item.recipeId === recipe.id ? 'cooked' : 'skipped' })) })
  await rejected(a, 'saveRecord', { recipeId: recipe.id, wishId: wish.id, mealId: meal.id, date: marked.date }, 'INVALID_INPUT')
  const recordPhoto = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const record = await ok(a, 'saveRecord', { recipeId: recipe.id, mealId: meal.id, date: marked.date,
    note: '这次做得好', photoFileIds: [recordPhoto.fileId] })
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).cookCount, 1, 'a new cooking record increments the menu count')
  await rejected(b, 'discardMedia', { fileId: recordPhoto.fileId }, 'MEDIA_IN_USE')
  assert.equal(record.makerName, '厨房主理人')
  const editedRecord = await ok(b, 'saveRecord', { id: record.id, version: record.version, recipeId: recipe.id,
    mealId: meal.id, date: marked.date, note: '一起吃了', photoFileIds: [] })
  assert.equal((await ok(b, 'getRecipe', { id: recipe.id })).cookCount, 1, 'editing one record does not increment again')
  assert.equal(editedRecord.makerName, '厨房主理人', 'editing must retain the original maker')
  await ok(a, 'discardMedia', { fileId: recordPhoto.fileId })
  const failedDelete = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const quotaBeforeFailure = (await ok(a, 'bootstrap')).space.mediaBytes
  nextDeleteStatus = -503001
  await rejected(a, 'discardMedia', { fileId: failedDelete.fileId }, 'DELETE_FAILED')
  assert.equal((await ok(a, 'bootstrap')).space.mediaBytes, quotaBeforeFailure, 'failed storage deletion cannot release quota')
  assert.equal(storedFiles.has(failedDelete.fileId), true)
  tables.get('media_assets').get(require('node:crypto').createHash('sha256').update(failedDelete.fileId).digest('hex')).deletingAt = '2000-01-01T00:00:00.000Z'
  storedFiles.delete(failedDelete.fileId)
  await ok(a, 'discardMedia', { fileId: failedDelete.fileId })
  await rejected(b, 'completeWish', { id: wish.id, version: 2, recordId: record.id }, 'INVALID_INPUT')
  const completed = await ok(a, 'saveMeal', { id: meal.id, version: marked.version, title: marked.title,
    date: marked.date, diners: marked.diners, items: marked.items.map((item, index) => index < 2 ? { ...item, state: 'cooked' } : { ...item, state: 'planned' }), status: 'completed' })
  assert.ok(completed.items.every(item => item.state === 'cooked'), 'completion finishes every dish still in the meal')
  assert.equal((await ok(a, 'listRecords', { mealId: completed.id })).length, 4, 'completion records every remaining dish without requiring photos')
  assert.ok(completed.items.every(item => item.recordId), 'every completed item links to exactly one cooking record')
  const extraPhoto = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const cookedItem = completed.items.find(item => item.state === 'cooked')
  const attached = await ok(b, 'addMealItemPhoto', { mealId: completed.id, itemId: cookedItem.id, fileId: extraPhoto.fileId })
  assert.equal(attached.record.id, record.id, 'photo reuses the existing cooking record')
  await ok(a, 'addMealItemPhoto', { mealId: completed.id, itemId: cookedItem.id, fileId: extraPhoto.fileId })
  assert.equal((await ok(b, 'listRecords', { mealId: completed.id })).length, 4, 'retries do not create another cooking record')
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).cookCount, 1, 'photo retries do not increment cooking count')
  const wishMealPhoto = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const newPhotoRecord = await ok(b, 'addMealItemPhoto', { mealId: completed.id, itemId: completed.items[1].id, fileId: wishMealPhoto.fileId })
  await ok(a, 'addMealItemPhoto', { mealId: completed.id, itemId: completed.items[1].id, fileId: wishMealPhoto.fileId })
  assert.equal((await ok(b, 'listRecords', { mealId: completed.id })).length, 4, 'a second dish photo reuses its completion record')
  await rejected(a, 'addMealItemPhoto', { mealId: completed.id, itemId: 'removed-item', fileId: extraPhoto.fileId }, 'INVALID_STATE')
  const reopenedOnce = await ok(a, 'reopenMeal', { id: meal.id, version: newPhotoRecord.mealVersion })
  const completedAgain = await ok(a, 'saveMeal', { id: meal.id, version: reopenedOnce.version, title: reopenedOnce.title,
    date: reopenedOnce.date, diners: reopenedOnce.diners, items: reopenedOnce.items, status: 'completed' })
  assert.equal((await ok(b, 'listRecords', { mealId: meal.id })).length, 4, 'repeating completion reuses all dish records')
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).cookCount, 1, 'repeating completion does not increment cooking count')
  const reopened = await ok(a, 'reopenMeal', { id: meal.id, version: completedAgain.version })
  const skipped = await ok(a, 'saveMeal', { id: meal.id, version: reopened.version, title: reopened.title,
    date: reopened.date, diners: reopened.diners, items: reopened.items.map(item => ({ ...item, state: 'skipped' })), status: 'draft' })
  const revisedNote = await ok(b, 'saveRecord', { id: record.id, version: attached.record.version, recipeId: recipe.id,
    mealId: meal.id, date: marked.date, note: '后来补充的心得', photoFileIds: [] })
  assert.equal(revisedNote.note, '后来补充的心得', 'an old record remains editable after the meal is reopened and skipped')
  await rejected(a, 'saveRecord', { recipeId: recipe.id, mealId: meal.id, date: skipped.date }, 'INVALID_INPUT')
  await rejected(b, 'saveRecord', { id: record.id, version: revisedNote.version, wishId: wish.id,
    mealId: meal.id, date: skipped.date, note: '换关联' }, 'INVALID_INPUT')
  const removed = await ok(a, 'removeMealItem', { mealId: meal.id, itemId: skipped.items.find(item => item.recipeId === recipe.id).id, requestId: 'remove-recorded-item' })
  const revisedAfterRemoval = await ok(b, 'saveRecord', { id: record.id, version: revisedNote.version, recipeId: recipe.id,
    mealId: meal.id, date: marked.date, note: '移出饭单后补记', photoFileIds: [] })
  assert.equal(revisedAfterRemoval.note, '移出饭单后补记', 'an old record remains editable after its meal item is removed')
  await rejected(a, 'saveRecord', { recipeId: recipe.id, mealId: meal.id, date: removed.date }, 'INVALID_INPUT')
  const countBeforeSkippedMeal = (await ok(a, 'getRecipe', { id: recipe.id })).cookCount
  await ok(a, 'saveMeal', { id: meal.id, version: removed.version, title: removed.title,
    date: removed.date, diners: removed.diners, items: removed.items.map(item => ({ ...item, state: 'skipped' })), status: 'completed' })
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).cookCount, countBeforeSkippedMeal, 'a removed recipe is not restored or counted by completion')

  const memoryPhoto = await ok(a, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const currentMeal = await ok(a, 'getMeal', { id: meal.id })
  await rejected(c, 'saveMealMemory', { mealId: meal.id, version: currentMeal.version, photoFileIds: [memoryPhoto.fileId] }, 'NOT_FOUND')
  await rejected(b, 'saveMealMemory', { mealId: meal.id, version: currentMeal.version, photoFileIds: ['cloud://wrong/asset'] }, 'INVALID_MEDIA')
  assert.equal((await ok(a, 'getMeal', { id: meal.id })).version, currentMeal.version, 'failed photo saves leave the meal untouched')
  const memory = await ok(b, 'saveMealMemory', { mealId: meal.id, version: currentMeal.version,
    photoFileIds: [memoryPhoto.fileId, memoryPhoto.fileId], reflection: '和朋友吃得很开心' })
  assert.deepEqual(memory.photoFileIds, [memoryPhoto.fileId], 'meal gallery removes duplicate references')
  assert.equal(memory.reflection, '和朋友吃得很开心')
  assert.equal(memory.status, 'completed', 'editing the album keeps the completed meal completed')
  assert.deepEqual(memory.items, currentMeal.items, 'editing the album does not change dish states')
  assert.equal((await ok(a, 'getMeal', { id: meal.id })).reflection, memory.reflection, 'both members read the same meal reflection')
  await rejected(a, 'discardMedia', { fileId: memoryPhoto.fileId }, 'MEDIA_IN_USE')
  await rejected(a, 'saveMealMemory', { mealId: meal.id, version: currentMeal.version, photoFileIds: [] }, 'VERSION_CONFLICT')
  await rejected(a, 'saveMealMemory', { mealId: meal.id, version: memory.version, reflection: 'x'.repeat(4001) }, 'INVALID_INPUT')
  assert.deepEqual((await ok(a, 'getMeal', { id: meal.id })).photoFileIds, [memoryPhoto.fileId], 'failed updates retain the saved album')
  const secondMeal = await ok(a, 'saveMeal', { title: '下一顿', date: currentMeal.date, diners: 2, items: [], status: 'draft' })
  const linkedAgain = await ok(a, 'saveMealMemory', { mealId: secondMeal.id, version: secondMeal.version,
    photoFileIds: [memoryPhoto.fileId] })
  const memoryRemoved = await ok(a, 'saveMealMemory', { mealId: meal.id, version: memory.version, photoFileIds: [] })
  assert.deepEqual((await ok(b, 'getMeal', { id: meal.id })).photoFileIds, [], 'removed meal photo stays removed after reopening')
  assert.equal(memoryRemoved.reflection, memory.reflection, 'photo edit preserves reflection')
  await rejected(b, 'discardMedia', { fileId: memoryPhoto.fileId }, 'MEDIA_IN_USE')
  const unlinked = await ok(b, 'saveMealMemory', { mealId: secondMeal.id, version: linkedAgain.version,
    photoFileIds: [], reflection: '' })
  assert.deepEqual(unlinked.photoFileIds, [])
  await ok(a, 'discardMedia', { fileId: memoryPhoto.fileId })
  assert.equal(storedFiles.has(memoryPhoto.fileId), false, 'only the last unlink permits physical deletion')
  const cancelledSecond = await ok(a, 'saveMeal', { id: secondMeal.id, version: unlinked.version,
    title: secondMeal.title, date: secondMeal.date, diners: secondMeal.diners, items: [], status: 'cancelled' })
  await rejected(b, 'saveMealMemory', { mealId: secondMeal.id, version: cancelledSecond.version, reflection: '不应编辑' }, 'INVALID_STATE')
  assert.equal((await ok(a, 'getRecipe', { id: recipe.id })).cookCount, countBeforeSkippedMeal, 'meal album edits do not create cooking records')

  const members = await ok(a, 'listMembers')
  const target = members.find(member => member.role === 'member')
  await rejected(a, 'leaveSpace', {}, 'OWNER_CANNOT_LEAVE')
  await ok(a, 'transferOwner', { userId: target.id })
  await rejected(a, 'removeMember', { userId: target.id }, 'FORBIDDEN')
  await ok(a, 'leaveSpace')
  assert.equal((await ok(a, 'bootstrap')).space, null)
  await rejected(a, 'renameSpace', { name: '不应改名' }, 'NO_SPACE')
  await rejected(a, 'getRecipe', { id: recipe.id }, 'NO_SPACE')
  await rejected(a, 'mediaUrls', { fileIds: [photo.fileId] }, 'NO_SPACE')
  const firstReturn = await ok(b, 'createInvite')
  const staleInvite = await ok(b, 'createInvite')
  await ok(a, 'joinSpace', { code: firstReturn.code })
  const returned = (await ok(b, 'listMembers')).find(member => member.role === 'member')
  await ok(b, 'removeMember', { userId: returned.id })
  await rejected(a, 'joinSpace', { code: staleInvite.code }, 'INVALID_INVITE')
  await ok(a, 'createSpace', { name: '新的厨房' })
  const archived = await ok(b, 'archiveRecipe', { id: recipe.id, version: editedByPartner.version })
  assert.equal((await ok(b, 'listRecipes')).length, 0)
  const restored = await ok(b, 'unarchiveRecipe', { id: recipe.id, version: archived.version })
  assert.equal(restored.available, true)
  const exported = await ok(b, 'exportData', { collection: 'recipes' })
  assert.equal(exported.items.length, 1)
  assert.equal(exported.hasMore, false)
  assert.deepEqual(exported.fileIds, [photo.fileId])
  await rejected(a, 'getRecipe', { id: recipe.id }, 'NOT_FOUND')
  const spaceId = (await ok(b, 'bootstrap')).space.id
  assert.equal(tables.get('spaces').get(spaceId).mediaBytes, 12)
  tables.get('spaces').get(spaceId).mediaBytes = 512 * 1024 * 1024 - 1
  await rejected(b, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') }, 'MEDIA_LIMIT')
  await cookingRecordTest(c, photo.fileId)
  await mealMemoryRetryTest()
  await menuBusinessTest()
  await menuCategoryTest()
  await recordDeletionTest()
  await mediaChunkTest()
  await directMediaTest()
  console.log('kitchen self-check passed: isolation, shared taxonomy, linked wishes, meal memory, batch picks and retry, legacy migration, owner transfer, safe photo discard')
}

async function directMediaTest() {
  const chef = 'direct-chef', partner = 'direct-partner', outsider = 'direct-outsider'
  await ok(chef, 'createSpace', { name: '直传厨房' })
  await ok(partner, 'joinSpace', { code: (await ok(chef, 'createInvite')).code })
  await ok(outsider, 'createSpace', { name: '直传隔离厨房' })
  const spaceId = (await ok(chef, 'bootstrap')).space.id
  const bytes = () => tables.get('spaces').get(spaceId).mediaBytes || 0
  const photo = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  const input = (requestId, body = photo) => ({ requestId, size: body.length, md5: require('node:crypto').createHash('md5').update(body).digest('hex') })
  const put = (ticket, body = photo) => { const fileId = decodeURIComponent(new URL(ticket.url).pathname.slice(1)); storedBodies.set(fileId, body); storedFiles.add(fileId); return fileId }
  const firstInput = input('direct-first-photo'), beforeUploads = uploadCount
  await rejected('direct-no-space', 'beginMediaUpload', firstInput, 'NO_SPACE')
  for (const fields of [{ size: 0 }, { size: 1024 * 1024 + 1 }, { size: 4.5 }, { md5: 'garbage' }]) await rejected(chef, 'beginMediaUpload', { ...firstInput, ...fields }, 'INVALID_MEDIA')
  const ticket = await ok(chef, 'beginMediaUpload', firstInput)
  assert.deepEqual(Object.keys(ticket).sort(), ['headers', 'url'])
  assert.equal(ticket.headers.Signature, ticket.headers.authorization)
  assert.equal(bytes(), photo.length)
  assert.deepEqual(await ok(chef, 'beginMediaUpload', firstInput), ticket)
  assert.equal(bytes(), photo.length, 'begin retry reserves once')
  await rejected(chef, 'beginMediaUpload', { ...firstInput, md5: '0'.repeat(32) }, 'REQUEST_CONFLICT')
  await rejected(partner, 'finishMediaUpload', firstInput, 'NOT_FOUND')
  await rejected(outsider, 'finishMediaUpload', firstInput, 'NOT_FOUND')
  await rejected(chef, 'finishMediaUpload', { ...firstInput, fileId: 'cloud://test/foreign', url: 'https://evil.test' }, 'UPLOAD_FAILED')
  const stage = put(ticket)
  const first = await ok(chef, 'finishMediaUpload', firstInput)
  assert.notEqual(first.fileId, stage)
  assert.equal(uploadCount, beforeUploads + 1)
  assert.equal(bytes(), photo.length, 'finalizing consumes the same reservation, not a second quota charge')
  const reads = stagedReadCount
  assert.deepEqual(await ok(chef, 'finishMediaUpload', firstInput), first)
  assert.deepEqual(await ok(chef, 'beginMediaUpload', firstInput), first)
  assert.equal(stagedReadCount, reads, 'lost final response replays without re-reading mutable staging')
  const secondInput = input('direct-second-photo', Buffer.from([0xff, 0xd8, 0xff, 1]))
  const secondTicket = await ok(chef, 'beginMediaUpload', secondInput)
  assert.equal(secondTicket.url, ticket.url, 'one member gets one staging object; a new selection is not locked for 60 seconds')
  put(secondTicket, Buffer.from([0xff, 0xd8, 0xff, 1]))
  assert.deepEqual(storedBodies.get(first.fileId), photo, 'later PUT credentials cannot overwrite a permanent photo')
  const second = await ok(chef, 'finishMediaUpload', secondInput)
  assert.notEqual(second.fileId, first.fileId)
  const partnerTicket = await ok(partner, 'beginMediaUpload', firstInput)
  assert.notEqual(partnerTicket.url, ticket.url)
  put(partnerTicket)
  assert.notEqual((await ok(partner, 'finishMediaUpload', firstInput)).fileId, first.fileId)
  const outsiderTicket = await ok(outsider, 'beginMediaUpload', firstInput)
  assert.notEqual(outsiderTicket.url, ticket.url)
  const retryInput = input('direct-retry-photo'), retryTicket = await ok(chef, 'beginMediaUpload', retryInput)
  put(retryTicket)
  for (const fixture of [{ error: true }, { aborted: true }, { status: 503 }]) {
    stagedResponse = fixture
    await rejected(chef, 'finishMediaUpload', retryInput, 'UPLOAD_FAILED')
  }
  const originalTimeout = global.setTimeout
  try {
    global.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 15000 ? 1 : delay, ...args)
    stagedResponse = { hang: true }
    await rejected(chef, 'finishMediaUpload', retryInput, 'UPLOAD_FAILED')
  } finally { global.setTimeout = originalTimeout }
  stagedReadAborted = false
  stagedResponse = { noLength: true, body: Buffer.alloc(1024 * 1024 + 1) }
  await rejected(chef, 'finishMediaUpload', retryInput, 'INVALID_MEDIA')
  assert.equal(stagedReadAborted, true, 'oversize response aborts the stream before collecting it')
  stagedResponse = { body: Buffer.from([0xff, 0xd8, 0xff, 2]) }
  await rejected(chef, 'finishMediaUpload', retryInput, 'INVALID_MEDIA')
  stagedResponse = { noLength: true, body: Buffer.from([0xff, 0xd8]) }
  await rejected(chef, 'finishMediaUpload', retryInput, 'UPLOAD_FAILED')
  nextMediaFailure = true
  await rejected(chef, 'finishMediaUpload', retryInput, 'SERVER_ERROR')
  const afterFailedCommit = uploadCount
  const retried = await ok(chef, 'finishMediaUpload', retryInput)
  assert.equal(uploadCount, afterFailedCommit, 'known permanent upload reused after metadata write failure')
  assert.deepEqual(await ok(chef, 'finishMediaUpload', retryInput), retried)
  const badInput = input('direct-not-image', Buffer.from('nope')), badTicket = await ok(chef, 'beginMediaUpload', badInput)
  put(badTicket, Buffer.from('nope'))
  await rejected(chef, 'finishMediaUpload', badInput, 'INVALID_MEDIA')
  const signInput = input('direct-sign-retry')
  metadataFailure = true
  await rejected(chef, 'beginMediaUpload', signInput, 'UPLOAD_FAILED')
  const beforeSignRetryBytes = bytes()
  put(await ok(chef, 'beginMediaUpload', signInput))
  assert.equal(bytes(), beforeSignRetryBytes)
  await ok(chef, 'finishMediaUpload', signInput)
  const beforeLimit = bytes()
  tables.get('spaces').get(spaceId).mediaBytes = 512 * 1024 * 1024
  await rejected(chef, 'beginMediaUpload', input('direct-full-space'), 'MEDIA_LIMIT')
  tables.get('spaces').get(spaceId).mediaBytes = beforeLimit
  await ok(chef, 'discardMedia', { fileId: first.fileId })
  await rejected(chef, 'finishMediaUpload', firstInput, 'MEDIA_DISCARDED')
  await rejected(chef, 'beginMediaUpload', firstInput, 'MEDIA_DISCARDED')
  const legacyInput = { requestId: 'direct-legacy-done', base64: photo.toString('base64') }
  const legacy = await ok(chef, 'uploadMedia', legacyInput)
  assert.deepEqual(await ok(chef, 'beginMediaUpload', input(legacyInput.requestId)), legacy, 'old completed receipts remain usable')
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1024 * 1024 - 8)])
  const boundaryInput = input('direct-png-boundary', png)
  const boundaryTicket = await ok(chef, 'beginMediaUpload', boundaryInput)
  put(boundaryTicket, png)
  const boundary = await ok(chef, 'finishMediaUpload', boundaryInput)
  assert.equal(boundary.fileId.endsWith('.png'), true)
  assert.equal(storedBodies.get(boundary.fileId).length, 1024 * 1024, 'the maximum accepted payload is still bounded and complete')
  console.log('Direct upload check passed: bounded staging, private permanent objects, size/hash/stream guards, shared quota, isolation and uncertain result replay')
}

async function mediaChunkTest() {
  const chef = 'chunk-chef', partner = 'chunk-partner', outsider = 'chunk-outsider'
  await ok(chef, 'createSpace', { name: '照片分段厨房' })
  const invite = await ok(chef, 'createInvite')
  await ok(partner, 'joinSpace', { code: invite.code })
  await ok(outsider, 'createSpace', { name: '照片分段隔离厨房' })
  const spaceId = (await ok(chef, 'bootstrap')).space.id
  const bytes = () => tables.get('spaces').get(spaceId).mediaBytes || 0
  const slots = who => [...tables.get('media_assets').values()].filter(row => row.kind === 'uploadTransport' && row.uploadedBy === who)
  const slot = () => slots(chef)[0]
  const chunk = (requestId, encoded, index) => ({ requestId, base64: encoded.slice(index * 500000, (index + 1) * 500000), chunkIndex: index, chunkCount: Math.ceil(encoded.length / 500000) })
  const twoBytes = Buffer.alloc(400000), threeBytes = Buffer.alloc(800000)
  Buffer.from([0xff, 0xd8, 0xff, 0xd9]).copy(twoBytes)
  Buffer.from([0xff, 0xd8, 0xff, 0xd9]).copy(threeBytes)
  const two = twoBytes.toString('base64'), three = threeBytes.toString('base64'), firstId = 'chunk-two-upload'
  const firstChunk = chunk(firstId, two, 0), beforeStageUploads = uploadCount
  await rejected('chunk-no-space', 'uploadMedia', firstChunk, 'NO_SPACE')
  assert.deepEqual(await ok(chef, 'uploadMedia', firstChunk), { pending: true })
  assert.deepEqual(await ok(chef, 'uploadMedia', firstChunk), { pending: true })
  assert.equal(uploadCount, beforeStageUploads)
  assert.equal(bytes(), 0, 'staging never allocates file quota')
  assert.equal(slot().chunks.length, 1)
  assert.equal(slot().chunks[0].length, 500000)
  const fixedSlotId = slot()._id
  await rejected(chef, 'uploadMedia', { ...firstChunk, base64: 'A' + firstChunk.base64.slice(1) }, 'REQUEST_CONFLICT')
  await rejected(chef, 'uploadMedia', { ...firstChunk, chunkCount: 3 }, 'REQUEST_CONFLICT')
  await rejected(chef, 'uploadMedia', chunk('chunk-missing-start', two, 1), 'INVALID_STATE')
  await rejected(chef, 'uploadMedia', chunk('chunk-other-pending', two, 0), 'MEDIA_BUSY')
  await ok(partner, 'uploadMedia', firstChunk)
  await ok(outsider, 'uploadMedia', firstChunk)
  assert.equal(slots(chef).length, 1)
  assert.equal(slots(partner).length, 1)
  const first = await ok(chef, 'uploadMedia', chunk(firstId, two, 1)), afterFirstUploads = uploadCount
  assert.deepEqual(await ok(chef, 'uploadMedia', chunk(firstId, two, 1)), first)
  assert.deepEqual(await ok(chef, 'uploadMedia', { requestId: firstId, base64: two }), first)
  assert.equal(uploadCount, afterFirstUploads, 'final replay and legacy replay reuse the saved upload receipt')
  assert.equal(slot().status, 'completed')
  assert.equal(bytes(), twoBytes.length)
  const otherMember = await ok(partner, 'uploadMedia', chunk(firstId, two, 1))
  const otherSpace = await ok(outsider, 'uploadMedia', chunk(firstId, two, 1))
  assert.notEqual(otherMember.fileId, first.fileId)
  assert.notEqual(otherSpace.fileId, first.fileId)
  await rejected(outsider, 'mediaUrls', { fileIds: [first.fileId] }, 'INVALID_MEDIA')

  const threeId = 'chunk-three-upload', beforeThreeBytes = bytes()
  await ok(chef, 'uploadMedia', chunk(threeId, three, 0))
  await rejected(chef, 'uploadMedia', chunk(threeId, three, 2), 'INVALID_STATE')
  await ok(chef, 'uploadMedia', chunk(threeId, three, 1))
  assert.equal(slot().chunks.join('').length, 1000000)
  const third = await ok(chef, 'uploadMedia', chunk(threeId, three, 2))
  assert.deepEqual(await ok(chef, 'uploadMedia', chunk(threeId, three, 2)), third)
  assert.equal(bytes(), beforeThreeBytes + threeBytes.length)
  assert.equal(slot().chunks.length, 2, 'the final chunk is never persisted')
  assert.equal(slot().chunks.join('').length, 1000000)
  assert.equal(slot()._id, fixedSlotId)
  const changedLast = chunk(threeId, three, 2)
  changedLast.base64 = (changedLast.base64[0] === 'A' ? 'B' : 'A') + changedLast.base64.slice(1)
  await rejected(chef, 'uploadMedia', changedLast, 'REQUEST_CONFLICT')
  for (const payload of [{ ...firstChunk, chunkCount: 4 }, { ...firstChunk, chunkIndex: -1 }, { ...firstChunk, chunkCount: undefined }]) {
    await rejected(chef, 'uploadMedia', payload, 'INVALID_INPUT')
  }
  await rejected(chef, 'uploadMedia', { requestId: 'chunk-short-part', chunkIndex: 0, chunkCount: 2, base64: '/9j/2Q==' }, 'INVALID_MEDIA')
  await rejected(chef, 'uploadMedia', { requestId: 'chunk-large-part', chunkIndex: 0, chunkCount: 1, base64: 'A'.repeat(500004) }, 'INVALID_MEDIA')
  const bad = Buffer.alloc(400000).toString('base64'), beforeBadBytes = bytes(), beforeBadUploads = uploadCount
  await ok(chef, 'uploadMedia', chunk('chunk-invalid-image', bad, 0))
  await rejected(chef, 'uploadMedia', chunk('chunk-invalid-image', bad, 1), 'INVALID_MEDIA')
  assert.equal(slot().status, 'failed')
  assert.equal(bytes(), beforeBadBytes)
  assert.equal(uploadCount, beforeBadUploads)

  const retryId = 'chunk-database-retry'
  await ok(chef, 'uploadMedia', chunk(retryId, two, 0))
  nextMediaFailure = true
  const beforeRetryBytes = bytes()
  await rejected(chef, 'uploadMedia', chunk(retryId, two, 1), 'SERVER_ERROR')
  assert.equal(slot().status, 'pending', 'unknown failure retains staged input')
  const afterFailureUploads = uploadCount
  await ok(chef, 'uploadMedia', chunk(retryId, two, 1))
  assert.equal(uploadCount, afterFailureUploads)
  assert.equal(bytes(), beforeRetryBytes + twoBytes.length, 'retry finalizes the existing reservation once')
  assert.equal(slot().status, 'completed')
  const lostId = 'chunk-storage-retry'
  await ok(chef, 'uploadMedia', chunk(lostId, two, 0))
  const beforeLostFiles = storedFiles.size
  nextUploadLoss = true
  await rejected(chef, 'uploadMedia', chunk(lostId, two, 1), 'SERVER_ERROR')
  await ok(chef, 'uploadMedia', chunk(lostId, two, 1))
  assert.equal(storedFiles.size, beforeLostFiles + 1, 'uncertain storage retries the same permanent file path')
  await ok(chef, 'uploadMedia', chunk('chunk-expired-old', two, 0))
  slot().updatedAt = new Date(Date.now() - 61000).toISOString()
  await ok(chef, 'uploadMedia', chunk('chunk-expired-new', two, 0))
  await ok(chef, 'uploadMedia', chunk('chunk-expired-new', two, 1))
  assert.equal(slots(chef).length, 1, 'all requests reuse one bounded slot per member')
  assert.equal(slot()._id, fixedSlotId)
  const single = await ok(chef, 'uploadMedia', { requestId: 'chunk-single-upload', chunkIndex: 0, chunkCount: 1, base64: '/9j/2Q==' })
  assert.ok(single.fileId)
  assert.equal(slot().chunks.length, 0)

  const smallChunk = (requestId, encoded, index) => ({ requestId, transportVersion: 3, base64: encoded.slice(index * 32768, (index + 1) * 32768), chunkIndex: index, chunkCount: Math.ceil(encoded.length / 32768) })
  // An injected bridge ceiling exercises request size; it is not a claimed WeChat platform limit.
  const phoneBridge = async payload => {
    if (Buffer.byteLength(JSON.stringify({ action: 'uploadMedia', payload })) > 65536) throw new Error('data exceed max size')
    return ok(chef, 'uploadMedia', payload)
  }
  const phoneBytes = Buffer.alloc(180 * 1024)
  Buffer.from([0xff, 0xd8, 0xff, 0xd9]).copy(phoneBytes)
  const phone = phoneBytes.toString('base64'), phoneId = 'chunk-phone-eight', beforePhoneBytes = bytes(), beforePhoneUploads = uploadCount
  assert.equal(phone.length, 245760)
  await assert.rejects(phoneBridge({ requestId: phoneId, base64: phone }), /data exceed max size/)
  await rejected('chunk-no-space', 'uploadMedia', smallChunk(phoneId, phone, 0), 'NO_SPACE')
  assert.deepEqual(await phoneBridge(smallChunk(phoneId, phone, 0)), { pending: true })
  assert.deepEqual(await phoneBridge(smallChunk(phoneId, phone, 0)), { pending: true })
  await rejected(chef, 'uploadMedia', { ...smallChunk(phoneId, phone, 0), chunkCount: 7 }, 'REQUEST_CONFLICT')
  await rejected(chef, 'uploadMedia', smallChunk(phoneId, phone, 2), 'INVALID_STATE')
  let phoneResult
  for (let index = 1; index < 8; index += 1) phoneResult = await phoneBridge(smallChunk(phoneId, phone, index))
  assert.ok(phoneResult.fileId)
  assert.equal(uploadCount, beforePhoneUploads + 1)
  assert.equal(bytes(), beforePhoneBytes + phoneBytes.length)
  assert.equal(slot().chunks.join('').length, 7 * 32768)
  assert.equal(slot().transportVersion, 3)
  assert.equal(slot()._id, fixedSlotId)
  for (let index = 0; index < 8; index += 1) phoneResult = await phoneBridge(smallChunk(phoneId, phone, index))
  assert.equal(uploadCount, beforePhoneUploads + 1, 'whole-upload retry uses the existing receipt')
  assert.equal(bytes(), beforePhoneBytes + phoneBytes.length)
  assert.deepEqual(await ok(chef, 'uploadMedia', chunk(phoneId, phone, 0)), phoneResult, 'legacy transport can replay the same receipt after completion')
  for (let index = 0; index < 8; index += 1) phoneResult = await phoneBridge(smallChunk(phoneId, phone, index))
  assert.equal(uploadCount, beforePhoneUploads + 1, 'changing transport never creates another permanent file')
  assert.equal(bytes(), beforePhoneBytes + phoneBytes.length)

  const switchId = 'chunk-version-switch'
  await ok(chef, 'uploadMedia', chunk(switchId, two, 0))
  await rejected(chef, 'uploadMedia', smallChunk(switchId, phone, 0), 'MEDIA_BUSY')
  slot().updatedAt = new Date(Date.now() - 61000).toISOString()
  await rejected(chef, 'uploadMedia', smallChunk(switchId, phone, 1), 'INVALID_STATE')
  for (let index = 0; index < 8; index += 1) await phoneBridge(smallChunk(switchId, phone, index))
  assert.equal(slot().transportVersion, 3)
  assert.equal(slots(chef).length, 1)

  for (const payload of [{ ...smallChunk('chunk-phone-invalid', phone, 0), chunkCount: 9 }, { ...smallChunk('chunk-phone-invalid', phone, 0), transportVersion: 2 }]) {
    await rejected(chef, 'uploadMedia', payload, 'INVALID_INPUT')
  }
  await rejected(chef, 'uploadMedia', { ...smallChunk('chunk-phone-too-long', phone, 0), base64: 'A'.repeat(32772) }, 'INVALID_MEDIA')
  await rejected(chef, 'uploadMedia', { ...smallChunk('chunk-phone-too-short', phone, 0), base64: '/9j/2Q==' }, 'INVALID_MEDIA')
  const oversizedPhone = Buffer.concat([phoneBytes, Buffer.alloc(3)]).toString('base64'), beforeOversizeBytes = bytes(), beforeOversizeUploads = uploadCount
  for (let index = 0; index < 7; index += 1) await phoneBridge(smallChunk('chunk-phone-total', oversizedPhone, index))
  await rejected(chef, 'uploadMedia', smallChunk('chunk-phone-total', oversizedPhone, 7), 'INVALID_MEDIA')
  assert.equal(bytes(), beforeOversizeBytes)
  assert.equal(uploadCount, beforeOversizeUploads)
  assert.equal(slot().status, 'failed')
  console.log('Chunk upload check passed: legacy 1/2/3 and v3 8 parts, bounded request/member slots, ordered replay, transport migration, conflicts, isolation, format failures and uncertain upload retries')
}

async function mealMemoryRetryTest() {
  const chef = 'openid-memory-chef'
  const partner = 'openid-memory-partner'
  const outsider = 'openid-memory-outsider'
  await ok(chef, 'createSpace', { name: '相册重试测试厨房' })
  const invitation = await ok(chef, 'createInvite')
  await ok(partner, 'joinSpace', { code: invitation.code })
  await ok(outsider, 'createSpace', { name: '相册隔离测试厨房' })
  const base64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
  const spaceId = (await ok(chef, 'bootstrap')).space.id
  const bytes = () => tables.get('spaces').get(spaceId).mediaBytes || 0
  const firstInput = { requestId: 'album-upload-first', base64 }
  const first = await ok(chef, 'uploadMedia', firstInput)
  const initialUploads = uploadCount
  assert.deepEqual(await ok(chef, 'uploadMedia', firstInput), first)
  assert.equal(uploadCount, initialUploads, 'response retry does not upload a saved file again')
  assert.equal(bytes(), 4)
  await rejected(chef, 'uploadMedia', { ...firstInput, base64: Buffer.from([0xff, 0xd8, 0xff, 1]).toString('base64') }, 'REQUEST_CONFLICT')
  const otherMember = await ok(partner, 'uploadMedia', firstInput)
  assert.notEqual(otherMember.fileId, first.fileId, 'upload requests are scoped to the submitting member')
  const otherSpace = await ok(outsider, 'uploadMedia', firstInput)
  assert.notEqual(otherSpace.fileId, first.fileId)
  await rejected(outsider, 'mediaUrls', { fileIds: [first.fileId] }, 'INVALID_MEDIA')

  let releaseUpload
  const beforeParallelBytes = bytes()
  tables.get('spaces').get(spaceId).mediaBytes = 512 * 1024 * 1024 - 4
  uploadGate = new Promise(resolve => { releaseUpload = resolve })
  const started = new Promise(resolve => { onUpload = resolve })
  const parallelInput = { requestId: 'album-upload-parallel', base64 }
  const parallel = ok(chef, 'uploadMedia', parallelInput)
  await started
  assert.equal(bytes(), 512 * 1024 * 1024, 'upload reserves quota before writing a cloud file')
  await rejected(chef, 'uploadMedia', parallelInput, 'MEDIA_BUSY')
  const beforeFullUploads = uploadCount
  await rejected(chef, 'uploadMedia', { requestId: 'album-upload-full', base64 }, 'MEDIA_LIMIT')
  assert.equal(uploadCount, beforeFullUploads, 'quota rejection happens before cloud upload')
  releaseUpload()
  uploadGate = null
  onUpload = null
  const parallelFile = await parallel
  assert.deepEqual(await ok(chef, 'uploadMedia', parallelInput), parallelFile)
  assert.equal(bytes(), 512 * 1024 * 1024, 'finalizing a reserved upload does not count quota twice')
  tables.get('spaces').get(spaceId).mediaBytes = beforeParallelBytes + 4

  const failedInput = { requestId: 'album-upload-db-retry', base64 }
  nextMediaFailure = true
  const beforeFailureBytes = bytes()
  await rejected(chef, 'uploadMedia', failedInput, 'SERVER_ERROR')
  const afterFailureUploads = uploadCount
  assert.equal(bytes(), beforeFailureBytes + 4, 'uncertain or pending uploaded file remains covered by reserved quota')
  await ok(chef, 'uploadMedia', failedInput)
  assert.equal(uploadCount, afterFailureUploads, 'known uploaded file is reused after database failure')
  assert.equal(bytes(), beforeFailureBytes + 4)
  nextMediaCommitLoss = true
  const committedInput = { requestId: 'album-upload-commit-loss', base64 }
  const committed = await ok(chef, 'uploadMedia', committedInput)
  assert.deepEqual(await ok(chef, 'uploadMedia', committedInput), committed)
  assert.equal(bytes(), beforeFailureBytes + 8, 'unknown commit result is reconciled and counted once')
  const lostInput = { requestId: 'album-upload-storage-loss', base64 }
  const beforeLostFiles = storedFiles.size
  nextUploadLoss = true
  await rejected(chef, 'uploadMedia', lostInput, 'SERVER_ERROR')
  await ok(chef, 'uploadMedia', lostInput)
  assert.equal(storedFiles.size, beforeLostFiles + 1, 'unknown storage result retries the same file path')
  assert.equal(bytes(), beforeFailureBytes + 12)
  await ok(partner, 'discardMedia', { fileId: first.fileId })
  await rejected(chef, 'uploadMedia', firstInput, 'MEDIA_DISCARDED')
  assert.equal(storedFiles.has(first.fileId), false, 'discarded upload cannot be revived by a stale request')
  assert.equal(bytes(), beforeFailureBytes + 8, 'discard releases exactly one file allocation')

  const draft = await ok(chef, 'saveMeal', { title: '相册测试', date: '2026-09-30', diners: 2, items: [], status: 'draft' })
  await rejected(chef, 'saveMealMemory', { mealId: draft.id, version: draft.version, expectedStatus: 'completed', reflection: '不能编辑' }, 'INVALID_STATE')
  const completed = await ok(chef, 'saveMeal', { id: draft.id, version: draft.version, title: draft.title,
    date: draft.date, diners: draft.diners, items: [{ name: '自定义菜', state: 'planned' }], status: 'completed' })
  const memoryInput = { mealId: draft.id, version: completed.version, requestVersion: completed.version,
    requestId: 'album-memory-first', expectedStatus: 'completed', reflection: '我的心得' }
  const memory = await ok(chef, 'saveMealMemory', memoryInput)
  assert.equal(Object.hasOwn(memory, 'photoFileIds'), false, 'omitted album field is not materialized by a reflection edit')
  const immediateReplay = await ok(chef, 'saveMealMemory', memoryInput)
  assert.equal(immediateReplay.replayed, true)
  assert.equal(immediateReplay.changedSinceReceipt, false)
  assert.equal(Object.hasOwn(await ok(chef, 'getMeal', { id: draft.id }), 'replayed'), false, 'replay indicators are response-only')
  const revised = await ok(partner, 'saveMealMemory', { mealId: draft.id, version: memory.version,
    requestId: 'album-memory-partner', expectedStatus: 'completed', reflection: '伙伴之后修改的心得', photoFileIds: [parallelFile.fileId, committed.fileId] })
  assert.equal(revised.photoFileIds.length, 2, 'multiple new photos are validated without overlapping transaction reads')
  const recovered = await ok(chef, 'saveMealMemory', memoryInput)
  assert.equal(recovered.version, revised.version)
  assert.equal(recovered.replayed, true)
  assert.equal(recovered.changedSinceReceipt, true, 'replayed response distinguishes newer partner changes')
  assert.equal(recovered.reflection, revised.reflection, 'old successful request cannot overwrite a later partner edit')
  await rejected(chef, 'saveMealMemory', { ...memoryInput, reflection: '偷偷换内容' }, 'REQUEST_CONFLICT')
  await rejected(outsider, 'saveMealMemory', memoryInput, 'NOT_FOUND')
  let latest = revised
  for (let i = 0; i < 21; i += 1) latest = await ok(chef, 'saveMealMemory', { mealId: draft.id,
    version: latest.version, requestId: `album-memory-${i}`, expectedStatus: 'completed', reflection: `第${i}次` })
  assert.equal(latest.memoryReceipts.length, 20)
  await rejected(chef, 'saveMealMemory', { ...memoryInput, version: latest.version }, 'REQUEST_EXPIRED')
  const reopened = await ok(partner, 'reopenMeal', { id: latest.id, version: latest.version })
  const replayAfterReopen = await ok(chef, 'saveMealMemory', { mealId: draft.id,
    version: latest.version - 1, requestId: 'album-memory-20', expectedStatus: 'completed', reflection: '第20次' })
  assert.equal(replayAfterReopen.replayed, true)
  assert.equal(replayAfterReopen.changedSinceReceipt, true)
  assert.equal(replayAfterReopen.status, 'confirmed', 'replay reports latest state without completing again')
  await rejected(chef, 'saveMealMemory', { mealId: latest.id, version: latest.version,
    expectedStatus: 'completed', photoFileIds: [] }, 'INVALID_STATE')
  assert.equal((await ok(chef, 'getMeal', { id: latest.id })).version, reopened.version)
  console.log('meal memory retry self-check passed: upload receipts, quota, uncertain results, partner edits, replay window and state changes')
}

async function cookingRecordTest(outsider, foreignPhoto) {
  const chef = 'openid-cooking-chef'
  const partner = 'openid-cooking-partner'
  await ok(chef, 'createSpace', { name: '做一道菜测试厨房' })
  const invite = await ok(chef, 'createInvite')
  await ok(partner, 'joinSpace', { code: invite.code })
  const taxonomy = await ok(chef, 'manageTaxonomy', { kind: 'category', op: 'create', name: '热菜', version: 1 })
  const categoryId = taxonomy.categories[0].id
  const tags = await ok(chef, 'manageTaxonomy', { kind: 'tag', op: 'create', name: '清淡', version: taxonomy.catalogVersion })
  const tagIds = [tags.tags[0].id]
  const photo = await ok(chef, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const baseRecipe = await ok(chef, 'saveRecipe', { name: '已有青菜', categoryId, tagIds })
  const existingInput = { requestId: 'cooking-existing-001', recipeId: baseRecipe.id, date: '2026-09-30',
    note: '今天少放一点盐', photoFileIds: [photo.fileId] }
  const [existing, retry] = await Promise.all([ok(chef, 'saveRecord', existingInput), ok(chef, 'saveRecord', existingInput)])
  assert.equal(existing.id, retry.id)
  assert.equal((await ok(chef, 'listRecipes')).length, 1, 'cooking an existing dish does not create another recipe')
  assert.equal((await ok(partner, 'getRecipe', { id: baseRecipe.id })).cookCount, 1)
  const newRecipe = { name: '第一次做蒸蛋', categoryId, tagIds, ingredients: '鸡蛋 2 个', steps: '搅匀后蒸熟',
    description: '嫩一点', externalUrl: 'https://example.test/recipe', coverFileId: photo.fileId, photoFileIds: [photo.fileId] }
  const menuInput = { requestId: 'cooking-menu-001', newRecipe, addToMenu: true, date: '2026-09-30',
    note: '水可以再多一点', photoFileIds: [photo.fileId] }
  nextRecordRace = true
  const menuRecord = await ok(chef, 'saveRecord', menuInput)
  assert.equal((await ok(chef, 'saveRecord', menuInput)).id, menuRecord.id, 'lost response retry returns the same record')
  const menuRecipe = await ok(partner, 'getRecipe', { id: menuRecord.recipeId })
  assert.equal(menuRecipe.name, newRecipe.name)
  assert.equal(menuRecipe.coverFileId, photo.fileId)
  assert.equal(menuRecipe.cookCount, 1, 'new recipe starts with exactly this one completed cooking')
  assert.equal(menuRecord.dishSnapshot.ingredients, newRecipe.ingredients)
  assert.equal(menuRecord.dishSnapshot.category, '热菜')
  assert.deepEqual(menuRecord.dishSnapshot.tags, ['清淡'])
  assert.equal(Object.hasOwn(menuRecord.dishSnapshot, 'photoFileIds'), false, 'snapshot does not introduce hidden photo references')
  const onlyPhoto = await ok(chef, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const onlyInput = { requestId: 'cooking-only-001', newRecipe: { ...newRecipe, name: '临时做的蛋炒饭' }, addToMenu: false,
    date: '2026-09-29', note: '用剩饭更合适', photoFileIds: [onlyPhoto.fileId] }
  const only = await ok(chef, 'saveRecord', onlyInput)
  assert.equal(only.recipeId, '')
  assert.equal(only.name, '临时做的蛋炒饭')
  assert.deepEqual((await ok(partner, 'getRecord', { id: only.id })).photoFileIds, [onlyPhoto.fileId])
  assert.equal((await ok(chef, 'saveRecord', onlyInput)).id, only.id)
  assert.equal((await ok(chef, 'listRecipes')).length, 2, 'record-only dish is absent from the long-term menu')
  assert.equal((await ok(partner, 'listRecords')).length, 3, 'both members share all three record paths')
  await rejected(chef, 'discardMedia', { fileId: onlyPhoto.fileId }, 'MEDIA_IN_USE')
  const edited = await ok(partner, 'saveRecord', { id: only.id, version: only.version, date: '2026-09-30',
    note: '补记：少放盐', photoFileIds: [onlyPhoto.fileId] })
  assert.equal(edited.name, only.name)
  assert.deepEqual(edited.dishSnapshot, only.dishSnapshot, 'independent record edits preserve all recipe information')
  const revised = await ok(chef, 'saveRecord', { id: only.id, version: edited.version, newRecipe: { name: '蛋炒饭（改名）' },
    date: edited.date, note: edited.note, photoFileIds: edited.photoFileIds })
  assert.equal(revised.name, '蛋炒饭（改名）')
  assert.equal(revised.dishSnapshot.ingredients, newRecipe.ingredients)
  assert.equal((await ok(chef, 'listRecipes')).length, 2)
  await rejected(partner, 'saveRecord', { id: only.id, version: only.version, note: '旧版本' }, 'VERSION_CONFLICT')
  await rejected(outsider, 'getRecord', { id: only.id }, 'NOT_FOUND')
  await rejected(outsider, 'saveRecord', { id: only.id, version: revised.version, note: '越权' }, 'NOT_FOUND')
  await rejected(chef, 'saveRecord', { requestId: 'cooking-invalid-001', note: '没有菜名' }, 'INVALID_INPUT')
  await rejected(chef, 'saveRecord', { ...onlyInput, requestId: 'cooking-invalid-002', photoFileIds: [foreignPhoto] }, 'INVALID_MEDIA')
  await rejected(chef, 'saveRecord', { ...menuInput, requestId: 'cooking-invalid-003', newRecipe: { ...newRecipe, tagIds: ['foreign-tag-id'] } }, 'INVALID_INPUT')
  const rollbackInput = { ...menuInput, requestId: 'cooking-rollback-001', newRecipe: { ...newRecipe, name: '回滚后重试' } }
  nextRecordFailure = true
  await rejected(chef, 'saveRecord', rollbackInput, 'SERVER_ERROR')
  assert.equal((await ok(chef, 'listRecipes')).length, 2, 'record write failure rolls back the paired new recipe')
  assert.equal((await ok(chef, 'listRecords')).length, 3)
  const recovered = await ok(chef, 'saveRecord', rollbackInput)
  assert.equal((await ok(chef, 'saveRecord', rollbackInput)).id, recovered.id)
  assert.equal((await ok(chef, 'getRecipe', { id: recovered.recipeId })).cookCount, 1)
  assert.equal((await ok(chef, 'listRecipes')).length, 3)
  const partnerOwn = await ok(partner, 'saveRecord', onlyInput)
  assert.notEqual(partnerOwn.id, only.id, 'request ids are scoped to the submitting member')
  const otherKitchen = await ok(outsider, 'saveRecord', { ...onlyInput, newRecipe: { name: '另一间厨房的记录' }, photoFileIds: [] })
  assert.notEqual(otherKitchen.id, only.id, 'same request id in another kitchen cannot return this kitchen data')
  console.log('cooking record self-check passed: existing dish, new menu dish, record-only snapshot, retries, rollback and isolation')
}

mainTest().catch(error => { console.error(error); process.exitCode = 1 })

async function menuBusinessTest() {
  const chef = 'menu-flow-chef', partner = 'menu-flow-partner', outsider = 'menu-flow-outsider'
  await ok(chef, 'createSpace', { name: 'Menu流程厨房' })
  const invite = await ok(chef, 'createInvite')
  await ok(partner, 'joinSpace', { code: invite.code })
  await ok(outsider, 'createSpace', { name: '隔离厨房' })
  const recipe = await ok(chef, 'saveRecipe', { name: '炒青菜' })
  const plan = await ok(chef, 'addMealItem', { requestId: 'menu-plan-add-001', item: { recipeId: recipe.id, state: 'planned' } })
  const beforeRecords = (await ok(chef, 'listRecords')).length
  const directInput = { requestId: 'menu-direct-001', title: '昨天的朋友晚饭', date: '2026-09-28', diners: 3, note: '', reflection: '', photoFileIds: [],
    items: [{ id: 'menu-custom-001', name: '朋友带来的饺子', state: 'eaten' }] }
  const direct = await ok(chef, 'saveEatingMeal', directInput)
  const replay = await ok(chef, 'saveEatingMeal', directInput)
  assert.equal(direct.id, replay.id)
  assert.equal(replay.version, 1, 'replay does not update or create again')
  assert.equal(direct.status, 'completed')
  assert.deepEqual(direct.photoFileIds, [])
  assert.equal((await ok(chef, 'bootstrap')).space.currentMealId, plan.id, 'direct record preserves another active plan')
  assert.equal((await ok(chef, 'listRecords')).length, beforeRecords, 'eating creates no cooking records')
  assert.equal((await ok(chef, 'getRecipe', { id: recipe.id })).cookCount, 0)
  const changed = await ok(partner, 'saveEatingMeal', { id: direct.id, version: direct.version, requestId: 'menu-note-edit-001', reflection: '好好吃饭' })
  assert.deepEqual(changed.menuSnapshot, direct.menuSnapshot, 'photos or reflection never rewrites Menu snapshot')
  await rejected(chef, 'saveEatingMeal', { id: direct.id, version: direct.version, requestId: 'menu-conflict-001', title: '过期修改' }, 'VERSION_CONFLICT')
  await rejected(outsider, 'getMeal', { id: direct.id }, 'NOT_FOUND')
  await rejected(outsider, 'saveEatingMeal', { id: direct.id, version: changed.version, requestId: 'menu-forbidden-001', reflection: '越权' }, 'NOT_FOUND')
  const confirm = await ok(chef, 'saveMeal', { id: plan.id, version: plan.version, requestId: 'menu-confirm-001', title: '今天晚饭', date: plan.date,
    diners: 2, note: '留一份', items: plan.items, status: 'confirmed' })
  const completeInput = { id: confirm.id, version: confirm.version, requestId: 'menu-complete-001', title: confirm.title, date: confirm.date,
    diners: 2, note: confirm.note, items: confirm.items, status: 'completed' }
  const completed = await ok(chef, 'saveMeal', completeInput)
  assert.equal((await ok(chef, 'saveMeal', completeInput)).id, completed.id)
  assert.equal(completed.menuSnapshot.groups[0].items.length, 1, 'unchecked dish is included by final completion')
  assert.equal(completed.items[0].state, 'cooked')
  assert.equal((await ok(chef, 'listRecords')).length, beforeRecords + 1)
  assert.equal((await ok(chef, 'bootstrap')).space.currentMealId, '')
  const nextPlan = await ok(chef, 'addMealItem', { requestId: 'menu-plan-add-002', item: { recipeId: recipe.id, state: 'planned' } })
  const cooked = await ok(chef, 'saveMeal', { id: nextPlan.id, version: nextPlan.version, requestId: 'menu-complete-002', title: '亲手下厨', date: nextPlan.date,
    diners: 2, items: nextPlan.items.map(item => ({ ...item, state: 'cooked' })), status: 'completed' })
  await ok(chef, 'saveMeal', { id: nextPlan.id, version: nextPlan.version, requestId: 'menu-complete-002', title: '亲手下厨', date: nextPlan.date,
    diners: 2, items: nextPlan.items.map(item => ({ ...item, state: 'cooked' })), status: 'completed' })
  assert.equal((await ok(chef, 'getRecipe', { id: recipe.id })).cookCount, 2)
  assert.equal((await ok(chef, 'listRecords', { mealId: cooked.id })).length, 1)
  assert.equal(cooked.menuSnapshot.groups[0].items[0].recordId, cooked.items[0].recordId)
  const edited = await ok(partner, 'saveEatingMeal', { id: cooked.id, version: cooked.version, requestId: 'menu-edit-dishes-001',
    items: [...cooked.items, { id: 'menu-custom-002', name: '外带的汤', state: 'eaten' }] })
  assert.equal((await ok(chef, 'getRecipe', { id: recipe.id })).cookCount, 2, 'record edit never increments cooking')
  assert.equal(edited.menuSnapshot.groups[0].items.length, 2)
  const dish = await ok(chef, 'getMealDishMemory', { mealId: direct.id, itemId: direct.items[0].id })
  assert.equal(dish.reflection, '', 'whole meal reflection is not a dish reflection')
  const dishPhoto = await ok(chef, 'uploadMedia', { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') })
  const dishInput = { mealId: direct.id, itemId: direct.items[0].id, version: dish.version, requestVersion: dish.version,
    recordVersion: 0, expectedStatus: 'completed', requestId: 'dish-memory-direct-001', photoFileIds: [dishPhoto.fileId], reflection: '饺子皮很薄' }
  await rejected(chef, 'saveMealDishMemory', { ...dishInput, photoFileIds: [dishPhoto.fileId, dishPhoto.fileId+'other'] }, 'INVALID_INPUT')
  const savedDish = await ok(chef, 'saveMealDishMemory', dishInput)
  assert.equal((await ok(chef, 'saveMealDishMemory', dishInput)).version, savedDish.version, 'same dish request only saves once')
  const directAfter = await ok(chef, 'getMeal', { id: direct.id })
  assert.deepEqual(directAfter.photoFileIds, [])
  assert.equal(directAfter.reflection, '好好吃饭')
  assert.deepEqual(directAfter.menuSnapshot, direct.menuSnapshot, 'private dish memory does not change poster')
  assert.equal((await ok(chef, 'listRecords')).length, beforeRecords + 2, 'eaten dish memory never creates cooking record')
  await rejected(outsider, 'getMealDishMemory', { mealId: direct.id, itemId: direct.items[0].id }, 'NOT_FOUND')
  await rejected(outsider, 'saveMealDishMemory', dishInput, 'NOT_FOUND')
  const clearedDish = await ok(partner, 'saveMealDishMemory', { ...dishInput, requestId: 'dish-memory-clear-001',
    version: savedDish.version, requestVersion: savedDish.version, photoFileIds: [], reflection: '' })
  assert.deepEqual((await ok(chef, 'getMealDishMemory', { mealId: direct.id, itemId: direct.items[0].id })).photoFileIds, [])
  assert.equal(clearedDish.reflection, '')
  await rejected(chef, 'discardMedia', { fileId: dishPhoto.fileId }, 'MEDIA_IN_USE')
  const cookedDish = await ok(chef, 'getMealDishMemory', { mealId: cooked.id, itemId: cooked.items[0].id })
  const cookedInput = { mealId: cooked.id, itemId: cooked.items[0].id, expectedStatus: 'completed', version: cookedDish.version,
    requestVersion: cookedDish.version, recordVersion: cookedDish.recordVersion, requestId: 'dish-memory-cooked-001', reflection: '火候刚好' }
  await ok(partner, 'saveMealDishMemory', cookedInput)
  await ok(partner, 'saveMealDishMemory', cookedInput)
  assert.equal((await ok(chef, 'getRecord', { id: cooked.items[0].recordId })).note, '火候刚好')
  assert.equal((await ok(chef, 'getRecipe', { id: recipe.id })).cookCount, 2, 'dish edits/retries never add cooking counts')
  assert.equal((await ok(chef, 'listRecords', { mealId: cooked.id })).length, 1)
  await rejected(chef, 'saveMealDishMemory', { ...cookedInput, requestId: 'dish-memory-conflict-001' }, 'VERSION_CONFLICT')
  const historyEdit = await ok(chef, 'saveEatingMeal', { id: direct.id, version: clearedDish.version, requestId: 'dish-memory-items-001', items: directAfter.items })
  assert.deepEqual(historyEdit.items[0].dishMemory.photoFileIds, [], 'later meal edit preserves saved dish memory')
  await rejected(chef, 'saveEatingMeal', { requestId: 'menu-empty-001', items: [] }, 'INVALID_INPUT')
  const customInput = { requestId: 'eating-custom-library-001', items: [{ id: 'eating-custom-dish-001', name: '朋友的焖饭', addToMenu: true }] }
  const customRecord = await ok(chef, 'saveEatingMeal', customInput)
  assert.ok(customRecord.items[0].recipeId)
  const customRecipe = await ok(chef, 'getRecipe', { id: customRecord.items[0].recipeId })
  assert.equal(customRecipe.cookCount, 0)
  const recipeCount = (await ok(chef, 'listRecipes')).length
  await ok(chef, 'saveEatingMeal', customInput)
  assert.equal((await ok(chef, 'listRecipes')).length, recipeCount, 'retry never creates another menu dish')
  const linkedExisting = await ok(partner, 'saveEatingMeal', { requestId: 'eating-custom-existing-001', items: [{ id: 'eating-existing-dish-001', name: recipe.name, addToMenu: true }] })
  assert.equal(linkedExisting.items[0].recipeId, recipe.id)
  const wish = await ok(chef, 'saveWish', { title: '想吃的春卷' })
  const linkedWish = await ok(chef, 'saveEatingMeal', { requestId: 'eating-custom-wish-001', items: [{ id: 'eating-wish-dish-001', name: wish.title, addToMenu: true }] })
  assert.equal(linkedWish.items[0].wishId, wish.id)
  assert.equal((await ok(chef, 'getWish', { id: wish.id })).status, 'open')
  assert.equal((await ok(chef, 'listRecipes')).length, recipeCount)
  console.log('Menu business check passed: same identity, actual dishes, no-photo completion, replay, direct record, current plan, snapshots, conflict and isolation')
}

async function recordDeletionTest() {
  const chef='delete-chef', partner='delete-partner', outsider='delete-outsider'
  await ok(chef,'createSpace',{name:'记录删除验收厨房'})
  const invite=await ok(chef,'createInvite');await ok(partner,'joinSpace',{code:invite.code});await ok(outsider,'createSpace',{name:'其他厨房'})
  const photo=await ok(chef,'uploadMedia',{base64:Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64')})
  const recipe=await ok(chef,'saveRecipe',{name:'删除记录仍保留的菜',coverFileId:photo.fileId})
  const wish=await ok(chef,'saveWish',{title:'保留的心愿',recipeId:recipe.id})
  const plan=await ok(chef,'addMealItem',{requestId:'delete-plan-add-001',item:{recipeId:recipe.id}})
  const meal=await ok(chef,'saveMeal',{id:plan.id,version:plan.version,requestId:'delete-complete-001',title:'好吃的饭',date:plan.date,diners:2,status:'completed',items:plan.items.map(item=>({...item,state:'cooked'}))})
  const linked=await ok(chef,'getRecord',{id:meal.items[0].recordId})
  const independent=await ok(chef,'saveRecord',{requestId:'delete-cook-independent',recipeId:recipe.id,date:plan.date,note:'独立制作',photoFileIds:[photo.fileId]})
  assert.equal((await ok(chef,'getRecipe',{id:recipe.id})).cookCount,2)
  await rejected(outsider,'deleteRecord',{kind:'record',id:linked.id,version:linked.version},'NOT_FOUND')
  await rejected(partner,'deleteRecord',{kind:'record',id:linked.id,version:linked.version+1},'VERSION_CONFLICT')
  await ok(partner,'deleteRecord',{kind:'record',id:linked.id,version:linked.version})
  const replay=await ok(chef,'deleteRecord',{kind:'record',id:linked.id,version:linked.version});assert.equal(replay.replayed,true)
  assert.equal((await ok(chef,'getRecipe',{id:recipe.id})).cookCount,1)
  await rejected(chef,'getRecord',{id:linked.id},'NOT_FOUND')
  assert.deepEqual((await ok(partner,'listRecords')).map(row=>row.id),[independent.id])
  const retained=await ok(chef,'getMeal',{id:meal.id});assert.equal(retained.items[0].recordId,'');assert.equal(retained.items[0].state,'cooked');assert.equal(retained.menuSnapshot.title,'好吃的饭')
  assert.deepEqual((await ok(chef,'getMealDishMemory',{mealId:meal.id,itemId:meal.items[0].id})).photoFileIds,[])
  const active=await ok(chef,'addMealItem',{requestId:'delete-active-001',item:{recipeId:recipe.id}})
  await ok(chef,'deleteRecord',{kind:'meal',id:retained.id,version:retained.version})
  assert.equal((await ok(chef,'bootstrap')).space.currentMealId,active.id,'deleting history preserves another active meal')
  await rejected(chef,'getMeal',{id:retained.id},'NOT_FOUND')
  assert.equal((await ok(chef,'getRecord',{id:independent.id})).note,'独立制作')
  await ok(partner,'deleteRecord',{kind:'meal',id:active.id,version:active.version})
  assert.equal((await ok(chef,'bootstrap')).space.currentMealId,'')
  await ok(chef,'deleteRecord',{kind:'record',id:independent.id,version:independent.version})
  await rejected(chef,'saveRecord',{id:independent.id,version:independent.version,recipeId:recipe.id,date:plan.date,photoFileIds:[photo.fileId]},'NOT_FOUND')
  assert.equal((await ok(chef,'getRecipe',{id:recipe.id})).coverFileId,photo.fileId)
  assert.equal((await ok(chef,'getWish',{id:wish.id})).status,'open')
  assert.equal(storedFiles.has(photo.fileId),true,'record deletion never deletes shared files')
  const spaceId=(await ok(chef,'bootstrap')).space.id
  table('cooking_records',tables).set('legacy-delete-record',{_id:'legacy-delete-record',spaceId,name:'旧手填记录',updatedAt:'2000-01-01'})
  await ok(chef,'deleteRecord',{kind:'record',id:'legacy-delete-record',version:1});await rejected(chef,'getRecord',{id:'legacy-delete-record'},'NOT_FOUND')
  for(let i=0;i<60;i++)table('cooking_records',tables).set('deleted-page-'+i,{_id:'deleted-page-'+i,spaceId,deletedAt:'2030-01-01',updatedAt:'2030-01-01'})
  const last=await ok(chef,'saveRecord',{requestId:'delete-last-visible',recipeId:recipe.id,date:plan.date,note:'最后一条',photoFileIds:[]})
  assert.deepEqual((await ok(chef,'listRecords')).map(row=>row.id),[last.id],'deleted-only pages do not hide older visible records')
  tables.get('recipes').get(recipe.id).cookCount=null
  assert.equal((await ok(chef,'getRecipe',{id:recipe.id})).cookCount,1,'backfill excludes deleted history')
  console.log('记录删除自检通过：共享/隔离、重复请求、关联解除、原菜心愿文件保留、计数与分页')
}

async function menuCategoryTest() {
  const chef = 'menu-category-chef'
  await ok(chef, 'createSpace', { name: '分类厨房' })
  const taxonomy = await ok(chef, 'manageTaxonomy', { kind: 'category', op: 'create', name: '肉肉', version: 1 })
  const category = taxonomy.categories[0]
  const recipe = await ok(chef, 'saveRecipe', { name: '炒牛肋条', categoryId: category.id })
  const plain = await ok(chef, 'saveRecipe', { name: '无分类的菜', categoryId: '' })
  const selected = await ok(chef, 'submitMealSelection', { requestId: 'category-select-001', items: [{ recipeId: recipe.id }, { recipeId: plain.id }] })
  assert.equal(selected.items.find(item => item.recipeId === recipe.id).category, '肉肉', 'batch picks capture resolved category')
  assert.equal(selected.items.find(item => item.recipeId === recipe.id).categoryId, category.id)
  const completed = await ok(chef, 'saveMeal', { id: selected.id, version: selected.version, title: selected.title,
    date: selected.date, diners: 2, items: selected.items, status: 'completed' })
  assert.deepEqual(completed.menuSnapshot.groups.map(group => group.name), ['肉肉', '未分类'])
  assert.equal(completed.menuSnapshot.groups[1].items[0].category, '未分类', 'explicit uncategorized snapshot is distinguishable from omitted legacy data')
  const stored = copy(tables.get('meals').get(completed.id))
  const recipesBefore = copy([...tables.get('recipes').values()])
  const legacy = copy(stored)
  legacy.items = legacy.items.map(({ category, categoryId, ...item }) => item)
  legacy.menuSnapshot.groups = [{ name: '未分类', items: stored.menuSnapshot.groups.flatMap(group => group.items.map(({ category, categoryId, ...item }) => item)) }]
  tables.get('meals').set(completed.id, legacy)
  const fixed = await ok(chef, 'getMeal', { id: completed.id })
  assert.deepEqual(fixed.menuSnapshot.groups.map(group => group.name), ['肉肉', '未分类'], 'legacy omitted categories resolve from the same-kitchen recipe')
  assert.deepEqual(tables.get('meals').get(completed.id), legacy, 'reading never rewrites historical meals')
  assert.deepEqual([...tables.get('recipes').values()], recipesBefore, 'reading never changes the recipe library')
  const legacyRenamed = await ok(chef, 'saveEatingMeal', { id: completed.id, version: completed.version,
    requestId: 'category-legacy-rename-001', title: '旧记录换个饭名' })
  assert.deepEqual(legacyRenamed.menuSnapshot.groups.map(group => group.name), ['肉肉', '未分类'], 'legacy title-only save cannot freeze the old omitted category')
  assert.deepEqual(tables.get('meals').get(completed.id).items, legacy.items, 'title-only save leaves stored meal items untouched')
  const idOnly = copy(legacy)
  idOnly.items.find(item => item.recipeId === recipe.id).categoryId = category.id
  tables.get('meals').set(completed.id, idOnly)
  assert.equal((await ok(chef, 'getMeal', { id: completed.id })).menuSnapshot.groups[0].name, '肉肉', 'legacy stored category ID is resolved')
  const historical = copy(legacy)
  historical.menuSnapshot.groups = [{ name: '当年的家常菜', items: legacy.menuSnapshot.groups[0].items }]
  tables.get('meals').set(completed.id, historical)
  assert.deepEqual((await ok(chef, 'getMeal', { id: completed.id })).menuSnapshot.groups, historical.menuSnapshot.groups, 'historical named groups remain authoritative')
  const renamedMeal = await ok(chef, 'saveEatingMeal', { id: completed.id, version: completed.version,
    requestId: 'category-title-edit-001', title: '换个饭名' })
  assert.equal(renamedMeal.menuSnapshot.groups[0].name, '当年的家常菜', 'editing title preserves a historical category absent from meal items')
  tables.get('meals').set(completed.id, stored)
  await ok(chef, 'saveRecipe', { id: plain.id, version: plain.version, categoryId: category.id })
  assert.deepEqual((await ok(chef, 'getMeal', { id: completed.id })).menuSnapshot, stored.menuSnapshot, 'later recipe categorization cannot rewrite explicit uncategorized history')
  const renamed = await ok(chef, 'manageTaxonomy', { kind: 'category', op: 'rename', id: category.id, name: '肉类', version: taxonomy.catalogVersion })
  const picked = await ok(chef, 'addMealItem', { requestId: 'category-add-001', item: { recipeId: recipe.id } })
  assert.equal(picked.items[0].category, '肉类', 'new single picks resolve renamed taxonomy instead of stale recipe strings')
  const legacyDraft = tables.get('meals').get(picked.id)
  legacyDraft.items = legacyDraft.items.map(({ category, categoryId, ...item }) => item)
  const finishedLegacy = await ok(chef, 'saveMeal', { id: picked.id, version: picked.version, title: picked.title,
    date: picked.date, diners: 2, items: legacyDraft.items, status: 'completed' })
  assert.equal(finishedLegacy.menuSnapshot.groups[0].name, '肉类', 'existing drafts recover missing categories before final snapshot creation')
  assert.equal((await ok(chef, 'getMeal', { id: completed.id })).menuSnapshot.groups[0].name, '肉肉', 'renamed taxonomy cannot change saved category names')
  const customExisting = await ok(chef, 'saveEatingMeal', { requestId: 'category-custom-existing-001', items: [
    { id: 'category-custom-existing-item', name: recipe.name, addToMenu: true, state: 'eaten' } ] })
  assert.equal(customExisting.menuSnapshot.groups[0].name, '肉类', 'custom name matching an existing recipe resolves the current category')
  const wish = await ok(chef, 'saveWish', { recipe: { name: '心愿红烧肉', categoryId: category.id, tagIds: [], available: false } })
  const wishMeal = await ok(chef, 'saveEatingMeal', { requestId: 'category-wish-001', items: [
    { id: 'category-wish-item', wishId: wish.id, state: 'eaten' } ] })
  assert.equal(wishMeal.menuSnapshot.groups[0].name, '肉类', 'wish-only import uses the linked recipe category')
  await ok(chef, 'manageTaxonomy', { kind: 'category', op: 'delete', id: category.id, version: renamed.catalogVersion })
  tables.get('meals').set(completed.id, idOnly)
  assert.equal((await ok(chef, 'getMeal', { id: completed.id })).menuSnapshot.groups[0].name, '肉类', 'historical category IDs remain readable after taxonomy deletion')
  console.log('Menu category self-check passed: batch picks, explicit uncategorized, legacy read repair, named history and taxonomy changes')
}
