# kitchen 云函数

所有业务请求通过 `wx.cloud.callFunction({ name: 'kitchen', data: { action, payload } })` 进入。成功返回 `{ ok: true, data }`，失败返回 `{ ok: false, error: { code, message } }`。文档包含 `id` 和 `_id`；编辑提交 `id`、当前 `version` 及待保存字段。

## 部署到自己的环境

1. 创建以下 CloudBase 文档集合：`users`、`spaces`、`space_members`、`recipes`、`wishes`、`meals`、`cooking_records`、`invitations`、`activity_logs`、`media_assets`。
2. 每个集合及云存储的客户端规则设为 `{ "read": false, "write": false }`。云函数使用管理端权限，仍在每个动作中验证成员和厨房归属。照片只获得指定暂存对象的限时上传凭证。
3. 建立下面的索引。数组照片字段使用相应的数组查询索引；带时间的排序列为降序。
4. 在本目录运行 `npm ci`。在微信开发者工具选定自己的 CloudBase 环境，部署 `kitchen` 并选择云端安装依赖；沿用支持 `wx-server-sdk` 的 Node.js 运行时，内存 256 MB、超时 15 秒。
5. 在小程序后台把本环境实际 COS 主机添加到 `request` 合法域名，刷新开发者工具域名信息。保持域名和 TLS 校验开启。
6. 编译小程序，用自己的两个开发/体验账号建立测试厨房并检查完整流程。

| 集合 | 索引字段 |
| --- | --- |
| `recipes` | `(spaceId, archivedAt, updatedAt)`、`(spaceId, updatedAt)`、`(spaceId, coverFileId)`、`(spaceId, photoFileIds)` |
| `wishes` | `(spaceId, status, updatedAt)`、`(spaceId, updatedAt)` |
| `meals` | `(spaceId, updatedAt)`、`(spaceId, photoFileIds)` |
| `cooking_records` | `(spaceId, updatedAt)`、`(spaceId, recipeId, updatedAt)`、`(spaceId, mealId, updatedAt)`、`(spaceId, photoFileIds)` |
| `activity_logs` | `(spaceId, createdAt)` |
| `space_members` | `(spaceId)` |

其余主要按 `_id` 读取。引用查询失败时拒绝回收文件，不能把查询失败当成没有引用。

## API 入口

| 场景 | 主要动作 |
| --- | --- |
| 空间与成员 | `bootstrap`、`createSpace`、`renameSpace`、`createInvite`、`joinSpace`、`listMembers`、`transferOwner`、`leaveSpace`、`removeMember` |
| 分类标签与菜品 | `manageTaxonomy`、`listRecipes`、`getRecipe`、`saveRecipe`、`archiveRecipe`、`unarchiveRecipe` |
| 心愿 | `listWishes`、`getWish`、`saveWish`、`completeWish`、`deleteWish` |
| 饭单与吃饭记录 | `submitMealSelection`、`listMeals`、`getMeal`、`saveMeal`、`saveEatingMeal`、`removeMealItem`、`reopenMeal`、`saveMealMemory` |
| 单菜记录 | `listRecords`、`getRecord`、`saveRecord`、`deleteRecord`、`getMealDishMemory`、`saveMealDishMemory` |
| 照片与导出 | `beginMediaUpload`、`finishMediaUpload`、`mediaUrls`、`discardMedia`、`exportData` |

成员动作中的 `userId` 是成员接口返回的不透明标识，不是前端提供的 OPENID。身份只来自微信云端上下文；调用来源限制为 `wx_client` 或 `wx_devtools`。

## 上传与数据保护

当前照片链路为：前端压缩并校验 → `beginMediaUpload({ requestId, size, md5 })` → 二进制 PUT → `finishMediaUpload({ requestId })`。业务字段只保存返回的 fileId。服务端检查暂存对象的大小、摘要和 JPEG/PNG 格式，再保存正式云文件。

单张最多 1 MiB，每个厨房最多 512 MiB，是应用限制，不代表云服务套餐额度。每名成员使用一个暂存对象；同一成员并发上传可能需要重试。已上传回执可用于确认丢失响应，文件回收须检查菜品、制作记录和整餐相册的全部引用。

共享编辑使用版本检查，饭单提交和新建记录使用 requestId 去重。`VERSION_CONFLICT` 表示需核对最新内容；`REQUEST_CONFLICT` 表示同一请求 ID 携带了不同业务内容。已确认的回执重放可能返回 `replayed` 和 `changedSinceReceipt`，客户端不能把它当成一次新保存。回执有保留窗口，过期请求须核对后发起新请求。

整餐相册仅属于 `meals.photoFileIds`；单菜照片属于其制作记录。修改整餐心得或相册不改变制作次数。Menu 优先使用历史分类快照，缺失来源信息时只读补齐，不迁移或改写历史。

## 兼容与迁移

`uploadMedia` 的旧 Base64/分块协议、`addMealItem`、`addMealItemPhoto` 和 `listActivities` 保留旧客户端及旧草稿兼容。当前 UI 不展示活动流，`activity_logs` 仍保存旧数据和选菜幂等回执，不能清空。

旧字段通过 `migrateLegacy({ kind, offset?, dryRun? })` 迁移：按 `recipes` → `wishes` → `cooking_records`，每批最多 5 条，默认仅预演。核对候选和备份后才传 `dryRun: false`。迁移保留原 ID、照片引用和饭单快照；新环境无需迁移。

`exportData({ collection, offset? })` 返回 `{ schemaVersion: 2, items, hasMore, fileIds }`，每页最多 50 条；collection 支持 catalog 及菜品、心愿、饭单、制作记录、历史活动。JSON 不包含照片原图，临时 URL 不能作为永久备份。

## 检查

运行 `node test.js`，或在仓库根目录运行 `npm test`。后端测试使用内存 SDK，覆盖权限隔离、事务失败、并发选菜、重复请求、记录计数和照片引用保护。真实身份、部署索引、存储规则及双人真机检查见 [验证清单](../../docs/ACCEPTANCE.md)。
