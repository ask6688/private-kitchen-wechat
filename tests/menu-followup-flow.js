const assert = require('node:assert/strict')
const storage = new Map(), routes = [], globals = {}
let definition, modal, uncertain = false, writes = 0, pending = null
let meal = { id: 'meal-followup-001', spaceId: 'space-followup-001', version: 1, status: 'completed', title: '朋友晚饭', date: '2026-10-01', diners: 2,
 photoFileIds: [], reflection: '整餐心得', items: [{ id: 'dish-followup-001', name: '饺子', state: 'eaten', dishMemory: { photoFileIds: [], reflection: '' } }],
 menuSnapshot: { title: '朋友晚饭', date: '2026-10-01', diners: 2, groups: [{ name: '未分类', items: [{ id: 'dish-followup-001', name: '饺子' }] }] } }
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const project = () => ({ ...clone(meal), sourceName: '饺子', recordVersion: 0, photoFileIds: meal.items[0].dishMemory.photoFileIds, reflection: meal.items[0].dishMemory.reflection })
const ok = data => ({ result: { ok: true, data: clone(data) } })
global.getApp = () => ({globalData: globals}); global.getCurrentPages = () => []
global.Page = value => {definition=value}
global.wx = {getStorageSync:key=>clone(storage.get(key)), setStorageSync:(key,value)=>storage.set(key,clone(value)), removeStorageSync:key=>storage.delete(key),
 showLoading(){},hideLoading(){},showToast(){},enableAlertBeforeUnload(){},disableAlertBeforeUnload(){},setNavigationBarTitle(){},
 getWindowInfo:()=>({statusBarHeight:24}),showModal:options=>{modal=options},getFileSystemManager:()=>({unlink(){}}),
 navigateTo:options=>{routes.push(options.url);options.success()},redirectTo:options=>{routes.push(options.url);options.success()},
 cloud:{callFunction:async({data:{action,payload}})=>{
  if(action==='bootstrap')return ok({space:{id:meal.spaceId},member:{id:'member-followup-001'}})
  if(action==='getMeal')return ok(meal)
  if(action==='listRecords')return ok([])
  if(action==='getRecipe')return ok({coverFileId:'cover-followup-001'})
  if(action==='getMealDishMemory')return ok(project())
  if(action==='mediaUrls')return ok({urls:Object.fromEntries(payload.fileIds.map(id=>[id,'https://test/'+id]))})
  if(action==='saveMealDishMemory'){
   if(pending && pending.requestId===payload.requestId)return ok(project())
   assert.equal(payload.itemId,meal.items[0].id)
   if(payload.version!==meal.version)return {result:{ok:false,error:{code:'VERSION_CONFLICT',message:'伙伴已更新'}}}
   meal.items[0].dishMemory={...meal.items[0].dishMemory,...Object.fromEntries(['photoFileIds','reflection'].filter(key=>Object.hasOwn(payload,key)).map(key=>[key,payload[key]]))}
   meal.version++;writes++;pending=clone(payload)
   if(uncertain){uncertain=false;throw new Error('响应丢失')}
   return ok(project())
  }
  throw new Error(action)
 }}}
const page=value=>({...value,data:clone(value.data),setData(fields,callback){Object.assign(this.data,fields);if(callback)callback()}})
async function main(){
 require('../miniprogram/pages/record-edit/index'); const editor=page(definition)
 await editor.onLoad({mealId:meal.id,itemId:meal.items[0].id});assert.equal(editor.data.dishContext,true)
 assert.deepEqual(editor.data.photos,[]);assert.equal(editor.data.reflection,'')
 editor.onNote({detail:{value:'薄皮馅足'}}); uncertain=true;await editor.save()
 assert.ok(editor.data.pendingMemoryPayload);assert.equal(editor.data.reflection,'薄皮馅足');assert.equal(routes.length,0)
 await editor.save();assert.equal(writes,1);assert.equal(routes.at(-1),'/pages/menu-preview/index?id='+meal.id+'&from=list')
 assert.equal(meal.reflection,'整餐心得');assert.deepEqual(meal.photoFileIds,[])
 const cancel=page(definition);await cancel.onLoad({mealId:meal.id,itemId:meal.items[0].id});cancel.onNote({detail:{value:'取消草稿'}})
 cancel.cancelDishMemory();await modal.success({confirm:true});cancel.onUnload();assert.equal(storage.has(cancel.memoryDraftKey),false);assert.equal(meal.items[0].dishMemory.reflection,'薄皮馅足')
 const conflict=page(definition);await conflict.onLoad({mealId:meal.id,itemId:meal.items[0].id});conflict.onNote({detail:{value:'我的心得'}})
 meal.version++;meal.items[0].dishMemory.reflection='伙伴心得';pending=null;await conflict.save();assert.equal(conflict.data.memoryConflictReflection,true);assert.equal(conflict.data.reflection,'我的心得')
 await conflict.resolveMemoryConflict({currentTarget:{dataset:{field:'reflection',choice:'mine'}}});await conflict.save();assert.equal(meal.items[0].dishMemory.reflection,'我的心得')
 meal.items[0].dishMemory.photoFileIds=['legacy-photo-1','legacy-photo-2'];const legacy=page(definition);await legacy.onLoad({mealId:meal.id,itemId:meal.items[0].id})
 legacy.removePhoto();assert.deepEqual(legacy.data.photos,[]);assert.deepEqual(meal.items[0].dishMemory.photoFileIds,['legacy-photo-1','legacy-photo-2'])
 legacy.cancelDishMemory();await modal.success({confirm:true});legacy.onUnload();assert.deepEqual(meal.items[0].dishMemory.photoFileIds,['legacy-photo-1','legacy-photo-2'])
 const deleted=page(definition);await deleted.onLoad({mealId:meal.id,itemId:meal.items[0].id});deleted.removePhoto();await deleted.save();assert.deepEqual(meal.items[0].dishMemory.photoFileIds,[]);assert.equal(meal.reflection,'整餐心得');deleted.onUnload()
 meal.items[0].recipeId='recipe-cover-followup-001';require('../miniprogram/pages/menu-preview/index');const detail=page(definition);detail.onLoad({id:meal.id});detail.render=async()=>{};await detail.load()
 assert.equal(detail.data.dishGroups[0].items[0].reflection,'我的心得');assert.equal(detail.data.dishGroups[0].items[0].hasMemory,true);assert.deepEqual(detail.data.dishGroups[0].items[0].photos,[]);assert.equal(detail.data.dishGroups[0].items[0].displayPhotos[0].fileId,'cover-followup-001')
 detail.showCompletion();detail.addCompletionMemory();assert.equal(detail.data.overlay,false);assert.equal(routes.at(-1),'/pages/meal/index?id='+meal.id+'&mode=record&return=detail')
 detail.dish({currentTarget:{dataset:{id:meal.items[0].id}}});assert.equal(routes.at(-1),'/pages/record-edit/index?mealId='+meal.id+'&itemId='+meal.items[0].id)
 detail.onUnload();editor.onUnload();conflict.onUnload()
 console.log('Menu followup passed: explicit dish entry, separate album/note, uncertain retry, cancel, conflict retention and overlay edit action')
}
main().catch(error=>{console.error(error);process.exitCode=1})
