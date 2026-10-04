const cloud = require('wx-server-sdk')
const crypto = require('node:crypto')
const https = require('node:https')
const cloudbase = require('@cloudbase/node-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const storage = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_MEDIA_BYTES = 512 * 1024 * 1024

class AppError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const fail = (code, message) => { throw new AppError(code, message) }
const now = () => new Date().toISOString()
const today = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}
const id = () => crypto.randomUUID()
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const memberId = (spaceId, openid) => hash(`${spaceId}:${openid}`)
const privateFields = new Set(['ownerId', 'userId', 'actorId', 'createdBy', 'updatedBy', 'uploadedBy', 'usedBy'])
const withIds = value => Array.isArray(value) ? value.map(withIds) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !privateFields.has(key)).map(([key, item]) => [key, withIds(item)]).concat(value._id ? [['id', value._id]] : [])) : value
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function obj(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', '请求数据格式错误')
  return value
}

function str(value, field, max, required = false) {
  if (value == null && !required) return ''
  if (typeof value !== 'string') fail('INVALID_INPUT', `${field}格式错误`)
  const result = value.trim()
  if (result.length > max || (required && !result)) fail('INVALID_INPUT', `${field}长度不符合要求`)
  return result
}

function docId(value, field = 'ID') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) fail('INVALID_INPUT', `${field}格式错误`)
  return value
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', '缺少有效版本号')
  return value
}

function date(value, field = '日期') {
  const text = str(value, field, 10, true)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)) || new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) !== text) fail('INVALID_INPUT', `${field}格式错误`)
  return text
}

function strings(value, field, count, max) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > count) fail('INVALID_INPUT', `${field}数量超限`)
  return [...new Set(value.map(item => str(item, field, max, true)))]
}

function fileIds(value, count = 12) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > count) fail('INVALID_INPUT', '照片数量超限')
  return [...new Set(value.map(fileId => {
    if (typeof fileId !== 'string' || fileId.length > 512 || !fileId.startsWith('cloud://')) fail('INVALID_INPUT', '照片标识无效')
    return fileId
  }))]
}

async function read(ref) {
  try {
    const result = await ref.get()
    return Array.isArray(result.data) ? result.data[0] || null : result.data || null
  } catch (error) {
    if (['DATABASE_DOCUMENT_NOT_EXIST', 'DOCUMENT_NOT_FOUND'].includes(error.errCode || error.code) ||
      /^document\.get:fail document with _id .+ does not exist$/.test(error.message || '')) return null
    throw error
  }
}

function publicSpace(space) {
  if (!space) return null
  return { _id: space._id, name: space.name, memberCount: space.memberCount, currentMealId: space.currentMealId || '',
    mediaBytes: space.mediaBytes || 0, mediaLimitBytes: MAX_MEDIA_BYTES, catalogVersion: space.catalogVersion || 0,
    categories: space.categories || [], tags: space.tags || [], createdAt: space.createdAt, updatedAt: space.updatedAt }
}

function resolvedRecipe(recipe, space) {
  if (!recipe) return null
  const categories = space.categories || []
  const tags = space.tags || []
  const category = has(recipe, 'categoryId')
    ? (categories.find(item => item.id === recipe.categoryId && !item.deletedAt) || {}).name || '未分类'
    : recipe.category || '未分类'
  const names = has(recipe, 'tagIds')
    ? (recipe.tagIds || []).map(tagId => tags.find(item => item.id === tagId && !item.deletedAt)).filter(Boolean).map(item => item.name)
    : recipe.tags || []
  return { ...recipe, category, tags: names, cookCount: Number.isSafeInteger(recipe.cookCount) && recipe.cookCount >= 0 ? recipe.cookCount : 0 }
}

async function resolvedRecipes(recipes, space) {
  const result = []
  for (let recipe of recipes) {
    if (!Number.isSafeInteger(recipe.cookCount) || recipe.cookCount < 0) {
      recipe = { ...recipe, cookCount: await db.runTransaction(tx => adjustCookCount(tx, space._id, recipe._id, 0), 5) }
    }
    result.push(resolvedRecipe(recipe, space))
  }
  return result
}

function externalUrl(value) {
  const input = str(value, '外部链接', 2048)
  if (!input) return ''
  let parsed
  try { parsed = new URL(input) } catch { fail('INVALID_INPUT', '外部链接必须是完整的网址') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) fail('INVALID_INPUT', '外部链接必须是安全的网页地址')
  return input
}

function publicMember(member) {
  if (!member) return null
  return { _id: member._id, displayName: member.displayName, role: member.role, joinedAt: member.joinedAt }
}

async function user(openid) {
  return read(db.collection('users').doc(openid))
}

async function membership(openid) {
  const account = await user(openid)
  if (!account || !account.spaceId) fail('NO_SPACE', '请先创建或加入厨房')
  const [space, member] = await Promise.all([
    read(db.collection('spaces').doc(account.spaceId)),
    read(db.collection('space_members').doc(memberId(account.spaceId, openid)))
  ])
  if (!space || !member || member.spaceId !== account.spaceId || member.userId !== openid) fail('FORBIDDEN', '无权访问这个厨房')
  return { space, member }
}

async function activeMember(tx, spaceId, openid) {
  // CloudBase rejects overlapping document requests inside one transaction.
  const account = await read(tx.collection('users').doc(openid))
  const member = await read(tx.collection('space_members').doc(memberId(spaceId, openid)))
  if (!account || account.spaceId !== spaceId || !member || member.spaceId !== spaceId || member.userId !== openid) fail('FORBIDDEN', '无权访问这个厨房')
  return member
}

async function owned(collection, itemId, spaceId, tx = db) {
  const item = await read(tx.collection(collection).doc(docId(itemId)))
  if (!item || item.spaceId !== spaceId || item.deletedAt) fail('NOT_FOUND', '内容不存在或已删除')
  return item
}

async function listed(collection, spaceId, offset = 0, extra = {}) {
  // ponytail: offset pagination is capped at 10k; switch to cursor pagination if a kitchen reaches it.
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_INPUT', '翻页参数错误')
  if (['meals', 'cooking_records'].includes(collection)) {
    // ponytail: reuse sorted indexes for small kitchens; index deletion state if histories exceed a few hundred rows.
    const rows = []
    for (let scanned = 0; scanned <= 10000 && rows.length < offset + 50; scanned += 50) {
      const page = await db.collection(collection).where({ spaceId, ...extra }).orderBy('updatedAt', 'desc').skip(scanned).limit(50).get()
      rows.push(...page.data.filter(item => !item.deletedAt))
      if (page.data.length < 50) break
    }
    return rows.slice(offset, offset + 50)
  }
  const result = await db.collection(collection).where({ spaceId, ...extra }).orderBy('updatedAt', 'desc').skip(offset).limit(50).get()
  return result.data
}

async function checkFiles(spaceId, files, source = db, previous) {
  const ids = [...new Set(files.filter(Boolean))]
  const assets = []
  if (source === db) assets.push(...await Promise.all(ids.map(fileId => read(source.collection('media_assets').doc(hash(fileId))))))
  else for (const fileId of ids) assets.push(await read(source.collection('media_assets').doc(hash(fileId))))
  if (assets.some((asset, i) => !asset || asset.fileId !== ids[i] || asset.spaceId !== spaceId || (asset.status && asset.status !== 'active'))) fail('INVALID_MEDIA', '照片不属于当前厨房或正在回收')
  for (const fileId of previous ? ids.filter(value => !previous.includes(value)) : []) {
    // Saving a new reference writes the same asset document that discardMedia marks.
    // One of two concurrent transactions must retry, so the reference cannot be added after deletion starts.
    await source.collection('media_assets').doc(hash(fileId)).update({ data: { lastLinkedAt: now() } })
  }
}

async function saveEntity(collection, spaceId, member, payload, fields, guard) {
  const itemId = payload._id || payload.id
  if (itemId) docId(itemId)
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, spaceId, member.userId)
    const old = itemId ? await owned(collection, itemId, spaceId, tx) : null
    if (old) {
      if (old.version !== version(payload.version)) fail('VERSION_CONFLICT', '内容已被更新，请刷新后重试')
      if (collection === 'recipes' && old.archivedAt) fail('INVALID_STATE', '已归档的菜品不能编辑')
    }
    const nextFields = typeof fields === 'function' ? await fields(tx, old) : fields
    if (guard) await guard(tx, old, nextFields)
    if (itemId) {
      const next = { ...nextFields, updatedAt: stamp, updatedBy: member.userId, version: old.version + 1 }
      await tx.collection(collection).doc(itemId).update({ data: next })
      return { ...old, ...next }
    }
    const newId = id()
    const item = { _id: newId, spaceId, ...nextFields, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: member.userId, updatedBy: member.userId }
    await tx.collection(collection).add({ data: item })
    return item
  })
}

async function bootstrap(openid) {
  const account = await user(openid)
  if (!account || !account.spaceId) return { space: null, member: null }
  const { space, member } = await membership(openid)
  return { space: publicSpace(space), member: publicMember(member) }
}

async function createSpace(openid, p) {
  const name = str(p.name, '厨房名称', 40, true)
  const displayName = str(p.displayName, '昵称', 24) || '厨房主理人'
  if (await user(openid)) fail('ALREADY_IN_SPACE', '你已经加入一间厨房')
  const spaceId = id()
  const stamp = now()
  const space = { _id: spaceId, name, ownerId: openid, memberCount: 1, currentMealId: '', inviteEpoch: 0, mediaBytes: 0,
    categories: [], tags: [], catalogVersion: 1, createdAt: stamp, updatedAt: stamp }
  const member = { _id: memberId(spaceId, openid), spaceId, userId: openid, displayName, role: 'owner', joinedAt: stamp, updatedAt: stamp }
  try {
    await db.runTransaction(async tx => {
      await tx.collection('users').add({ data: { _id: openid, spaceId, displayName, createdAt: stamp, updatedAt: stamp } })
      await tx.collection('spaces').add({ data: space })
      await tx.collection('space_members').add({ data: member })
    })
  } catch (error) {
    if (await user(openid)) fail('ALREADY_IN_SPACE', '你已经加入一间厨房')
    throw error
  }
  return { space: publicSpace(space), member: publicMember(member) }
}

async function renameSpace(openid, p) {
  const { space } = await membership(openid)
  const name = str(p.name, '厨房名称', 40, true)
  const stamp = now()
  return db.runTransaction(async tx => {
    const member = await activeMember(tx, space._id, openid)
    const current = await read(tx.collection('spaces').doc(space._id))
    if (!current) fail('NO_SPACE', '厨房不存在')
    if (current.name === name) return publicSpace(current)
    await tx.collection('spaces').doc(space._id).update({ data: { name, updatedAt: stamp } })
    return publicSpace({ ...current, name, updatedAt: stamp })
  }, 5)
}

async function manageTaxonomy(openid, p) {
  const { space } = await membership(openid)
  const kind = str(p.kind, '类型', 20, true)
  const op = str(p.op, '操作', 20, true)
  if (!['category', 'tag'].includes(kind) || !['create', 'rename', 'delete'].includes(op)) fail('INVALID_INPUT', '分类或标签操作错误')
  const key = kind === 'category' ? 'categories' : 'tags'
  const label = kind === 'category' ? '分类' : '标签'
  const name = op === 'delete' ? '' : str(p.name, label, kind === 'category' ? 24 : 20, true)
  if (kind === 'category' && ['全部', '未分类'].includes(name)) fail('INVALID_INPUT', '这是菜单保留的分类名称')
  const targetId = op === 'create' ? '' : docId(p.id, `${label}ID`)
  if (!Number.isSafeInteger(p.version) || p.version < 0) fail('INVALID_INPUT', '缺少有效目录版本')
  return db.runTransaction(async tx => {
    const member = await activeMember(tx, space._id, openid)
    const current = await read(tx.collection('spaces').doc(space._id))
    if (!current) fail('NO_SPACE', '厨房不存在')
    if ((current.catalogVersion || 0) !== p.version) fail('VERSION_CONFLICT', '分类或标签已被更新，请刷新后重试')
    const entries = current[key] || []
    const target = targetId ? entries.find(item => item.id === targetId) : null
    if (targetId && (!target || target.deletedAt)) fail('NOT_FOUND', `${label}不存在`)
    if (op !== 'delete' && entries.some(item => !item.deletedAt && item.id !== targetId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail('INVALID_INPUT', `${label}名称已存在`)
    if (op === 'create' && entries.filter(item => !item.deletedAt).length >= (kind === 'category' ? 30 : 100)) fail('INVALID_INPUT', `${label}数量已达上限`)
    if (op === 'rename' && target.name === name) return { categories: current.categories || [], tags: current.tags || [], catalogVersion: current.catalogVersion || 0 }
    const stamp = now()
    const updated = op === 'create' ? [...entries, { id: id(), name, deletedAt: '' }]
      : entries.map(item => item.id === targetId ? { ...item, ...(op === 'rename' ? { name } : { deletedAt: stamp }) } : item)
    const next = { [key]: updated, catalogVersion: (current.catalogVersion || 0) + 1, updatedAt: stamp }
    await tx.collection('spaces').doc(space._id).update({ data: next })
    return { categories: kind === 'category' ? updated : current.categories || [], tags: kind === 'tag' ? updated : current.tags || [], catalogVersion: next.catalogVersion }
  }, 5)
}

async function createInvite(openid) {
  const { space } = await membership(openid)
  if (space.memberCount >= 2) fail('SPACE_FULL', '厨房已经有两位成员')
  const code = crypto.randomBytes(10).toString('hex').toUpperCase()
  const stamp = now()
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  await db.runTransaction(async tx => {
    const actor = await activeMember(tx, space._id, openid)
    if (actor.role !== 'owner') fail('FORBIDDEN', '只有厨房创建者可以邀请成员')
    const current = await read(tx.collection('spaces').doc(space._id))
    if (!current || current.memberCount >= 2) fail('SPACE_FULL', '厨房已经有两位成员')
    await tx.collection('invitations').add({ data: { _id: hash(code), spaceId: space._id, inviteEpoch: current.inviteEpoch || 0, createdBy: openid, createdAt: stamp, expiresAt, status: 'open' } })
  })
  return { code, expiresAt }
}

async function joinSpace(openid, p) {
  const code = str(p.code, '邀请码', 20, true).toUpperCase()
  if (!/^[A-F0-9]{20}$/.test(code)) fail('INVALID_INPUT', '邀请码格式错误')
  if (await user(openid)) fail('ALREADY_IN_SPACE', '你已经加入一间厨房')
  const inviteId = hash(code)
  const invitation = await read(db.collection('invitations').doc(inviteId))
  if (!invitation) fail('INVALID_INVITE', '邀请码不存在或已失效')
  const displayName = str(p.displayName, '昵称', 24) || '厨房伙伴'
  const stamp = now()
  let joined
  try {
    joined = await db.runTransaction(async tx => {
      const invite = await read(tx.collection('invitations').doc(inviteId))
      if (!invite || invite.status !== 'open' || Date.parse(invite.expiresAt) <= Date.now()) fail('INVALID_INVITE', '邀请码不存在或已失效')
      const space = await read(tx.collection('spaces').doc(invite.spaceId))
      if (!space || space.memberCount >= 2) fail('SPACE_FULL', '厨房已经有两位成员')
      if ((invite.inviteEpoch || 0) !== (space.inviteEpoch || 0)) fail('INVALID_INVITE', '邀请码不存在或已失效')
      const member = { _id: memberId(space._id, openid), spaceId: space._id, userId: openid, displayName, role: 'member', joinedAt: stamp, updatedAt: stamp }
      await tx.collection('users').add({ data: { _id: openid, spaceId: space._id, displayName, createdAt: stamp, updatedAt: stamp } })
      await tx.collection('space_members').add({ data: member })
      await tx.collection('spaces').doc(space._id).update({ data: { memberCount: space.memberCount + 1, updatedAt: stamp } })
      await tx.collection('invitations').doc(inviteId).update({ data: { status: 'used', usedBy: openid, usedAt: stamp } })
      return { space: publicSpace({ ...space, memberCount: space.memberCount + 1, updatedAt: stamp }), member: publicMember(member) }
    })
  } catch (error) {
    if (await user(openid)) fail('ALREADY_IN_SPACE', '你已经加入一间厨房')
    throw error
  }
  return joined
}

async function listMembers(openid) {
  const { space } = await membership(openid)
  const result = await db.collection('space_members').where({ spaceId: space._id }).limit(2).get()
  return result.data.map(publicMember)
}

async function transferOwner(openid, p) {
  const { space } = await membership(openid)
  const targetId = docId(p.userId, '成员ID')
  const stamp = now()
  return db.runTransaction(async tx => {
    const actor = await activeMember(tx, space._id, openid)
    if (actor.role !== 'owner') fail('FORBIDDEN', '只有厨房创建者可以移交负责人')
    const target = await read(tx.collection('space_members').doc(targetId))
    if (!target || target.spaceId !== space._id || target.role !== 'member' || target.userId === openid) fail('INVALID_INPUT', '请选择同厨房的另一位成员')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace || currentSpace.ownerId !== openid) fail('VERSION_CONFLICT', '负责人已变化，请刷新后重试')
    await tx.collection('space_members').doc(actor._id).update({ data: { role: 'member', updatedAt: stamp } })
    await tx.collection('space_members').doc(targetId).update({ data: { role: 'owner', updatedAt: stamp } })
    await tx.collection('spaces').doc(space._id).update({ data: { ownerId: target.userId, updatedAt: stamp } })
    return { space: publicSpace({ ...currentSpace, ownerId: target.userId, updatedAt: stamp }), member: publicMember({ ...actor, role: 'member', updatedAt: stamp }) }
  }, 5)
}

async function leaveSpace(openid) {
  const { space } = await membership(openid)
  const stamp = now()
  return db.runTransaction(async tx => {
    const actor = await activeMember(tx, space._id, openid)
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace) fail('NO_SPACE', '厨房不存在')
    if (actor.role === 'owner') fail('OWNER_CANNOT_LEAVE', currentSpace.memberCount > 1 ? '请先移交负责人再退出' : '当前只有你一人，可继续保留厨房')
    await tx.collection('space_members').doc(actor._id).remove()
    await tx.collection('users').doc(openid).remove()
    await tx.collection('spaces').doc(space._id).update({ data: { memberCount: currentSpace.memberCount - 1, inviteEpoch: (currentSpace.inviteEpoch || 0) + 1, updatedAt: stamp } })
    return { left: true }
  }, 5)
}

async function removeMember(openid, p) {
  const { space } = await membership(openid)
  const targetId = docId(p.userId, '成员ID')
  const stamp = now()
  return db.runTransaction(async tx => {
    const actor = await activeMember(tx, space._id, openid)
    if (actor.role !== 'owner') fail('FORBIDDEN', '只有厨房创建者可以移除成员')
    const target = await read(tx.collection('space_members').doc(targetId))
    if (!target || target.spaceId !== space._id || target.role !== 'member' || target.userId === openid) fail('INVALID_INPUT', '请选择同厨房的另一位成员')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace || currentSpace.ownerId !== openid) fail('VERSION_CONFLICT', '负责人已变化，请刷新后重试')
    await tx.collection('space_members').doc(targetId).remove()
    await tx.collection('users').doc(target.userId).remove()
    await tx.collection('spaces').doc(space._id).update({ data: { memberCount: currentSpace.memberCount - 1, inviteEpoch: (currentSpace.inviteEpoch || 0) + 1, updatedAt: stamp } })
    return { removed: true, userId: targetId }
  }, 5)
}

function recipeFields(p, old, space, preservePhotos = false) {
  const categories = space.categories || []
  const tags = space.tags || []
  const explicitCategory = has(p, 'categoryId')
  const explicitTags = has(p, 'tagIds')
  if (old && has(old, 'categoryId') && !explicitCategory && has(p, 'category') &&
      str(p.category, '分类', 24) !== resolvedRecipe(old, space).category) fail('UPGRADE_REQUIRED', '请更新小程序后修改分类')
  if (old && has(old, 'tagIds') && !explicitTags && has(p, 'tags') &&
      JSON.stringify(strings(p.tags, '标签', 8, 20)) !== JSON.stringify(resolvedRecipe(old, space).tags)) fail('UPGRADE_REQUIRED', '请更新小程序后修改标签')
  const categoryId = explicitCategory ? (p.categoryId ? docId(p.categoryId, '分类ID') : '') : old && old.categoryId || ''
  const categoryEntry = categories.find(item => item.id === categoryId && !item.deletedAt)
  if (explicitCategory && categoryId && !categoryEntry) fail('INVALID_INPUT', '分类不存在或已删除')
  const tagIds = explicitTags ? strings(p.tagIds, '标签ID', 8, 80).map(value => docId(value, '标签ID')) : old && old.tagIds || []
  const tagEntries = tagIds.map(tagId => tags.find(item => item.id === tagId && !item.deletedAt))
  if (explicitTags && tagEntries.some(item => !item)) fail('INVALID_INPUT', '标签不存在或已删除')
  const available = p.available == null ? old ? old.available : true : p.available
  if (typeof available !== 'boolean') fail('INVALID_INPUT', '可点状态格式错误')
  const cover = has(p, 'coverFileId') ? (p.coverFileId ? fileIds([p.coverFileId], 1)[0] : '') : old && old.coverFileId || ''
  return {
    name: str(p.name == null ? old && old.name : p.name, '菜名', 80, true),
    ...(!old ? { cookCount: 0 } : {}),
    ...(explicitCategory || old && has(old, 'categoryId') ? { categoryId } : {}),
    ...(explicitTags || old && has(old, 'tagIds') ? { tagIds } : {}),
    category: categoryId ? categoryEntry ? categoryEntry.name : old && old.category || ''
      : explicitCategory ? '' : has(p, 'category') ? str(p.category, '分类', 24) : old && old.category || '',
    tags: tagIds.length ? explicitTags ? tagEntries.map(item => item.name) : old && old.tags || []
      : explicitTags ? [] : has(p, 'tags') ? strings(p.tags, '标签', 8, 20) : old && old.tags || [],
    description: has(p, 'description') ? str(p.description, '描述', 500) : old && old.description || '',
    externalUrl: has(p, 'externalUrl') ? externalUrl(p.externalUrl) : old && old.externalUrl || '',
    ingredients: has(p, 'ingredients') ? str(p.ingredients, '食材', 4000) : old && old.ingredients || '',
    steps: has(p, 'steps') ? str(p.steps, '做法', 8000) : old && old.steps || '',
    coverFileId: cover,
    photoFileIds: has(p, 'photoFileIds') ? fileIds(p.photoFileIds, 12) : preservePhotos ? old && old.photoFileIds || [] : [],
    available,
    archivedAt: null
  }
}

async function saveRecipe(openid, p) {
  const { space, member } = await membership(openid)
  let catalog = space
  const saved = await saveEntity('recipes', space._id, member, p, async (tx, old) => {
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    catalog = currentSpace
    return recipeFields(p, old, currentSpace)
  }, (tx, old, fields) => checkFiles(space._id, [fields.coverFileId, ...fields.photoFileIds], tx,
    old ? [old.coverFileId, ...(old.photoFileIds || [])] : []))
  return (await resolvedRecipes([saved], catalog))[0]
}

async function archiveRecipe(openid, p) {
  const { space, member } = await membership(openid)
  const recipeId = docId(p.id || p._id)
  const expected = version(p.version)
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = await owned('recipes', recipeId, space._id, tx)
    if (old.version !== expected) fail('VERSION_CONFLICT', '内容已被更新，请刷新后重试')
    if (old.archivedAt) fail('INVALID_STATE', '菜品已经归档')
    const fields = { archivedAt: stamp, availableBeforeArchive: old.available, available: false, version: old.version + 1, updatedAt: stamp, updatedBy: member.userId }
    await tx.collection('recipes').doc(recipeId).update({ data: fields })
    return { ...old, ...fields }
  })
}

async function unarchiveRecipe(openid, p) {
  const { space, member } = await membership(openid)
  const recipeId = docId(p.id || p._id, '菜品ID')
  const expected = version(p.version)
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = await owned('recipes', recipeId, space._id, tx)
    if (old.version !== expected) fail('VERSION_CONFLICT', '内容已被更新，请刷新后重试')
    if (!old.archivedAt) fail('INVALID_STATE', '菜品未归档')
    const fields = { archivedAt: null, available: old.availableBeforeArchive == null ? true : old.availableBeforeArchive, version: old.version + 1, updatedAt: stamp, updatedBy: member.userId }
    await tx.collection('recipes').doc(recipeId).update({ data: fields })
    return { ...old, ...fields }
  })
}

async function saveLinkedWish(openid, p) {
  const { space, member } = await membership(openid)
  const recipeInput = obj(p.recipe)
  const wishId = p._id || p.id ? docId(p._id || p.id, '心愿ID') : id()
  const recipeInputId = recipeInput._id || recipeInput.id
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    const oldWish = p._id || p.id ? await owned('wishes', wishId, space._id, tx) : null
    if (oldWish && oldWish.version !== version(p.version)) fail('VERSION_CONFLICT', '心愿已被更新，请刷新后重试')
    if (oldWish && oldWish.status === 'deleted') fail('INVALID_STATE', '已删除的心愿不能编辑')
    if (!oldWish && p.status && p.status !== 'open') fail('INVALID_STATE', '新心愿应从未完成开始')
    if (p.status && !['open', 'completed'].includes(p.status)) fail('INVALID_INPUT', '心愿状态错误')
    if (p.status === 'completed' && oldWish && oldWish.status !== 'completed') fail('INVALID_STATE', '请使用完成心愿操作')
    const recipeId = recipeInputId ? docId(recipeInputId, '菜品ID') : oldWish && oldWish.recipeId || id()
    if (oldWish && oldWish.recipeId && oldWish.recipeId !== recipeId) fail('INVALID_INPUT', '心愿不能改绑另一道菜')
    const oldRecipe = recipeInputId || oldWish && oldWish.recipeId ? await owned('recipes', recipeId, space._id, tx) : null
    if (oldRecipe && oldRecipe.version !== version(recipeInput.version)) fail('VERSION_CONFLICT', '菜品已被更新，请刷新后重试')
    if (oldRecipe && (oldRecipe.archivedAt || oldRecipe.wishId && oldRecipe.wishId !== wishId)) fail('INVALID_STATE', '这道菜已归档或关联其他心愿')
    const fields = recipeFields(recipeInput, oldRecipe, currentSpace, true)
    await checkFiles(space._id, [fields.coverFileId, ...fields.photoFileIds], tx,
      oldRecipe ? [oldRecipe.coverFileId, ...(oldRecipe.photoFileIds || [])] : [])
    const nextRecipe = { ...fields, wishId, version: oldRecipe ? oldRecipe.version + 1 : 1, updatedAt: stamp, updatedBy: openid }
    const recipe = oldRecipe
      ? { ...oldRecipe, ...nextRecipe }
      : { _id: recipeId, spaceId: space._id, ...fields, wishId, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid }
    if (oldRecipe) await tx.collection('recipes').doc(recipeId).update({ data: nextRecipe })
    else await tx.collection('recipes').add({ data: recipe })
    const type = p.type || oldWish && oldWish.type || 'cook'
    if (!['eat', 'cook'].includes(type)) fail('INVALID_INPUT', '心愿类型错误')
    const reopening = p.status === 'open' && oldWish && oldWish.status === 'completed'
    const wishFields = { title: fields.name, type, note: has(p, 'note') ? str(p.note, '备注', 1000) : oldWish && oldWish.note || '', recipeId,
      ...(reopening ? { status: 'open', completedAt: null, recordId: '' } : oldWish ? {} : { status: 'open', completedAt: null, recordId: '' }) }
    const nextWish = { ...wishFields, version: oldWish ? oldWish.version + 1 : 1, updatedAt: stamp, updatedBy: openid }
    const wish = oldWish
      ? { ...oldWish, ...nextWish }
      : { _id: wishId, spaceId: space._id, ...wishFields, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid }
    if (oldWish) await tx.collection('wishes').doc(wishId).update({ data: nextWish })
    else await tx.collection('wishes').add({ data: wish })
    return { ...wish, recipe: resolvedRecipe(recipe, currentSpace) }
  }, 5)
}

async function hydratedWishes(wishes, space) {
  const ids = [...new Set(wishes.map(item => item.recipeId).filter(Boolean))]
  const found = new Map()
  for (let index = 0; index < ids.length; index += 20) {
    const result = await db.collection('recipes').where({ _id: db.command.in(ids.slice(index, index + 20)) }).limit(20).get()
    for (const recipe of await resolvedRecipes(result.data.filter(item => item.spaceId === space._id), space)) found.set(recipe._id, recipe)
  }
  return wishes.map(wish => ({ ...wish, recipe: found.get(wish.recipeId) || null }))
}

async function saveWish(openid, p) {
  if (p.recipe) return saveLinkedWish(openid, p)
  const { space, member } = await membership(openid)
  const title = str(p.title, '心愿', 100, true)
  if (p._id || p.id) {
    if (p.status && !['open', 'completed'].includes(p.status)) fail('INVALID_INPUT', '心愿状态错误')
    const saved = await saveEntity('wishes', space._id, member, p, async (tx, old) => {
      if (old.status === 'deleted') fail('INVALID_STATE', '已删除的心愿不能编辑')
      const recipeId = has(p, 'recipeId') ? p.recipeId ? docId(p.recipeId, '菜品ID') : '' : old.recipeId || ''
      if (old.recipeId && recipeId !== old.recipeId) fail('UPGRADE_REQUIRED', '请更新小程序后修改心愿关联')
      const recipe = recipeId ? await owned('recipes', recipeId, space._id, tx) : null
      if (recipe && old.recipeId && title !== old.title && title !== recipe.name) fail('UPGRADE_REQUIRED', '请更新小程序后修改菜名')
      const type = p.type || old.type || 'cook'
      if (!['eat', 'cook'].includes(type)) fail('INVALID_INPUT', '心愿类型错误')
      if (p.status === 'completed' && old.status !== 'completed') fail('INVALID_STATE', '请使用完成心愿操作')
      const fields = { title, type, note: has(p, 'note') ? str(p.note, '备注', 1000) : old.note || '', recipeId }
      return p.status === 'open' && old.status === 'completed' ? { ...fields, status: 'open', completedAt: null, recordId: '' } : fields
    })
    return (await hydratedWishes([saved], space))[0]
  }
  if (p.status && p.status !== 'open') fail('INVALID_STATE', '新心愿应从未完成开始')
  const type = p.type || 'cook'
  if (!['eat', 'cook'].includes(type)) fail('INVALID_INPUT', '心愿类型错误')
  const recipeId = p.recipeId ? docId(p.recipeId, '菜品ID') : ''
  if (recipeId) await owned('recipes', recipeId, space._id)
  const fields = { title, type, note: str(p.note, '备注', 1000), recipeId }
  const saved = await saveEntity('wishes', space._id, member, p, { ...fields, status: 'open', completedAt: null, recordId: '' })
  return (await hydratedWishes([saved], space))[0]
}

async function completeWish(openid, p) {
  const { space, member } = await membership(openid)
  const wishId = docId(p.id || p._id, '心愿ID')
  const expected = version(p.version)
  const recordId = p.recordId ? docId(p.recordId, '记录ID') : ''
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    let record = null
    if (recordId) {
      record = await owned('cooking_records', recordId, space._id, tx)
      if (record.wishId !== wishId) fail('INVALID_INPUT', '这条制作记录未关联当前心愿')
    }
    const old = await owned('wishes', wishId, space._id, tx)
    if (old.version !== expected) fail('VERSION_CONFLICT', '内容已被更新，请刷新后重试')
    if (old.status !== 'open') fail('INVALID_STATE', '心愿已实现或删除')
    const recipeId = old.recipeId || hash(`legacy-wish:${space._id}:${wishId}`)
    if (old.recipeId) {
      const recipe = await owned('recipes', recipeId, space._id, tx)
      if (recipe.wishId && recipe.wishId !== wishId) fail('INVALID_STATE', '这道菜属于另一条心愿')
      if (recipe.available === false || recipe.archivedAt) await tx.collection('recipes').doc(recipeId).update({ data: {
        available: true, archivedAt: null, version: recipe.version + 1, updatedAt: stamp, updatedBy: openid
      } })
    } else {
      const existing = await read(tx.collection('recipes').doc(recipeId))
      if (existing) fail('INVALID_STATE', '心愿菜品标识冲突')
      await tx.collection('recipes').add({ data: {
        _id: recipeId, spaceId: space._id, name: str(old.title, '心愿', 100, true).slice(0, 80),
        categoryId: '', tagIds: [], category: '', tags: [], description: '', externalUrl: '', ingredients: '', steps: '',
        coverFileId: '', photoFileIds: [], cookCount: 0, available: true, archivedAt: null, wishId,
        version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid
      } })
    }
    if (record && record.recipeId && record.recipeId !== recipeId) fail('INVALID_INPUT', '制作记录关联了另一道菜')
    if (record && !record.recipeId) {
      await adjustCookCount(tx, space._id, recipeId, 1)
      await tx.collection('cooking_records').doc(recordId).update({ data: {
        recipeId, version: record.version + 1, updatedAt: stamp, updatedBy: openid
      } })
    }
    const fields = { recipeId, status: 'completed', completedAt: stamp, recordId, version: old.version + 1, updatedAt: stamp, updatedBy: member.userId }
    await tx.collection('wishes').doc(wishId).update({ data: fields })
    return { ...old, ...fields }
  })
}

async function deleteWish(openid, p) {
  const { space, member } = await membership(openid)
  const wishId = docId(p.id || p._id, '心愿ID')
  const expected = version(p.version)
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = await owned('wishes', wishId, space._id, tx)
    if (old.version !== expected) fail('VERSION_CONFLICT', '心愿已被更新，请刷新后重试')
    if (old.status !== 'open') fail('INVALID_STATE', '只能删除待实现的心愿')
    const fields = { status: 'deleted', version: old.version + 1, updatedAt: stamp, updatedBy: member.userId }
    await tx.collection('wishes').doc(wishId).update({ data: fields })
    return { ...old, ...fields }
  })
}

async function mealItems(space, value, previous = []) {
  const spaceId = space._id
  if (!Array.isArray(value) || value.length > 20) fail('INVALID_INPUT', '饭单菜品数量超限')
  const items = []
  const seen = new Set()
  const seenIds = new Set()
  for (const raw of value) {
    const item = obj(raw)
    const itemId = item.id ? docId(item.id, '项目ID') : id()
    if (seenIds.has(itemId)) fail('INVALID_INPUT', '饭单项目ID重复')
    seenIds.add(itemId)
    const recipeId = item.recipeId ? docId(item.recipeId, '菜品ID') : ''
    const wishId = item.wishId ? docId(item.wishId, '心愿ID') : ''
    const linkedWish = wishId ? await owned('wishes', wishId, spaceId) : null
    if (recipeId && linkedWish && linkedWish.recipeId !== recipeId) fail('INVALID_INPUT', '心愿未关联这道菜')
    const key = recipeId || linkedWish && linkedWish.recipeId ? `recipe:${recipeId || linkedWish.recipeId}` : wishId ? `wish:${wishId}` : ''
    if (key && seen.has(key) && !previous.some(entry => entry.id === itemId)) fail('INVALID_INPUT', '饭单里有重复菜品')
    if (key) seen.add(key)
    const old = previous.find(entry => entry.id === itemId && entry.recipeId === recipeId && entry.wishId === wishId)
    let name = old && (recipeId || wishId) ? old.name : str(item.name, '菜名', 100)
    const sourceId = recipeId || linkedWish && linkedWish.recipeId
    const recipe = sourceId && !old ? resolvedRecipe(await owned('recipes', sourceId, spaceId), space) : null
    if (recipe && recipeId) name = recipe.name
    if (wishId && !recipeId && !old) name = linkedWish.title
    if (!name) fail('INVALID_INPUT', '饭单项目缺少菜名')
    const state = item.state || 'planned'
    if (!['planned', 'cooked', 'skipped'].includes(state)) fail('INVALID_INPUT', '菜品状态错误')
    items.push({ id: itemId, recipeId, wishId, name, state,
      category: old ? old.category || '' : recipe ? recipe.category || '' : '',
      categoryId: old ? old.categoryId || '' : recipe ? recipe.categoryId || '' : '',
      ...(old && old.requestKey ? { requestKey: old.requestKey } : {}),
      ...(old && old.recordId ? { recordId: old.recordId } : {}),
      ...(old && old.dishMemory ? { dishMemory: old.dishMemory } : {}) })
  }
  return items
}

async function saveMeal(openid, p) {
  const { space, member } = await membership(openid)
  const itemId = p._id || p.id
  const previous = itemId ? await mealForDisplay(await owned('meals', docId(itemId), space._id), space) : null
  const status = p.status || (previous && previous.status) || 'draft'
  if (!['draft', 'confirmed', 'completed', 'cancelled'].includes(status)) fail('INVALID_INPUT', '饭单状态错误')
  const items = (await mealItems(space, p.items == null && previous ? previous.items : p.items || [], previous ? previous.items : []))
    .map(item => status === 'completed' ? { ...item, state: 'cooked' } : item)
  if (['confirmed', 'completed'].includes(status) && !items.length) fail('INVALID_INPUT', '饭单至少需要一道菜')
  const diners = p.diners == null ? 2 : p.diners
  if (!Number.isSafeInteger(diners) || diners < 1 || diners > 20) fail('INVALID_INPUT', '用餐人数错误')
  const fields = {
    title: str(p.title, '饭单标题', 80) || '一起开饭',
    date: date(p.date || (previous && previous.date) || today()),
    diners,
    note: str(p.note, '备注', 1000),
    items,
    status
  }
  const requestKey = p.requestId ? hash(`saveMeal:${space._id}:${openid}:${docId(p.requestId, '请求ID')}`) : ''
  const requestHash = hash(JSON.stringify({ title: fields.title, date: fields.date, diners, note: fields.note,
    status, items: fields.items.map(({ id, recipeId, wishId, name, state }) => ({ id, recipeId, wishId, name, state })) }))
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace) fail('NO_SPACE', '厨房不存在')
    if (itemId) {
      const old = await owned('meals', itemId, space._id, tx)
      const receipt = requestKey && (old.saveReceipts || []).find(entry => entry.key === requestKey)
      if (receipt) {
        if (receipt.hash !== requestHash) fail('REQUEST_CONFLICT', '保存内容已变化，请重新核对')
        return { ...old, replayed: true }
      }
      if (old.version !== version(p.version)) fail('VERSION_CONFLICT', '饭单已被更新，请刷新后重试')
      if (['completed', 'cancelled'].includes(old.status)) fail('INVALID_STATE', '这份饭单已经结束')
      if (currentSpace.currentMealId && currentSpace.currentMealId !== itemId) fail('NOT_CURRENT_MEAL', '请先处理当前饭单')
      if (status === 'completed') {
        const records = (await tx.collection('cooking_records').where({ spaceId: space._id, mealId: itemId }).limit(100).get()).data.filter(record => !record.deletedAt)
        const used = new Set()
        for (const item of fields.items) {
          if (item.state !== 'cooked') continue
          const sameDish = entry => entry.wishId === item.wishId && (!item.recipeId || entry.recipeId === item.recipeId)
          let record = item.recordId ? await owned('cooking_records', item.recordId, space._id, tx) : null
          if (!record) record = records.find(entry => !used.has(entry._id) && sameDish(entry) &&
            (entry.mealItemId === item.id || (item.wishId ? entry.wishId === item.wishId : !!item.recipeId && entry.recipeId === item.recipeId)))
          if (record && (record.mealId !== itemId || !sameDish(record) || used.has(record._id))) fail('INVALID_STATE', '制作记录与饭单不匹配')
          if (!record) {
            record = { _id: id(), spaceId: space._id, recipeId: item.recipeId, wishId: item.wishId, mealId: itemId,
              mealItemId: item.id, name: item.name, makerName: member.displayName, date: fields.date, note: '',
              photoFileIds: [], version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid }
            await tx.collection('cooking_records').add({ data: record })
            await adjustCookCount(tx, space._id, item.recipeId, 1)
          } else if (record.mealItemId !== item.id) {
            await tx.collection('cooking_records').doc(record._id).update({ data: { mealItemId: item.id } })
          }
          used.add(record._id)
          item.recordId = record._id
        }
      }
      const next = { ...fields, version: old.version + 1, updatedAt: stamp, updatedBy: member.userId,
        ...(status === 'completed' ? { menuSnapshot: menuSnapshot(fields, currentSpace), completedAt: stamp } : {}),
        ...(requestKey ? { saveReceipts: [...(old.saveReceipts || []), { key: requestKey, hash: requestHash }].slice(-20) } : {}) }
      await tx.collection('meals').doc(itemId).update({ data: next })
      if (currentSpace.currentMealId === itemId && ['completed', 'cancelled'].includes(status)) {
        await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: '', updatedAt: stamp } })
      } else if (!currentSpace.currentMealId && !['completed', 'cancelled'].includes(status)) {
        await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: itemId, updatedAt: stamp } })
      }
      return { ...old, ...next }
    }
    if (!['draft', 'confirmed'].includes(status)) fail('INVALID_STATE', '新饭单应从草稿开始')
    if (currentSpace.currentMealId) fail('CURRENT_MEAL_EXISTS', '已有当前饭单，请打开后继续编辑')
    const newId = id()
    const meal = { _id: newId, spaceId: space._id, ...fields, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: member.userId, updatedBy: member.userId }
    await tx.collection('meals').add({ data: meal })
    await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: newId, updatedAt: stamp } })
    return meal
  }, 5)
}

function menuSnapshot(meal, space) {
  const categories = (space.categories || []).filter(item => !item.deletedAt)
  const actual = meal.items.filter(item => ['cooked', 'eaten'].includes(item.state))
  const groups = []
  for (const item of actual) {
    const historical = (meal.menuSnapshot && meal.menuSnapshot.groups || []).find(group => group.items.some(entry => entry.id === item.id))
    const saved = historical && historical.items.find(entry => entry.id === item.id)
    const name = historical && (historical.name !== '未分类' || has(saved, 'category')) ? historical.name
      : item.category || (categories.find(entry => entry.id === item.categoryId) || {}).name || '未分类'
    let group = groups.find(entry => entry.name === name)
    if (!group) { group = { name, items: [] }; groups.push(group) }
    group.items.push({ id: item.id, name: item.name, category: name, categoryId: item.categoryId || '',
      recipeId: item.recipeId || '', wishId: item.wishId || '', recordId: item.recordId || '' })
  }
  const rank = name => name === '未分类' ? Infinity : categories.findIndex(item => item.name === name) < 0 ? categories.length : categories.findIndex(item => item.name === name)
  groups.sort((a, b) => rank(a.name) - rank(b.name))
  return { title: meal.title, date: meal.date, diners: meal.diners, groups }
}

// Older batch selections omitted category fields. Repair the read view only; named
// historical groups and explicit category snapshots (including uncategorized) win.
async function mealForDisplay(meal, space) {
  const groups = meal.menuSnapshot && meal.menuSnapshot.groups || []
  const items = await Promise.all(meal.items.map(async item => {
    const group = groups.find(group => group.items.some(entry => entry.id === item.id))
    const snapshot = group && group.items.find(entry => entry.id === item.id)
    if (group && (group.name !== '未分类' || has(snapshot, 'category'))) return item
    if (item.category) return item
    let category = (space.categories || []).find(entry => entry.id === item.categoryId)
    if (!category && !item.categoryId) {
      const wish = !item.recipeId && item.wishId ? await read(db.collection('wishes').doc(item.wishId)) : null
      const recipeId = item.recipeId || wish && wish.spaceId === space._id && wish.recipeId
      const recipe = recipeId ? await read(db.collection('recipes').doc(recipeId)) : null
      if (recipe && recipe.spaceId === space._id) category = { name: resolvedRecipe(recipe, space).category }
    }
    return category ? { ...item, category: category.name } : item
  }))
  const legacy = groups.some(group => group.name === '未分类' && group.items.some(item => !has(item, 'category')))
  if (!legacy && !items.some((item, i) => item !== meal.items[i])) return meal
  const view = { ...meal, items }
  return { ...view, ...(meal.status === 'completed' ? { menuSnapshot: menuSnapshot(view, space) } : {}) }
}

async function saveEatingMeal(openid, p) {
  const { space } = await membership(openid)
  const key = hash(`saveEatingMeal:${space._id}:${openid}:${docId(p.requestId, '请求ID')}`)
  const mealId = p.id ? docId(p.id, '饭单ID') : key
  const previous = p.id ? await mealForDisplay(await owned('meals', mealId, space._id), space) : null
  const fields = {}
  for (const [name, label, max] of [['title', '饭名', 80], ['note', '安排备注', 1000], ['reflection', '这顿的心得', 4000]]) {
    if (has(p, name)) fields[name] = str(p[name], label, max)
  }
  if (has(p, 'date')) fields.date = date(p.date)
  if (has(p, 'diners')) {
    if (!Number.isSafeInteger(p.diners) || p.diners < 1 || p.diners > 20) fail('INVALID_INPUT', '用餐人数需为1到20人')
    fields.diners = p.diners
  }
  if (has(p, 'items')) {
    if (!Array.isArray(p.items)) fail('INVALID_INPUT', '菜品信息格式错误')
    fields.items = await mealItems(space, p.items.map(item => ({ ...item, state: ['cooked', 'skipped'].includes(item.state) ? item.state : 'planned' })), previous ? previous.items : [])
    fields.items = fields.items.map(item => ({ ...item, state: previous && previous.items.some(old => old.id === item.id) ? previous.items.find(old => old.id === item.id).state : 'eaten' }))
  }
  if (has(p, 'photoFileIds')) fields.photoFileIds = fileIds(p.photoFileIds, 12)
  const customIds = (p.items || []).filter(item => item.addToMenu === true && !item.recipeId && !item.wishId).map(item => docId(item.id, '项目ID'))
  const digest = hash(JSON.stringify({ ...fields, ...(customIds.length ? { customIds } : {}) }))
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = await read(tx.collection('meals').doc(mealId))
    if (old && old.spaceId !== space._id) fail('NOT_FOUND', '记录不存在')
    if (old && old.deletedAt) fail('NOT_FOUND', '这条记录已删除')
    const receipt = old && (old.eatingReceipts || []).find(entry => entry.key === key)
    if (receipt) {
      if (receipt.hash !== digest) fail('REQUEST_CONFLICT', '保存内容已改变，请核对后重试')
      return { ...old, replayed: true }
    }
    if (old && !p.id) fail('REQUEST_CONFLICT', '这次记录已存在，请打开后编辑')
    if (old && old.status !== 'completed') fail('INVALID_STATE', '这顿饭状态已改变，请返回查看；你的输入仍保留')
    if (old && old.version !== version(p.version)) fail('VERSION_CONFLICT', '伙伴已更新这顿饭。你的输入仍保留，请先核对最新内容')
    if (has(fields, 'photoFileIds')) await checkFiles(space._id, fields.photoFileIds.filter(fileId => !(old && old.photoFileIds || []).includes(fileId)), tx, [])
    const next = { ...(old || { _id: mealId, spaceId: space._id, origin: 'manual', title: '一起吃饭', date: today(), diners: 2,
      note: '', reflection: '', photoFileIds: [], items: [], status: 'completed', createdAt: stamp, createdBy: openid }), ...fields,
      version: old ? old.version + 1 : 1, updatedAt: stamp, updatedBy: openid,
      eatingReceipts: [...(old && old.eatingReceipts || []), { key, hash: digest }].slice(-20) }
    if (!next.items.length && !old) fail('INVALID_INPUT', '请填写至少一道实际吃过的菜')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (has(fields, 'items')) next.items = fields.items.map(item => ({ ...item }))
    // Custom dishes join the library only on successful record save, in the same transaction.
    for (const item of next.items.filter(item => customIds.includes(item.id) && !item.recipeId && !item.wishId)) {
      const existing = (await tx.collection('recipes').where({ spaceId: space._id, name: item.name, archivedAt: null }).limit(1).get()).data[0]
      const wish = existing ? null : (await tx.collection('wishes').where({ spaceId: space._id, title: item.name, status: 'open' }).limit(1).get()).data[0]
      if (existing) { item.recipeId = existing._id; item.category = resolvedRecipe(existing, currentSpace).category; item.categoryId = existing.categoryId || '' }
      else if (wish) {
        item.wishId = wish._id; item.recipeId = wish.recipeId || ''
        if (item.recipeId) {
          const recipe = resolvedRecipe(await owned('recipes', item.recipeId, space._id, tx), currentSpace)
          item.category = recipe.category; item.categoryId = recipe.categoryId || ''
        }
      }
      else {
        const recipeId = hash(`eatingRecipe:${space._id}:${item.name}`)
        const recipe = await read(tx.collection('recipes').doc(recipeId))
        if (recipe && recipe.spaceId !== space._id) fail('NOT_FOUND', '菜品不可访问')
        if (!recipe) await tx.collection('recipes').add({ data: { _id: recipeId, spaceId: space._id,
          ...recipeFields({ name: item.name }, null, currentSpace), version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid } })
        item.recipeId = recipeId
      }
    }
    if (!old || ['title', 'date', 'diners', 'items'].some(field => has(fields, field))) {
      next.menuSnapshot = menuSnapshot({ ...next, items: has(fields, 'items') || !previous ? next.items : previous.items }, currentSpace)
    }
    // Eating is not cooking: this path never creates cooking records or touches currentMealId.
    if (old) { const { _id, ...patch } = next; await tx.collection('meals').doc(mealId).update({ data: patch }) }
    else await tx.collection('meals').add({ data: next })
    return next
  }, 5)
}

async function saveMealMemory(openid, p) {
  const { space } = await membership(openid)
  const mealId = docId(p.mealId, '饭单ID')
  const expected = version(p.version)
  if (has(p, 'expectedStatus') && p.expectedStatus !== 'completed') fail('INVALID_INPUT', '用餐记录状态无效')
  if (!has(p, 'photoFileIds') && !has(p, 'reflection')) fail('INVALID_INPUT', '没有要保存的用餐记录')
  const fields = {}
  if (has(p, 'photoFileIds')) fields.photoFileIds = fileIds(p.photoFileIds, 12)
  if (has(p, 'reflection')) fields.reflection = str(p.reflection, '这顿的心得', 4000)
  const requestKey = has(p, 'requestId') ? hash(`saveMealMemory:${space._id}:${openid}:${docId(p.requestId, '请求ID')}`) : ''
  const requestVersion = has(p, 'requestVersion') ? version(p.requestVersion) : expected
  if (requestVersion > expected) fail('INVALID_INPUT', '请求版本无效')
  const requestHash = hash(JSON.stringify({ expectedStatus: p.expectedStatus || '', ...fields }))
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const meal = await owned('meals', mealId, space._id, tx)
    const receipts = meal.memoryReceipts || []
    const receipt = requestKey && receipts.find(item => item.key === requestKey)
    if (receipt) {
      if (receipt.hash !== requestHash) fail('REQUEST_CONFLICT', '这次保存的内容已改变，请核对后重新保存')
      const changedSinceReceipt = receipt.savedVersion
        ? meal.version !== receipt.savedVersion
        : !!(p.expectedStatus && meal.status !== p.expectedStatus) || Object.entries(fields).some(([key, value]) =>
          JSON.stringify(meal[key] == null ? key === 'photoFileIds' ? [] : '' : meal[key]) !== JSON.stringify(value))
      return { ...meal, replayed: true, changedSinceReceipt }
    }
    if (requestKey && requestVersion <= (meal.memoryReceiptFloorVersion || 0)) fail('REQUEST_EXPIRED', '这次保存距今已有较多修改，请核对最新内容后重新保存；你的修改仍保留')
    if (meal.status === 'cancelled') fail('INVALID_STATE', '已取消的饭单不能编辑')
    if (p.expectedStatus && meal.status !== p.expectedStatus) fail('INVALID_STATE', '这顿饭已撤销完成，请刷新后查看；你的修改尚未保存')
    if (meal.version !== expected) fail('VERSION_CONFLICT', '饭单已被更新，请刷新后重试')
    if (has(p, 'photoFileIds')) {
      await checkFiles(space._id, fields.photoFileIds.filter(fileId => !(meal.photoFileIds || []).includes(fileId)), tx, [])
    }
    const next = { ...fields, version: meal.version + 1, updatedAt: stamp, updatedBy: openid }
    if (requestKey) {
      // ponytail: keep 20 receipts in the meal; older base versions require explicit reconciliation.
      const updated = [...receipts, { key: requestKey, hash: requestHash, baseVersion: requestVersion, savedVersion: next.version }]
      next.memoryReceipts = updated.slice(-20)
      next.memoryReceiptFloorVersion = Math.max(meal.memoryReceiptFloorVersion || 0, ...updated.slice(0, -20).map(item => item.baseVersion))
    }
    await tx.collection('meals').doc(mealId).update({ data: next })
    return { ...meal, ...next }
  }, 5)
}

function dishMemoryView(meal, item, record) {
  const memory = record || item.dishMemory || {}
  return { ...meal, sourceName: item.name, itemId: item.id, recordVersion: record ? record.version : 0,
    photoFileIds: memory.photoFileIds || [], reflection: record ? record.note || '' : memory.reflection || '' }
}

async function getMealDishMemory(openid, p) {
  const { space } = await membership(openid)
  const meal = await owned('meals', docId(p.mealId, '饭单ID'), space._id)
  const item = meal.items.find(item => item.id === docId(p.itemId, '项目ID'))
  if (!item || !['cooked', 'eaten'].includes(item.state)) fail('NOT_FOUND', '本餐没有这道实际吃过的菜')
  const record = item.recordId ? await owned('cooking_records', item.recordId, space._id) : null
  if (record && (record.mealId !== meal._id || record.mealItemId && record.mealItemId !== item.id)) fail('INVALID_STATE', '这道菜的记录关联已变化，请刷新')
  return dishMemoryView(meal, item, record)
}

async function saveMealDishMemory(openid, p) {
  const { space } = await membership(openid)
  const mealId = docId(p.mealId, '饭单ID'), itemId = docId(p.itemId, '项目ID'), expected = version(p.version)
  const baseVersion = version(p.requestVersion)
  if (baseVersion > expected || p.expectedStatus !== 'completed') fail('INVALID_INPUT', '记录版本或状态无效')
  const fields = {}
  if (has(p, 'photoFileIds')) fields.photoFileIds = fileIds(p.photoFileIds, 1)
  if (has(p, 'reflection')) fields.reflection = str(p.reflection, '这道菜的心得', 4000)
  if (!Object.keys(fields).length) fail('INVALID_INPUT', '没有要保存的内容')
  const key = hash(`mealDish:${space._id}:${openid}:${docId(p.requestId, '请求ID')}`)
  const requestHash = hash(JSON.stringify({ itemId, ...fields })), stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const meal = await owned('meals', mealId, space._id, tx)
    const item = meal.items.find(item => item.id === itemId)
    if (!item || !['cooked', 'eaten'].includes(item.state)) fail('INVALID_STATE', '这道菜的状态已变化，输入仍保留')
    const record = item.recordId ? await owned('cooking_records', item.recordId, space._id, tx) : null
    if (record && (record.mealId !== mealId || record.mealItemId && record.mealItemId !== itemId)) fail('INVALID_STATE', '制作记录关联已变化，请刷新')
    const receipts = meal.dishMemoryReceipts || [], receipt = receipts.find(item => item.key === key)
    if (receipt) {
      if (receipt.hash !== requestHash) fail('REQUEST_CONFLICT', '上次保存内容已变化，请核对')
      return { ...dishMemoryView(meal, item, record), replayed: true, changedSinceReceipt: meal.version !== receipt.savedVersion || !!record && record.version !== receipt.recordVersion }
    }
    if (baseVersion <= (meal.dishReceiptFloorVersion || 0)) fail('REQUEST_EXPIRED', '上次请求已过期，请核对最新内容；输入仍保留')
    if (meal.status !== 'completed') fail('INVALID_STATE', '这顿饭已撤销完成，输入仍保留')
    if (meal.version !== expected || record && record.version !== p.recordVersion) fail('VERSION_CONFLICT', '伙伴已更新这条内容，请核对；输入仍保留')
    const memory = dishMemoryView(meal, item, record)
    if (has(fields, 'photoFileIds')) await checkFiles(space._id, fields.photoFileIds, tx, memory.photoFileIds)
    let updatedRecord = record, updatedItem = item
    if (record) {
      const changes = { ...(has(fields, 'photoFileIds') ? { photoFileIds: fields.photoFileIds } : {}),
        ...(has(fields, 'reflection') ? { note: fields.reflection } : {}), version: record.version + 1, updatedAt: stamp, updatedBy: openid }
      await tx.collection('cooking_records').doc(record._id).update({ data: changes })
      updatedRecord = { ...record, ...changes }
    } else {
      // ponytail: retain standalone dish files conservatively; add reference-aware reclamation if storage warrants it.
      for (const fileId of (fields.photoFileIds || []).filter(fileId => !memory.photoFileIds.includes(fileId))) {
        await tx.collection('media_assets').doc(hash(fileId)).update({ data: { retainedForMealDish: true } })
      }
      updatedItem = { ...item, dishMemory: { ...(item.dishMemory || {}), ...fields } }
    }
    const updatedReceipts = [...receipts, { key, hash: requestHash, baseVersion, savedVersion: meal.version + 1,
      recordVersion: updatedRecord ? updatedRecord.version : 0 }]
    const changes = { items: meal.items.map(entry => entry.id === itemId ? updatedItem : entry), version: meal.version + 1,
      updatedAt: stamp, updatedBy: openid, dishMemoryReceipts: updatedReceipts.slice(-20),
      dishReceiptFloorVersion: Math.max(meal.dishReceiptFloorVersion || 0, ...updatedReceipts.slice(0, -20).map(item => item.baseVersion)) }
    await tx.collection('meals').doc(mealId).update({ data: changes })
    return dishMemoryView({ ...meal, ...changes }, updatedItem, updatedRecord)
  }, 5)
}

async function addMealItem(openid, p) {
  const { space, member } = await membership(openid)
  const requestId = docId(p.requestId, '请求ID')
  const requestKey = hash(`${openid}:${requestId}`)
  const [entry] = await mealItems(space, [p.item])
  if (entry.wishId && (await owned('wishes', entry.wishId, space._id)).status !== 'open') fail('INVALID_STATE', '心愿已变化，请刷新后重试')
  const preferredMealId = p.mealId ? docId(p.mealId, '饭单ID') : ''
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace) fail('NO_SPACE', '厨房不存在')
    const mealId = preferredMealId || currentSpace.currentMealId
    if (preferredMealId && currentSpace.currentMealId && preferredMealId !== currentSpace.currentMealId) fail('NOT_CURRENT_MEAL', '请先处理当前饭单')
    let meal = mealId ? await owned('meals', mealId, space._id, tx) : null
    if (meal && ['completed', 'cancelled'].includes(meal.status)) fail('INVALID_STATE', '这份饭单已经结束')
    if (meal) {
      if (meal.items.some(item => item.requestKey === requestKey)) return meal
      if (meal.items.length >= 20) fail('INVALID_INPUT', '饭单最多 20 道菜')
      if (entry.recipeId && meal.items.some(item => item.recipeId === entry.recipeId)) return meal
      if (entry.wishId && meal.items.some(item => item.wishId === entry.wishId)) return meal
      const items = [...meal.items, { ...entry, requestKey }]
      const next = { items, status: 'draft', version: meal.version + 1, updatedAt: stamp, updatedBy: openid }
      await tx.collection('meals').doc(meal._id).update({ data: next })
      if (!currentSpace.currentMealId) await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: meal._id, updatedAt: stamp } })
      return { ...meal, ...next }
    }
    if (preferredMealId) fail('NOT_FOUND', '饭单不存在')
    const newId = id()
    const mealRecord = {
      _id: newId, spaceId: space._id, title: '一起开饭', date: today(),
      diners: 2, note: '', items: [{ ...entry, requestKey }], status: 'draft',
      version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid
    }
    await tx.collection('meals').add({ data: mealRecord })
    await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: newId, updatedAt: stamp } })
    return mealRecord
  }, 5)
}

async function submitMealSelection(openid, p) {
  const { space, member } = await membership(openid)
  const requestId = docId(p.requestId, '请求ID')
  const preferredMealId = p.mealId ? docId(p.mealId, '饭单ID') : ''
  if (p.allowReconfirm != null && typeof p.allowReconfirm !== 'boolean') fail('INVALID_INPUT', '重新确认参数错误')
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 20) fail('INVALID_INPUT', '请选择 1 至 20 道菜')
  const selected = new Map()
  for (const raw of p.items) {
    const input = obj(raw)
    const recipeId = docId(input.recipeId, '菜品ID')
    const wishId = input.wishId ? docId(input.wishId, '心愿ID') : ''
    const old = selected.get(recipeId)
    if (old && old.wishId && wishId && old.wishId !== wishId) fail('INVALID_INPUT', '同一道菜关联了不同心愿')
    selected.set(recipeId, { recipeId, wishId: wishId || old && old.wishId || '' })
  }
  const entries = [...selected.values()].sort((a, b) => a.recipeId.localeCompare(b.recipeId))
  const requestHash = hash(JSON.stringify({ entries, preferredMealId }))
  const receiptId = hash(`submitMealSelection:${space._id}:${openid}:${requestId}`)
  try { return await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const receipt = await read(tx.collection('activity_logs').doc(receiptId))
    if (receipt) {
      if (receipt.action !== 'submitMealSelection' || receipt.spaceId !== space._id || receipt.actorId !== openid || receipt.requestHash !== requestHash) fail('REQUEST_CONFLICT', '这次提交的内容已改变，请重新提交')
      return owned('meals', receipt.mealId, space._id, tx)
    }
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace) fail('NO_SPACE', '厨房不存在')
    if (preferredMealId && currentSpace.currentMealId && preferredMealId !== currentSpace.currentMealId) fail('NOT_CURRENT_MEAL', '请先处理当前饭单')
    const targetId = preferredMealId || currentSpace.currentMealId
    const meal = targetId ? await owned('meals', targetId, space._id, tx) : null
    if (meal && ['completed', 'cancelled'].includes(meal.status)) fail('INVALID_STATE', '这份饭单已经结束')
    if (meal && meal.date !== today()) fail('MEAL_DATE_CONFLICT', '当前饭单不是今天的，请先处理后再选菜')
    const incoming = []
    for (const entry of entries) {
      const recipe = await owned('recipes', entry.recipeId, space._id, tx)
      const wish = entry.wishId ? await owned('wishes', entry.wishId, space._id, tx) : null
      if (wish && wish.recipeId !== recipe._id) fail('INVALID_STATE', '所选心愿已变化，请刷新心愿单')
      const wishId = wish && wish.status === 'open' ? wish._id : ''
      if (wish && !wishId && !(wish.status === 'completed' && recipe.available !== false)) fail('INVALID_STATE', '所选心愿已变化，请刷新心愿单')
      if (recipe.archivedAt || recipe.available === false && !wishId) fail('INVALID_STATE', '所选菜品已不可点，请刷新菜单')
      incoming.push({ ...entry, wishId, name: recipe.name,
        category: resolvedRecipe(recipe, currentSpace).category, categoryId: recipe.categoryId || '' })
    }
    const items = meal ? meal.items.map(item => ({ ...item })) : []
    const existing = new Map()
    for (const item of items) {
      let key = item.recipeId
      if (!key && item.wishId) {
        const oldWish = await owned('wishes', item.wishId, space._id, tx)
        key = oldWish.recipeId || ''
      }
      if (key) existing.set(key, item)
    }
    let changed = !meal
    for (const entry of incoming) {
      const old = existing.get(entry.recipeId)
      if (old) {
        if (entry.wishId && !old.wishId) { old.wishId = entry.wishId; changed = true }
        if (!old.recipeId) { old.recipeId = entry.recipeId; changed = true }
      } else {
        const item = { id: id(), ...entry, state: 'planned' }
        items.push(item)
        existing.set(entry.recipeId, item)
        changed = true
      }
    }
    if (items.length > 20) fail('INVALID_INPUT', '饭单最多 20 道菜')
    if (meal && meal.status === 'confirmed' && changed && !p.allowReconfirm) fail('RECONFIRM_REQUIRED', '饭单已确认，添加后需要重新确认')
    const stamp = now()
    let result
    if (meal && changed) {
      const next = { items, status: 'draft', version: meal.version + 1, updatedAt: stamp, updatedBy: openid }
      await tx.collection('meals').doc(meal._id).update({ data: next })
      result = { ...meal, ...next }
    } else if (meal) result = meal
    else {
      if (preferredMealId) fail('NOT_FOUND', '饭单不存在')
      const mealId = id()
      result = { _id: mealId, spaceId: space._id, title: '一起开饭', date: today(), diners: 2, note: '',
        items, status: 'draft', version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid }
      await tx.collection('meals').add({ data: result })
    }
    if (!currentSpace.currentMealId) await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: result._id, updatedAt: stamp } })
    await tx.collection('activity_logs').add({ data: {
      _id: receiptId, spaceId: space._id, actorId: openid, actorName: member.displayName,
      action: 'submitMealSelection', targetType: 'Meal', targetId: result._id, mealId: result._id,
      requestHash, summary: `加入饭单：${incoming.map(item => item.name).join('、')}`, changedFields: changed ? ['items'] : [], createdAt: stamp
    } })
    return result
  }, 5) } catch (error) {
    if (error instanceof AppError) throw error
    const receipt = await read(db.collection('activity_logs').doc(receiptId))
    if (!receipt) throw error
    if (receipt.action !== 'submitMealSelection' || receipt.spaceId !== space._id || receipt.actorId !== openid || receipt.requestHash !== requestHash) fail('REQUEST_CONFLICT', '这次提交的内容已改变，请重新提交')
    return owned('meals', receipt.mealId, space._id)
  }
}

async function removeMealItem(openid, p) {
  const { space, member } = await membership(openid)
  const mealId = docId(p.mealId, '饭单ID')
  const itemId = docId(p.itemId, '项目ID')
  docId(p.requestId, '请求ID')
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (currentSpace.currentMealId && currentSpace.currentMealId !== mealId) fail('NOT_CURRENT_MEAL', '请先处理当前饭单')
    const meal = await owned('meals', mealId, space._id, tx)
    if (['completed', 'cancelled'].includes(meal.status)) fail('INVALID_STATE', '这份饭单已经结束')
    const item = meal.items.find(entry => entry.id === itemId)
    if (!item) return meal
    const next = { items: meal.items.filter(entry => entry.id !== itemId), status: 'draft', version: meal.version + 1, updatedAt: stamp, updatedBy: openid }
    await tx.collection('meals').doc(mealId).update({ data: next })
    if (!currentSpace.currentMealId) await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: mealId, updatedAt: stamp } })
    return { ...meal, ...next }
  }, 5)
}

async function reopenMeal(openid, p) {
  const { space, member } = await membership(openid)
  const mealId = docId(p.id || p.mealId, '饭单ID')
  const expected = version(p.version)
  const stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const meal = await owned('meals', mealId, space._id, tx)
    if (meal.version !== expected) fail('VERSION_CONFLICT', '饭单已被更新，请刷新后重试')
    if (!['completed', 'cancelled'].includes(meal.status)) fail('INVALID_STATE', '只有已完成或已取消的饭单可以重新打开')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (currentSpace.currentMealId && currentSpace.currentMealId !== mealId) fail('CURRENT_MEAL_EXISTS', '请先处理当前饭单再重新打开')
    const next = { status: meal.status === 'completed' ? 'confirmed' : 'draft', version: meal.version + 1, updatedAt: stamp, updatedBy: openid }
    await tx.collection('meals').doc(mealId).update({ data: next })
    if (!currentSpace.currentMealId) await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: mealId, updatedAt: stamp } })
    return { ...meal, ...next }
  }, 5)
}

async function adjustCookCount(tx, spaceId, recipeId, delta) {
  if (!recipeId) return
  const recipe = await owned('recipes', recipeId, spaceId, tx)
  let count = recipe.cookCount
  if (!Number.isSafeInteger(count) || count < 0 || delta < 0 && count === 0) {
    count = 0
    // ponytail: older recipes need one-time backfill; if a kitchen has thousands of records, use an aggregate migration.
    for (let offset = 0; ; offset += 100) {
      const page = await tx.collection('cooking_records').where({ spaceId, recipeId }).skip(offset).limit(100).get()
      count += page.data.filter(record => !record.deletedAt).length
      if (page.data.length < 100) break
    }
  }
  if (count + delta < 0) fail('INVALID_STATE', '制作次数需要重新统计')
  if (delta || !Number.isSafeInteger(recipe.cookCount) || recipe.cookCount < 0) {
    await tx.collection('recipes').doc(recipeId).update({ data: { cookCount: count + delta } })
  }
  return count + delta
}

async function saveRecord(openid, p) {
  const { space, member } = await membership(openid)
  const itemId = p._id || p.id ? docId(p._id || p.id) : ''
  const requestId = !itemId && p.requestId ? docId(p.requestId, '请求ID') : ''
  const recordId = itemId || (requestId ? hash(`saveRecord:${space._id}:${openid}:${requestId}`) : id())
  if (p.addToMenu != null && typeof p.addToMenu !== 'boolean') fail('INVALID_INPUT', '加入菜单选项格式错误')
  const stamp = now()
  try { return await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = itemId ? await owned('cooking_records', itemId, space._id, tx) : null
    if (requestId) {
      const saved = await read(tx.collection('cooking_records').doc(recordId))
      if (saved && saved.deletedAt) fail('NOT_FOUND', '这条记录已删除')
      if (saved && saved.spaceId === space._id && saved.createdBy === openid) return saved
    }
    if (old && old.version !== version(p.version)) fail('VERSION_CONFLICT', '内容已被更新，请刷新后重试')
    let recipeId = p.recipeId ? docId(p.recipeId, '菜品ID') : ''
    const wishId = p.wishId ? docId(p.wishId, '心愿ID') : ''
    const mealId = p.mealId ? docId(p.mealId, '饭单ID') : ''
    const recipe = recipeId ? await owned('recipes', recipeId, space._id, tx) : null
    const wish = wishId ? await owned('wishes', wishId, space._id, tx) : null
    if (wish && wish.recipeId && recipeId !== wish.recipeId) fail('INVALID_INPUT', '该心愿已关联菜品，请重新选择来源')
    if (p.newRecipe && (recipeId || wishId)) fail('INVALID_INPUT', '请选择已有菜品或填写新菜')
    if (!recipeId && !wishId && !p.newRecipe && !(old && !old.recipeId && !old.wishId && old.name)) fail('INVALID_INPUT', '请填写这次制作的菜品信息')
    if (p.addToMenu && (!p.newRecipe || old)) fail('INVALID_INPUT', '仅首次记录新菜时可同时加入菜单')
    let dishSnapshot = old && old.recipeId === recipeId && old.wishId === wishId ? old.dishSnapshot || null : null
    if (p.newRecipe) {
      const currentSpace = await read(tx.collection('spaces').doc(space._id))
      const fields = recipeFields(obj(p.newRecipe), dishSnapshot && { ...dishSnapshot, available: true }, currentSpace)
      const { name, category, tags, categoryId, tagIds, description, ingredients, steps, externalUrl } = fields
      dishSnapshot = { name, category, tags, description, ingredients, steps, externalUrl,
        ...(categoryId !== undefined ? { categoryId } : {}), ...(tagIds !== undefined ? { tagIds } : {}) }
      if (p.addToMenu) {
        recipeId = hash(`saveRecordRecipe:${recordId}`)
        await checkFiles(space._id, [fields.coverFileId, ...fields.photoFileIds], tx, [])
        await tx.collection('recipes').add({ data: { _id: recipeId, spaceId: space._id, ...fields,
          version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid } })
      }
    }
    if (!old || old.recipeId !== recipeId || old.wishId !== wishId || old.mealId !== mealId) {
      if (mealId) {
        const meal = await owned('meals', mealId, space._id, tx)
        if (!(recipeId || wishId) || !meal.items.some(item => item.state === 'cooked' && (wishId ? item.wishId === wishId : item.recipeId === recipeId))) fail('INVALID_INPUT', '这道菜尚未在该饭单标记为已做')
      }
      if (recipeId && wishId) {
        const linkedWish = await owned('wishes', wishId, space._id, tx)
        if (linkedWish.recipeId !== recipeId) fail('INVALID_INPUT', '心愿未关联这道菜')
      }
    }
    const photos = fileIds(p.photoFileIds, 12)
    await checkFiles(space._id, photos, tx, old ? old.photoFileIds || [] : [])
    if (old && old.recipeId !== recipeId) await adjustCookCount(tx, space._id, old.recipeId, -1)
    if (!old || old.recipeId !== recipeId) await adjustCookCount(tx, space._id, recipeId, 1)
    const fields = {
      recipeId, wishId, mealId, dishSnapshot,
      name: dishSnapshot ? dishSnapshot.name : old && old.recipeId === recipeId && old.wishId === wishId ? old.name : recipe ? recipe.name : wish.title,
      makerName: old ? old.makerName || member.displayName : member.displayName,
      date: date(p.date || (old && old.date) || today()),
      note: str(p.note, '心得', 4000), photoFileIds: photos,
      version: old ? old.version + 1 : 1, updatedAt: stamp, updatedBy: openid
    }
    if (old) {
      await tx.collection('cooking_records').doc(recordId).update({ data: fields })
      return { ...old, ...fields }
    }
    const record = { _id: recordId, spaceId: space._id, ...fields, createdAt: stamp, createdBy: openid }
    await tx.collection('cooking_records').add({ data: record })
    return record
  }, 5) } catch (error) {
    if (error instanceof AppError || !requestId) throw error
    await activeMember(db, space._id, openid)
    const saved = await read(db.collection('cooking_records').doc(recordId))
    if (!saved || saved.deletedAt || saved.spaceId !== space._id || saved.createdBy !== openid) throw error
    return saved
  }
}

async function addMealItemPhoto(openid, p) {
  const { space, member } = await membership(openid)
  const mealId = docId(p.mealId, '饭单ID')
  const itemId = docId(p.itemId, '项目ID')
  const photoFileId = fileIds([p.fileId], 1)[0]
  if (!photoFileId) fail('INVALID_INPUT', '请选择照片')
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const meal = await owned('meals', mealId, space._id, tx)
    const item = meal.items.find(entry => entry.id === itemId)
    if (meal.status !== 'completed' || !item || item.state !== 'cooked') fail('INVALID_STATE', '只有已完成饭单中的已做菜品可以补照片')
    let record = item.recordId ? await owned('cooking_records', item.recordId, space._id, tx) : null
    if (!record && (item.recipeId || item.wishId)) {
      const filter = { spaceId: space._id, mealId, ...(item.recipeId ? { recipeId: item.recipeId } : { wishId: item.wishId }) }
      const matches = await tx.collection('cooking_records').where(filter).limit(20).get()
      const available = matches.data.filter(entry => !entry.deletedAt)
      record = available.find(entry => entry.mealItemId === itemId) || available.find(entry =>
        item.wishId ? entry.wishId === item.wishId : !entry.wishId) || null
    }
    if (record && (record.mealId !== mealId || record.wishId !== item.wishId || item.recipeId && record.recipeId !== item.recipeId)) fail('INVALID_STATE', '制作记录与饭单菜品不匹配')
    const photos = record ? record.photoFileIds || [] : []
    if (!photos.includes(photoFileId) && photos.length >= 12) fail('INVALID_INPUT', '最多 12 张照片')
    await checkFiles(space._id, [photoFileId], tx, photos)
    const stamp = now()
    const nextPhotos = photos.includes(photoFileId) ? photos : [...photos, photoFileId]
    if (record) {
      if (nextPhotos.length !== photos.length) {
        await tx.collection('cooking_records').doc(record._id).update({ data: {
          photoFileIds: nextPhotos, mealItemId: itemId, version: record.version + 1, updatedAt: stamp, updatedBy: openid
        } })
        record = { ...record, photoFileIds: nextPhotos, mealItemId: itemId, version: record.version + 1 }
      }
    } else {
      record = { _id: id(), spaceId: space._id, recipeId: item.recipeId, wishId: item.wishId, mealId,
        mealItemId: itemId, name: item.name, makerName: member.displayName, date: meal.date, note: '',
        photoFileIds: nextPhotos, version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid }
      await tx.collection('cooking_records').add({ data: record })
      await adjustCookCount(tx, space._id, item.recipeId, 1)
    }
    if (item.recordId !== record._id) {
      const items = meal.items.map(entry => entry.id === itemId ? { ...entry, recordId: record._id } : entry)
      await tx.collection('meals').doc(mealId).update({ data: { items, version: meal.version + 1, updatedAt: stamp, updatedBy: openid } })
    }
    return { record, mealId, itemId, mealVersion: meal.version + (item.recordId !== record._id ? 1 : 0) }
  }, 5)
}

async function deleteRecord(openid, p) {
  const { space } = await membership(openid)
  if (!['record', 'meal'].includes(p.kind)) fail('INVALID_INPUT', '记录类型无效')
  const itemId = docId(p.id, '记录ID'), expected = version(p.version)
  const collection = p.kind === 'meal' ? 'meals' : 'cooking_records', stamp = now()
  return db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const item = await read(tx.collection(collection).doc(itemId))
    if (!item || item.spaceId !== space._id) fail('NOT_FOUND', '记录不存在')
    if (item.deletedAt) return { id: itemId, kind: p.kind, replayed: true }
    const currentVersion = item.version == null ? 1 : item.version
    if (currentVersion !== expected) fail('VERSION_CONFLICT', '伙伴刚修改了这条记录，请刷新核对后再删除')
    if (p.kind === 'meal') {
      const current = await read(tx.collection('spaces').doc(space._id))
      if (current.currentMealId === itemId) await tx.collection('spaces').doc(space._id).update({ data: { currentMealId: '', updatedAt: stamp } })
    } else {
      if (item.recipeId) {
        const recipe = await read(tx.collection('recipes').doc(item.recipeId))
        if (recipe && recipe.spaceId === space._id) await adjustCookCount(tx, space._id, item.recipeId, -1)
      }
      if (item.mealId) {
        const meal = await read(tx.collection('meals').doc(item.mealId))
        if (meal && meal.spaceId === space._id && (meal.items || []).some(dish => dish.recordId === itemId)) {
          const unlink = dish => dish.recordId === itemId ? { ...dish, recordId: '' } : dish
          await tx.collection('meals').doc(item.mealId).update({ data: {
            items: meal.items.map(unlink), version: (meal.version || 1) + 1, updatedAt: stamp, updatedBy: openid,
            ...(meal.menuSnapshot ? { menuSnapshot: { ...meal.menuSnapshot, groups: (meal.menuSnapshot.groups || []).map(group => ({ ...group, items: group.items.map(unlink) })) } } : {})
          } })
        }
      }
    }
    // Keep photos and other records intact; the marker also makes retries idempotent.
    await tx.collection(collection).doc(itemId).update({ data: { deletedAt: stamp, version: currentVersion + 1, updatedAt: stamp, updatedBy: openid } })
    return { id: itemId, kind: p.kind }
  }, 5)
}

async function beginMediaUpload(openid, p) {
  const { space } = await membership(openid)
  const requestId = docId(p.requestId, '请求ID')
  if (!Number.isSafeInteger(p.size) || p.size < 4 || p.size > MAX_IMAGE_BYTES || typeof p.md5 !== 'string' || !/^[a-fA-F0-9]{32}$/.test(p.md5)) fail('INVALID_MEDIA', '照片信息无效，请重新选择')
  const md5 = p.md5.toLowerCase(), receiptId = hash(`uploadMedia:${space._id}:${openid}:${requestId}`)
  // One writable staging object per member; permanent photos never receive client PUT credentials.
  const stagingPath = `staging/${space._id}/${hash(openid)}.image`
  const receipt = await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const ref = tx.collection('media_assets').doc(receiptId), old = await read(ref)
    if (old) {
      if (old.kind !== 'uploadReceipt' || old.spaceId !== space._id || old.uploadedBy !== openid ||
        old.stagingMd5 && (old.stagingMd5 !== md5 || old.stagingSize !== p.size)) fail('REQUEST_CONFLICT', '这次上传的照片已改变，请重新选择')
      if (old.status === 'discarded') fail('MEDIA_DISCARDED', '这张照片已经移除，请重新选择')
      if (old.status === 'active') { await checkFiles(space._id, [old.fileId], tx); return old }
      if (!old.stagingMd5) fail('REQUEST_CONFLICT', '旧照片上传尚未完成，请重新选择照片')
      return old
    }
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace || (currentSpace.mediaBytes || 0) + p.size > MAX_MEDIA_BYTES) fail('MEDIA_LIMIT', '照片空间已满，请先备份并整理照片')
    const row = { _id: receiptId, kind: 'uploadReceipt', spaceId: space._id, uploadedBy: openid,
      status: 'staging', stagingPath, stagingSize: p.size, stagingMd5: md5, reservedBytes: p.size, createdAt: now() }
    await tx.collection('media_assets').add({ data: row })
    await tx.collection('spaces').doc(space._id).update({ data: { mediaBytes: (currentSpace.mediaBytes || 0) + p.size } })
    return row
  }, 5)
  if (receipt.status === 'active') return { fileId: receipt.fileId }
  let metadata
  try { metadata = (await storage.getUploadMetadata({ cloudPath: stagingPath })).data }
  catch (_) { fail('UPLOAD_FAILED', '暂时无法开始上传，照片已保留，请重试') }
  if (!metadata || !/^https:\/\//.test(metadata.url || '') || !metadata.authorization || !metadata.token || !metadata.cosFileId || !String(metadata.fileId || '').startsWith('cloud://')) fail('UPLOAD_FAILED', '暂时无法开始上传，照片已保留，请重试')
  await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const ref = tx.collection('media_assets').doc(receiptId), current = await read(ref)
    if (!current || current.status === 'discarded') fail('MEDIA_DISCARDED', '这张照片已经移除，请重新选择')
    await ref.update({ data: { stagingFileId: metadata.fileId } })
  }, 5)
  return { url: metadata.url, headers: { Signature: metadata.authorization, authorization: metadata.authorization,
    'x-cos-security-token': metadata.token, 'x-cos-meta-fileid': metadata.cosFileId, key: encodeURIComponent(stagingPath) } }
}

function readStagedPhoto(url, size) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false
    const finish = (error, buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) { if (response) response.destroy(); if (request) request.destroy(); reject(error) }
      else resolve(buffer)
    }
    const timer = setTimeout(() => finish(new AppError('UPLOAD_FAILED', '照片校验超时，输入已保留，请重试')), 15000)
    try {
      request = https.get(url, result => {
        response = result
        if (result.statusCode < 200 || result.statusCode >= 300) return finish(new AppError('UPLOAD_FAILED', '照片尚未上传完整，请重试'))
        const declared = Number(result.headers['content-length'])
        if (Number.isFinite(declared) && declared !== size) return finish(new AppError('INVALID_MEDIA', '照片大小与选择时不一致，请重新上传'))
        let received = 0
        const chunks = []
        result.on('data', chunk => {
          received += chunk.length
          if (received > size || received > MAX_IMAGE_BYTES) return finish(new AppError('INVALID_MEDIA', '照片大小与选择时不一致，请重新上传'))
          chunks.push(chunk)
        })
        result.on('end', () => received === size ? finish(null, Buffer.concat(chunks)) : finish(new AppError('UPLOAD_FAILED', '照片尚未上传完整，请重试')))
        result.on('error', () => finish(new AppError('UPLOAD_FAILED', '照片读取失败，输入已保留，请重试')))
        result.on('aborted', () => finish(new AppError('UPLOAD_FAILED', '照片读取中断，输入已保留，请重试')))
      })
      request.on('error', () => finish(new AppError('UPLOAD_FAILED', '照片读取失败，输入已保留，请重试')))
    } catch (_) { finish(new AppError('UPLOAD_FAILED', '照片读取失败，输入已保留，请重试')) }
  })
}

async function finishMediaUpload(openid, p) {
  const { space } = await membership(openid)
  const requestId = docId(p.requestId, '请求ID'), receiptId = hash(`uploadMedia:${space._id}:${openid}:${requestId}`)
  const receipt = await read(db.collection('media_assets').doc(receiptId))
  if (!receipt || receipt.kind !== 'uploadReceipt' || receipt.spaceId !== space._id || receipt.uploadedBy !== openid) fail('NOT_FOUND', '照片上传已失效，请重新上传')
  if (receipt.status === 'discarded') fail('MEDIA_DISCARDED', '这张照片已经移除，请重新选择')
  if (receipt.status === 'active') { await checkFiles(space._id, [receipt.fileId]); return { fileId: receipt.fileId } }
  if (!receipt.stagingFileId || !receipt.stagingMd5) fail('UPLOAD_FAILED', '照片尚未上传完整，请重试')
  let signed
  try { signed = await storage.getTempFileURL({ fileList: [{ fileID: receipt.stagingFileId, maxAge: 60, urlType: 'COS_URL' }] }) }
  catch (_) { fail('UPLOAD_FAILED', '照片读取失败，输入已保留，请重试') }
  const file = signed.fileList && signed.fileList.find(item => item.fileID === receipt.stagingFileId)
  if (!file || file.code !== 'SUCCESS' || !/^https:\/\//.test(file.tempFileURL || '')) fail('UPLOAD_FAILED', '照片尚未上传完整，请重试')
  const buffer = await readStagedPhoto(file.tempFileURL, receipt.stagingSize)
  if (crypto.createHash('md5').update(buffer).digest('hex') !== receipt.stagingMd5) fail('INVALID_MEDIA', '照片已变化，输入已保留，请重新上传')
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (!jpeg && !png) fail('INVALID_MEDIA', '照片格式错误，请使用 JPG 或 PNG')
  // Staging is intentionally retained: deleting it could delete the member's next upload.
  return uploadMediaOnce(openid, space, buffer, jpeg ? 'jpg' : 'png', requestId)
}

async function uploadMediaChunks(openid, space, p) {
  const requestId = docId(p.requestId, '请求ID'), index = p.chunkIndex, count = p.chunkCount
  const transportVersion = p.transportVersion == null ? 1 : p.transportVersion
  if (![1, 3].includes(transportVersion)) fail('INVALID_INPUT', '照片传输版本无效')
  const chunkSize = transportVersion === 3 ? 32768 : 500000
  const maxEncoded = transportVersion === 3 ? 245760 : 1400000
  if (!Number.isSafeInteger(count) || count < 1 || count > (transportVersion === 3 ? 8 : 3) || !Number.isSafeInteger(index) || index < 0 || index >= count) fail('INVALID_INPUT', '照片分段信息无效')
  const slotId = hash(`mediaTransport:${space._id}:${openid}`)
  const markStatus = status => db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const ref = tx.collection('media_assets').doc(slotId), slot = await read(ref)
    if (slot && slot.kind === 'uploadTransport' && slot.requestId === requestId && (slot.transportVersion || 1) === transportVersion && !(status === 'failed' && slot.status === 'completed')) {
      await ref.update({ data: { status, updatedAt: now() } })
    }
  }, 5)
  try {
    const last = index === count - 1
    if (typeof p.base64 !== 'string' || !p.base64.length || p.base64.length > chunkSize || p.base64.length % 4 || (!last && p.base64.length !== chunkSize) || index * chunkSize + p.base64.length > maxEncoded || !(last ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(p.base64)) fail('INVALID_MEDIA', '照片分段格式错误或过大')
    const digest = hash(p.base64)
    const slot = await db.runTransaction(async tx => {
      await activeMember(tx, space._id, openid)
      const ref = tx.collection('media_assets').doc(slotId), old = await read(ref)
      if (old && (old.kind !== 'uploadTransport' || old.spaceId !== space._id || old.uploadedBy !== openid)) fail('INVALID_STATE', '照片传输状态无效')
      let current = old
      if (!old || old.requestId !== requestId || (old.transportVersion || 1) !== transportVersion) {
        if (index !== 0) fail('INVALID_STATE', '请从第一段重新上传照片')
        if (old && old.status === 'pending' && Date.now() - Date.parse(old.updatedAt) < 60000) fail('MEDIA_BUSY', '上一张照片正在上传，请稍后重试')
        current = { kind: 'uploadTransport', spaceId: space._id, uploadedBy: openid, requestId, transportVersion, chunkCount: count, chunks: [], hashes: [], status: 'pending', createdAt: now() }
      }
      if (current.chunkCount !== count) fail('REQUEST_CONFLICT', '这次上传的照片已改变，请重新选择')
      if (index < current.hashes.length) {
        if (current.hashes[index] !== digest) fail('REQUEST_CONFLICT', '这次上传的照片已改变，请重新选择')
        return current
      }
      if (index !== current.hashes.length) fail('INVALID_STATE', '照片分段尚未传齐，请按顺序重试')
      const fields = { requestId, transportVersion, chunkCount: count, hashes: [...current.hashes, digest], chunks: last ? current.chunks : [...current.chunks, p.base64], status: 'pending', updatedAt: now() }
      if (old) await ref.update({ data: fields })
      else await tx.collection('media_assets').add({ data: { _id: slotId, ...current, ...fields } })
      return { ...current, ...fields }
    }, 5)
    if (!last) return { pending: true }
    const encoded = slot.chunks.join('') + p.base64
    if (encoded.length > maxEncoded) fail('INVALID_MEDIA', '照片分段总大小超限')
    const buffer = Buffer.from(encoded, 'base64')
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || (!jpeg && !png)) fail('INVALID_MEDIA', '照片格式错误或超过 1 MB')
    const result = await uploadMediaOnce(openid, space, buffer, jpeg ? 'jpg' : 'png', requestId)
    await markStatus('completed')
    return result
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_MEDIA') await markStatus('failed').catch(() => {})
    throw error
  }
}

async function uploadMedia(openid, p) {
  const { space } = await membership(openid)
  if (has(p, 'chunkIndex') || has(p, 'chunkCount')) return uploadMediaChunks(openid, space, p)
  if (typeof p.base64 !== 'string' || p.base64.length > 1400000) fail('INVALID_MEDIA', '照片不能超过 1 MB')
  const encoded = p.base64.replace(/^data:image\/(jpeg|png);base64,/, '')
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('INVALID_MEDIA', '照片格式错误，请使用 JPG 或 PNG')
  const buffer = Buffer.from(encoded, 'base64')
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  const png = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || (!jpeg && !png)) fail('INVALID_MEDIA', '照片格式错误或超过 1 MB')
  if (has(p, 'requestId')) return uploadMediaOnce(openid, space, buffer, jpeg ? 'jpg' : 'png', docId(p.requestId, '请求ID'))
  if ((space.mediaBytes || 0) + buffer.length > MAX_MEDIA_BYTES) fail('MEDIA_LIMIT', '照片空间已满，请先备份并整理照片')
  const cloudPath = `private/${space._id}/${id()}.${jpeg ? 'jpg' : 'png'}`
  const uploaded = await cloud.uploadFile({ cloudPath, fileContent: buffer })
  const fileId = uploaded.fileID
  if (!fileId) fail('UPLOAD_FAILED', '照片上传失败')
  try {
    await db.runTransaction(async tx => {
      await activeMember(tx, space._id, openid)
      const currentSpace = await read(tx.collection('spaces').doc(space._id))
      if (!currentSpace || (currentSpace.mediaBytes || 0) + buffer.length > MAX_MEDIA_BYTES) fail('MEDIA_LIMIT', '照片空间已满，请先备份并整理照片')
      await tx.collection('media_assets').add({ data: { _id: hash(fileId), fileId, spaceId: space._id, uploadedBy: openid, size: buffer.length, status: 'active', createdAt: now() } })
      await tx.collection('spaces').doc(space._id).update({ data: { mediaBytes: (currentSpace.mediaBytes || 0) + buffer.length } })
    })
  } catch (error) {
    await cloud.deleteFile({ fileList: [fileId] }).catch(() => {})
    throw error
  }
  return { fileId }
}

async function uploadMediaOnce(openid, space, buffer, extension, requestId) {
  const receiptId = hash(`uploadMedia:${space._id}:${openid}:${requestId}`)
  const contentHash = hash(buffer)
  const token = id()
  const receipt = await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const old = await read(tx.collection('media_assets').doc(receiptId))
    if (old) {
      if (old.kind !== 'uploadReceipt' || old.spaceId !== space._id || old.uploadedBy !== openid ||
        (old.contentHash ? old.contentHash !== contentHash : old.status !== 'staging' || old.stagingSize !== buffer.length || old.stagingMd5 !== crypto.createHash('md5').update(buffer).digest('hex'))) fail('REQUEST_CONFLICT', '这次上传的照片已改变，请重新选择')
      if (old.status === 'discarded') fail('MEDIA_DISCARDED', '这张照片已经移除，请重新选择')
      if (old.status === 'active') {
        await checkFiles(space._id, [old.fileId], tx)
        return old
      }
      if (old.status === 'uploading' && Date.now() - Date.parse(old.uploadingAt) < 60000) fail('MEDIA_BUSY', '这张照片正在上传，请稍后重试')
    }
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    const reserved = old && old.reservedBytes || 0
    if (reserved !== 0 && reserved !== buffer.length) fail('INVALID_MEDIA', '照片空间预留无效')
    const additional = buffer.length - reserved
    if (!currentSpace || (currentSpace.mediaBytes || 0) + additional > MAX_MEDIA_BYTES) fail('MEDIA_LIMIT', '照片空间已满，请先备份并整理照片')
    const fields = { status: 'uploading', contentHash, uploadToken: token, uploadingAt: now(), reservedBytes: buffer.length }
    if (old) await tx.collection('media_assets').doc(receiptId).update({ data: fields })
    else await tx.collection('media_assets').add({ data: { _id: receiptId, kind: 'uploadReceipt', spaceId: space._id,
      uploadedBy: openid, contentHash, createdAt: now(), ...fields } })
    if (additional) await tx.collection('spaces').doc(space._id).update({ data: { mediaBytes: (currentSpace.mediaBytes || 0) + additional } })
    return { ...old, ...fields }
  }, 5)
  if (receipt.status === 'active') return { fileId: receipt.fileId }
  let fileId = receipt.fileId || ''
  try {
    if (!fileId) {
      // A lost storage response may retry this path, but cannot create a second file.
      const uploaded = await cloud.uploadFile({ cloudPath: `private/${space._id}/${receiptId}.${extension}`, fileContent: buffer })
      fileId = uploaded.fileID || ''
      if (!fileId) fail('UPLOAD_FAILED', '照片上传失败，请重试')
    }
    await db.runTransaction(async tx => {
      await activeMember(tx, space._id, openid)
      const current = await read(tx.collection('media_assets').doc(receiptId))
      if (!current || current.status !== 'uploading' || current.uploadToken !== token) fail('MEDIA_BUSY', '照片上传状态已变化，请重试')
      if (current.reservedBytes !== buffer.length) fail('INVALID_MEDIA', '照片空间预留已变化，请重试')
      await tx.collection('media_assets').add({ data: { _id: hash(fileId), fileId, uploadReceiptId: receiptId,
        spaceId: space._id, uploadedBy: openid, size: buffer.length, status: 'active', createdAt: now() } })
      await tx.collection('media_assets').doc(receiptId).update({ data: { status: 'active', fileId, uploadToken: '', reservedBytes: 0 } })
    }, 5)
  } catch (error) {
    // Keep a known uploaded file for retry; never delete on an uncertain transaction result.
    const recovered = await db.runTransaction(async tx => {
      await activeMember(tx, space._id, openid)
      const current = await read(tx.collection('media_assets').doc(receiptId))
      if (current && current.status === 'active') {
        await checkFiles(space._id, [current.fileId], tx)
        return current.fileId
      }
      if (current && current.status === 'uploading' && current.uploadToken === token) {
        await tx.collection('media_assets').doc(receiptId).update({ data: { status: 'retryable', fileId, uploadToken: '' } })
      }
      return ''
    }, 5).catch(() => '')
    if (recovered) return { fileId: recovered }
    throw error
  }
  return { fileId }
}

async function restoreMedia(assetId, token) {
  await db.runTransaction(async tx => {
    const asset = await read(tx.collection('media_assets').doc(assetId))
    if (asset && asset.status === 'deleting' && asset.deleteToken === token) {
      await tx.collection('media_assets').doc(assetId).update({ data: { status: 'active', deleteToken: '', deletingAt: null } })
    }
  })
}

async function discardMedia(openid, p) {
  const { space, member } = await membership(openid)
  const fileId = fileIds([p.fileId], 1)[0]
  const assetId = hash(fileId)
  const token = id()
  const asset = await db.runTransaction(async tx => {
    await activeMember(tx, space._id, openid)
    const current = await read(tx.collection('media_assets').doc(assetId))
    if (!current || current.fileId !== fileId || current.spaceId !== space._id) fail('INVALID_MEDIA', '照片不属于当前厨房')
    if (!Number.isSafeInteger(current.size) || current.size < 1) fail('INVALID_MEDIA', '照片记录无效')
    if (current.retainedForMealDish) fail('MEDIA_IN_USE', '照片用于本餐菜品记录，当前仅移除引用，不回收文件')
    if (current.status === 'deleting' && Date.now() - Date.parse(current.deletingAt) < 60000) fail('MEDIA_BUSY', '照片正在回收，请稍后重试')
    if (current.status && !['active', 'deleting'].includes(current.status)) fail('INVALID_MEDIA', '照片状态无效')
    await tx.collection('media_assets').doc(assetId).update({ data: { status: 'deleting', deleteToken: token, deletingAt: now() } })
    return current
  })

  let references
  try {
    const contains = db.command.all([fileId])
    references = await Promise.all([
      db.collection('recipes').where({ spaceId: space._id, coverFileId: fileId }).limit(1).get(),
      db.collection('recipes').where({ spaceId: space._id, photoFileIds: contains }).limit(1).get(),
      db.collection('cooking_records').where({ spaceId: space._id, photoFileIds: contains }).limit(1).get(),
      db.collection('meals').where({ spaceId: space._id, photoFileIds: contains }).limit(1).get()
    ])
  } catch (error) {
    await restoreMedia(assetId, token)
    throw error
  }
  if (references.some(result => result.data.length)) {
    await restoreMedia(assetId, token)
    fail('MEDIA_IN_USE', '照片仍被厨房内容使用')
  }

  let deleted
  try {
    deleted = await cloud.deleteFile({ fileList: [fileId] })
  } catch (error) {
    if ((error.errCode || error.code) !== -503003) throw error
    deleted = { fileList: [{ fileID: fileId, status: -503003 }] }
  }
  const result = ((deleted && deleted.fileList) || []).find(item => item.fileID === fileId)
  if (!result || ![0, -503003].includes(result.status)) fail('DELETE_FAILED', '照片回收失败，请稍后重试')

  await db.runTransaction(async tx => {
    const current = await read(tx.collection('media_assets').doc(assetId))
    if (!current || current.status !== 'deleting' || current.deleteToken !== token) fail('MEDIA_BUSY', '照片回收状态已变化，请稍后重试')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    if (!currentSpace) fail('NO_SPACE', '厨房不存在')
    if (current.uploadReceiptId) {
      const receipt = await read(tx.collection('media_assets').doc(current.uploadReceiptId))
      if (receipt && receipt.spaceId === space._id && receipt.fileId === fileId) {
        await tx.collection('media_assets').doc(current.uploadReceiptId).update({ data: { status: 'discarded', uploadToken: '' } })
      }
    }
    await tx.collection('media_assets').doc(assetId).remove()
    await tx.collection('spaces').doc(space._id).update({ data: { mediaBytes: Math.max(0, (currentSpace.mediaBytes || 0) - asset.size), updatedAt: now() } })
  })
  return { discarded: true, fileId }
}

async function mediaUrls(openid, p) {
  const { space } = await membership(openid)
  const files = fileIds(p.fileIds, 30)
  await checkFiles(space._id, files)
  if (!files.length) return { urls: {} }
  const result = await cloud.getTempFileURL({ fileList: files.map(fileID => ({ fileID, maxAge: 600 })) })
  return { urls: Object.fromEntries(result.fileList.filter(item => item.status === 0 && item.tempFileURL).map(item => [item.fileID, item.tempFileURL])) }
}

async function exportData(openid, p) {
  const { space } = await membership(openid)
  const collection = str(p.collection, '导出类型', 40, true)
  if (collection === 'catalog') return { schemaVersion: 2, items: [{ categories: space.categories || [], tags: space.tags || [], catalogVersion: space.catalogVersion || 0 }], hasMore: false, fileIds: [] }
  if (!['recipes', 'wishes', 'meals', 'cooking_records', 'activity_logs'].includes(collection)) fail('INVALID_INPUT', '不支持导出此类数据')
  const offset = p.offset == null ? 0 : p.offset
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_INPUT', '翻页参数错误')
  const sortKey = collection === 'activity_logs' ? 'createdAt' : 'updatedAt'
  const result = await db.collection(collection).where({ spaceId: space._id }).orderBy(sortKey, 'desc').skip(offset).limit(51).get()
  const items = result.data.slice(0, 50)
  const fileIds = [...new Set(items.flatMap(item => [item.coverFileId, ...(item.photoFileIds || [])]).filter(Boolean))]
  return { schemaVersion: 2, items, hasMore: result.data.length > 50, fileIds }
}

async function migrateLegacy(openid, p) {
  const { space, member } = await membership(openid)
  const kind = str(p.kind, '迁移类型', 40, true)
  if (!['recipes', 'wishes', 'cooking_records'].includes(kind)) fail('INVALID_INPUT', '迁移类型错误')
  const offset = p.offset == null ? 0 : p.offset
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || p.dryRun != null && typeof p.dryRun !== 'boolean') fail('INVALID_INPUT', '迁移参数错误')
  if (member.role !== 'owner') fail('FORBIDDEN', '只有厨房创建者可以执行迁移')
  const rows = (await db.collection(kind).where({ spaceId: space._id }).orderBy('_id', 'asc').skip(offset).limit(5).get()).data
  const candidates = rows.filter(row => kind === 'recipes' ? !has(row, 'categoryId') || !has(row, 'tagIds')
    : kind === 'wishes' ? !row.recipeId : !!row.wishId && !row.recipeId)
  if (p.dryRun !== false || !candidates.length) return { kind, dryRun: p.dryRun !== false, offset, nextOffset: offset + rows.length,
    inspected: rows.length, candidates: candidates.map(row => ({ id: row._id, name: row.name || row.title || '' })), changed: 0, hasMore: rows.length === 5 }
  const stamp = now()
  const changed = await db.runTransaction(async tx => {
    const member = await activeMember(tx, space._id, openid)
    if (member.role !== 'owner') fail('FORBIDDEN', '只有厨房创建者可以执行迁移')
    const currentSpace = await read(tx.collection('spaces').doc(space._id))
    const categories = [...(currentSpace.categories || [])]
    const tags = [...(currentSpace.tags || [])]
    let catalogChanged = false
    let count = 0
    for (const candidate of candidates) {
      const row = await owned(kind, candidate._id, space._id, tx)
      if (kind === 'recipes') {
        const patch = {}
        if (!has(row, 'categoryId')) {
          const name = row.category && row.category !== '未分类' ? str(row.category, '分类', 24) : ''
          let entry = name && (categories.find(item => !item.deletedAt && item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
            categories.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
          if (name && !entry) {
            if (categories.filter(item => !item.deletedAt).length >= 30) fail('INVALID_STATE', '分类数量已达上限，迁移前请整理分类')
            entry = { id: id(), name, deletedAt: '' }; categories.push(entry); catalogChanged = true
          }
          patch.categoryId = entry ? entry.id : ''
        }
        if (!has(row, 'tagIds')) {
          patch.tagIds = []
          for (const name of strings(row.tags, '标签', 8, 20)) {
            let entry = tags.find(item => !item.deletedAt && item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ||
              tags.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
            if (!entry) {
              if (tags.filter(item => !item.deletedAt).length >= 100) fail('INVALID_STATE', '标签数量已达上限，迁移前请整理标签')
              entry = { id: id(), name, deletedAt: '' }; tags.push(entry); catalogChanged = true
            }
            patch.tagIds.push(entry.id)
          }
        }
        if (!Object.keys(patch).length) continue
        await tx.collection('recipes').doc(row._id).update({ data: { ...patch, version: row.version + 1, updatedAt: stamp, updatedBy: openid } })
      } else if (kind === 'wishes') {
        if (row.recipeId) continue
        const recipeId = hash(`legacy-wish:${space._id}:${row._id}`)
        const existingRecipe = await read(tx.collection('recipes').doc(recipeId))
        if (existingRecipe && (existingRecipe.spaceId !== space._id || existingRecipe.wishId !== row._id)) fail('INVALID_STATE', '迁移菜品标识冲突')
        if (!existingRecipe) await tx.collection('recipes').add({ data: {
          _id: recipeId, spaceId: space._id, name: str(row.title, '心愿', 100, true).slice(0, 80),
          categoryId: '', tagIds: [], category: '', tags: [], description: '', externalUrl: '', ingredients: '', steps: '',
          coverFileId: '', photoFileIds: [], cookCount: 0, available: false, archivedAt: null, wishId: row._id,
          version: 1, createdAt: stamp, updatedAt: stamp, createdBy: openid, updatedBy: openid
        } })
        await tx.collection('wishes').doc(row._id).update({ data: { recipeId, version: row.version + 1, updatedAt: stamp, updatedBy: openid } })
      } else {
        if (!row.wishId || row.recipeId) continue
        const wish = await owned('wishes', row.wishId, space._id, tx)
        if (!wish.recipeId) continue
        await adjustCookCount(tx, space._id, wish.recipeId, 1)
        await tx.collection('cooking_records').doc(row._id).update({ data: { recipeId: wish.recipeId, version: row.version + 1, updatedAt: stamp, updatedBy: openid } })
      }
      count++
    }
    if (catalogChanged) await tx.collection('spaces').doc(space._id).update({ data: {
      categories, tags, catalogVersion: (currentSpace.catalogVersion || 0) + 1, updatedAt: stamp
    } })
    return count
  }, 5)
  return { kind, dryRun: false, offset, nextOffset: offset + rows.length, inspected: rows.length, changed, hasMore: rows.length === 5 }
}

const handlers = {
  bootstrap: (openid) => bootstrap(openid),
  createSpace,
  renameSpace,
  manageTaxonomy,
  createInvite: (openid) => createInvite(openid),
  joinSpace,
  listMembers: (openid) => listMembers(openid),
  transferOwner,
  leaveSpace: (openid) => leaveSpace(openid),
  removeMember,
  listRecipes: async (openid, p) => {
    const { space } = await membership(openid)
    const categoryId = p.categoryId ? str(p.categoryId, '分类ID', 80, true) : ''
    if (p.availableOnly != null && typeof p.availableOnly !== 'boolean') fail('INVALID_INPUT', '可点筛选格式错误')
    if (p.archivedOnly != null && typeof p.archivedOnly !== 'boolean') fail('INVALID_INPUT', '归档筛选格式错误')
    if (p.availableOnly && p.archivedOnly) fail('INVALID_INPUT', '可点与归档筛选不能同时使用')
    const extra = (p.includeArchived || p.archivedOnly) && !p.availableOnly ? {} : { archivedAt: null }
    if (categoryId && categoryId !== 'uncategorized') {
      docId(categoryId, '分类ID')
      if (!(space.categories || []).some(item => item.id === categoryId && !item.deletedAt)) fail('INVALID_INPUT', '分类不存在或已删除')
    }
    if (!categoryId && !p.availableOnly && !p.archivedOnly) return resolvedRecipes(await listed('recipes', space._id, p.offset || 0, extra), space)
    const offset = p.offset || 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_INPUT', '翻页参数错误')
    const rows = []
    let scanned = 0
    // ponytail: filtered lists scan existing sorted pages; add a composite index if one kitchen grows past a few hundred recipes.
    while (scanned <= 10000 && rows.length < offset + 50) {
      const page = await listed('recipes', space._id, scanned, extra)
      rows.push(...page.filter(item => (!p.availableOnly || item.available !== false) && (!p.archivedOnly || !!item.archivedAt) && (!categoryId ||
        (categoryId === 'uncategorized' ? !item.categoryId || !(space.categories || []).some(entry => entry.id === item.categoryId && !entry.deletedAt) : item.categoryId === categoryId))))
      scanned += page.length
      if (page.length < 50) break
    }
    return resolvedRecipes(rows.slice(offset, offset + 50), space)
  },
  getRecipe: async (openid, p) => { const { space } = await membership(openid); return (await resolvedRecipes([await owned('recipes', p.id, space._id)], space))[0] },
  saveRecipe,
  archiveRecipe,
  unarchiveRecipe,
  listWishes: async (openid, p) => { const { space } = await membership(openid); const status = p.status; if (status && !['open', 'completed'].includes(status)) fail('INVALID_INPUT', '心愿状态错误'); return hydratedWishes(await listed('wishes', space._id, p.offset || 0, { status: status || db.command.in(['open', 'completed']) }), space) },
  getWish: async (openid, p) => { const { space } = await membership(openid); return (await hydratedWishes([await owned('wishes', p.id, space._id)], space))[0] },
  saveWish,
  completeWish,
  deleteWish,
  listMeals: async (openid, p) => { const { space } = await membership(openid); return listed('meals', space._id, p.offset || 0) },
  getMeal: async (openid, p) => { const { space } = await membership(openid); return mealForDisplay(await owned('meals', p.id, space._id), space) },
  saveMeal,
  saveMealMemory,
  getMealDishMemory,
  saveMealDishMemory,
  saveEatingMeal,
  addMealItem,
  submitMealSelection,
  removeMealItem,
  reopenMeal,
  listRecords: async (openid, p) => { const { space } = await membership(openid); const recipeId = p.recipeId ? docId(p.recipeId, '菜品ID') : ''; const mealId = p.mealId ? docId(p.mealId, '饭单ID') : ''; if (recipeId) await owned('recipes', recipeId, space._id); if (mealId) await owned('meals', mealId, space._id); return listed('cooking_records', space._id, p.offset || 0, { ...(recipeId ? { recipeId } : {}), ...(mealId ? { mealId } : {}) }) },
  getRecord: async (openid, p) => { const { space } = await membership(openid); return owned('cooking_records', p.id, space._id) },
  deleteRecord,
  saveRecord,
  addMealItemPhoto,
  listActivities: async (openid, p) => { const { space } = await membership(openid); const offset = p.offset || 0; if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail('INVALID_INPUT', '翻页参数错误'); const result = await db.collection('activity_logs').where({ spaceId: space._id }).orderBy('createdAt', 'desc').skip(offset).limit(50).get(); return result.data.map(({ actorId, ...item }) => item) },
  uploadMedia,
  beginMediaUpload,
  finishMediaUpload,
  mediaUrls,
  discardMedia,
  exportData,
  migrateLegacy
}

exports.main = async event => {
  try {
    const { OPENID, SOURCE } = cloud.getWXContext()
    if (!OPENID || !['wx_client', 'wx_devtools'].includes(SOURCE)) fail('UNAUTHORIZED', '请从微信小程序打开')
    const request = obj(event)
    const action = str(request.action, '操作', 40, true)
    if (!Object.prototype.hasOwnProperty.call(handlers, action)) fail('INVALID_ACTION', '不支持的操作')
    const data = await handlers[action](OPENID, request.payload == null ? {} : obj(request.payload))
    return { ok: true, data: withIds(data) }
  } catch (error) {
    if (!(error instanceof AppError)) console.error('kitchen failed', error)
    return { ok: false, error: { code: error instanceof AppError ? error.code : 'SERVER_ERROR', message: error instanceof AppError ? error.message : '暂时无法完成操作，请稍后重试' } }
  }
}
