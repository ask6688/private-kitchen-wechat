let storageKey = ''

function configure({ space, member }) {
  if (!space || !member) throw new Error('请先进入共同厨房')
  storageKey = `mealSelection:${space.id || space._id}:${member.id || member._id}`
  return items()
}

function read() {
  if (!storageKey) throw new Error('请先进入共同厨房')
  const saved = wx.getStorageSync(storageKey)
  return saved && Array.isArray(saved.items) ? saved : { items: [], requestId: '' }
}

function write(value) {
  wx.setStorageSync(storageKey, value)
  return value.items
}

function key(source) {
  return source.recipeId ? `recipe:${source.recipeId}` : source.wishId ? `wish:${source.wishId}` : ''
}

function compact(source) {
  if (!key(source)) throw new Error('这道菜暂时无法选择，请刷新后重试')
  return { id: key(source), recipeId: source.recipeId || '', wishId: source.wishId || '',
    name: source.name || source.title || '一道菜', coverFileId: source.coverFileId || '' }
}

function items() { return read().items.map(item => ({ ...item, id: key(item) })) }

function has(source) {
  const id = key(source)
  return !!id && items().some(item => key(item) === id)
}

function add(source) {
  const state = read()
  const item = compact(source)
  const existing = state.items.findIndex(entry => key(entry) === key(item))
  if (existing >= 0) {
    if (!item.wishId || state.items[existing].wishId) return state.items.slice()
    state.items[existing] = { ...state.items[existing], wishId: item.wishId }
    return write({ items: state.items, requestId: '' })
  }
  if (state.items.length >= 20) throw new Error('一顿最多选 20 道菜')
  return write({ items: [...state.items, item], requestId: '' })
}

function remove(source) {
  const state = read()
  return write({ items: state.items.filter(item => key(item) !== key(source)), requestId: '' })
}

function toggle(source) {
  const existing = read().items.find(item => key(item) === key(source))
  if (existing && source.wishId && !existing.wishId) return add(source)
  return existing ? remove(source) : add(source)
}

function clear() { return write({ items: [], requestId: '' }) }

function prepareSubmit() {
  const state = read()
  if (!state.items.length) throw new Error('先选一道想吃的菜')
  if (state.items.some(item => !item.recipeId)) throw new Error('这条心愿还没有菜品资料，请先编辑并保存')
  if (!state.requestId) {
    state.requestId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`
    write(state)
  }
  return { requestId: state.requestId,
    items: state.items.map(item => ({ recipeId: item.recipeId, ...(item.wishId ? { wishId: item.wishId } : {}) })) }
}

function completeSubmit(requestId) {
  if (read().requestId === requestId) clear()
}

module.exports = { configure, items, has, add, remove, toggle, clear, prepareSubmit, completeSubmit }
