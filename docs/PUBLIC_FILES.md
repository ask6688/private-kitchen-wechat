# GitHub 公开文件清单

公开版本保留完整小程序、云函数和测试，以产品展示和自行部署为目的

| 内容 | 保留原因 |
| --- | --- |
| `miniprogram/` | 14 个已使用页面、共享工具、样式、Tab 图标和 Menu 字形 |
| `cloudfunctions/kitchen/` | 完整业务、权限检查、依赖锁文件和后端测试 |
| `tests/` | 18 组前端行为与基础检查 |
| `scripts/` | 统一测试入口、字形构建及演示图复现 |
| `docs/`、`README.md` | 产品、架构、验证范围和 7 张公开演示图 |
| 配置示例 | 自行填写 AppID、CloudBase 环境 ID |
| `.github/workflows/` | 自动检查与静态 Demo 发布 |

## 留在本地的内容

- 实际配置、环境变量和任何凭据
- 私人照片、真实成员数据、历史导出、部署备份和验收日志
- `node_modules/`、缓存、构建与浏览器临时产物
- 迭代计划草稿、旧的调试素材

实际配置被 Git 忽略，私人素材与迭代资料已移到项目外保留。云端数据没有修改。公开仓库从清理后的独立根提交开始；原本含真实配置的 Git 历史只留在本地

## 完整清单

以下为当前公开版本的 140 个文件。后续维护可能增加或删减

<details>
<summary>展开逐文件清单</summary>

```text
.github/workflows/checks.yml
.github/workflows/showcase-pages.yml
.gitignore
README.md
cloudfunctions/kitchen/README.md
cloudfunctions/kitchen/index.js
cloudfunctions/kitchen/package-lock.json
cloudfunctions/kitchen/package.json
cloudfunctions/kitchen/test.js
docs/ACCEPTANCE.md
docs/ARCHITECTURE.md
docs/PRODUCT.md
docs/PUBLIC_FILES.md
docs/assets/README.md
docs/assets/food/pasta.svg
docs/assets/food/salad.svg
docs/assets/food/salmon.svg
docs/assets/food/soup.svg
docs/assets/screenshots/complete-menu.png
docs/assets/screenshots/meal-detail.png
docs/assets/screenshots/meal.png
docs/assets/screenshots/menu.png
docs/assets/screenshots/records.png
docs/assets/screenshots/space.png
docs/assets/screenshots/wishes.png
miniprogram/app.js
miniprogram/app.json
miniprogram/app.wxss
miniprogram/config.example.js
miniprogram/fonts/OFL.json
miniprogram/fonts/README.md
miniprogram/fonts/kitchen-menu-glyphs.br
miniprogram/images/tabbar/menu-normal.png
miniprogram/images/tabbar/menu-selected.png
miniprogram/images/tabbar/records-normal.png
miniprogram/images/tabbar/records-selected.png
miniprogram/images/tabbar/us-normal.png
miniprogram/images/tabbar/us-selected.png
miniprogram/images/tabbar/wishes-normal.png
miniprogram/images/tabbar/wishes-selected.png
miniprogram/pages/meal/index.js
miniprogram/pages/meal/index.json
miniprogram/pages/meal/index.wxml
miniprogram/pages/meal/index.wxss
miniprogram/pages/meal/memory.js
miniprogram/pages/meal/record.js
miniprogram/pages/menu-picker/index.js
miniprogram/pages/menu-picker/index.json
miniprogram/pages/menu-picker/index.wxml
miniprogram/pages/menu-picker/index.wxss
miniprogram/pages/menu-preview/font.js
miniprogram/pages/menu-preview/index.js
miniprogram/pages/menu-preview/index.json
miniprogram/pages/menu-preview/index.wxml
miniprogram/pages/menu-preview/index.wxss
miniprogram/pages/menu-preview/render.js
miniprogram/pages/menu/index.js
miniprogram/pages/menu/index.json
miniprogram/pages/menu/index.wxml
miniprogram/pages/menu/index.wxss
miniprogram/pages/menu/page.js
miniprogram/pages/recipe-edit/index.js
miniprogram/pages/recipe-edit/index.json
miniprogram/pages/recipe-edit/index.wxml
miniprogram/pages/recipe-edit/index.wxss
miniprogram/pages/recipe/index.js
miniprogram/pages/recipe/index.json
miniprogram/pages/recipe/index.wxml
miniprogram/pages/recipe/index.wxss
miniprogram/pages/record-edit/index.js
miniprogram/pages/record-edit/index.json
miniprogram/pages/record-edit/index.wxml
miniprogram/pages/record-edit/index.wxss
miniprogram/pages/record-list/index.js
miniprogram/pages/record-list/index.json
miniprogram/pages/record-list/index.wxml
miniprogram/pages/record-list/index.wxss
miniprogram/pages/records/index.js
miniprogram/pages/records/index.json
miniprogram/pages/records/index.wxml
miniprogram/pages/records/index.wxss
miniprogram/pages/records/page.js
miniprogram/pages/taxonomy/index.js
miniprogram/pages/taxonomy/index.json
miniprogram/pages/taxonomy/index.wxml
miniprogram/pages/taxonomy/index.wxss
miniprogram/pages/us/index.js
miniprogram/pages/us/index.json
miniprogram/pages/us/index.wxml
miniprogram/pages/us/index.wxss
miniprogram/pages/welcome/index.js
miniprogram/pages/welcome/index.json
miniprogram/pages/welcome/index.wxml
miniprogram/pages/welcome/index.wxss
miniprogram/pages/wish-picker/index.js
miniprogram/pages/wish-picker/index.json
miniprogram/pages/wish-picker/index.wxml
miniprogram/pages/wish-picker/index.wxss
miniprogram/pages/wishes/index.js
miniprogram/pages/wishes/index.json
miniprogram/pages/wishes/index.wxml
miniprogram/pages/wishes/index.wxss
miniprogram/pages/wishes/page.js
miniprogram/sitemap.json
miniprogram/styles/celebration.wxss
miniprogram/styles/cooking-record.wxss
miniprogram/utils/api.js
miniprogram/utils/celebration.js
miniprogram/utils/navigation.js
miniprogram/utils/photos.js
miniprogram/utils/selection.js
miniprogram/utils/swipe.js
miniprogram/utils/upload.js
package.json
project.config.example.json
scripts/build-menu-glyphs.py
scripts/showcase/README.md
scripts/showcase/capture.js
scripts/showcase/check.js
scripts/showcase/client.js
scripts/showcase/generate.js
scripts/test.js
tests/cooking-record-flow.js
tests/detail-navigation-flow.js
tests/detail-photo-flow.js
tests/meal-cancel.js
tests/meal-flow.js
tests/meal-memory-flow.js
tests/menu-followup-flow.js
tests/menu-font-flow.js
tests/menu-integration-flow.js
tests/menu-preview.js
tests/menu-submit.js
tests/navigation-flow.js
tests/page-loading-flow.js
tests/photo-loading.js
tests/project-check.js
tests/records-flow.js
tests/upload-flow.js
tests/wish-meal-flow.js
```

</details>
