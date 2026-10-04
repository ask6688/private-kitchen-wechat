# 公开展示图的来源与复现

这些图片使用虚构演示数据，由当前页面模板在浏览器中本地渲染。它们用于介绍产品结构和视觉，不是微信开发者工具或真机截图，也不证明云端、双账号或手机兼容性已经验收。图片顶部保留了来源标签。

## 使用了什么

- `generate.js` 读取当前菜单、心愿、饭单、Menu 详情、记录、我们六个页面的 WXML 和 WXSS，替换展示数据，不执行页面业务 JS
- 完整 Menu 使用当前 `menu-preview/render.js` 与随包字形，直接在浏览器 Canvas 绘制
- 厨房名称为“我们的厨房”，小林、小夏、菜名、日期、心得、次数和容量均为虚构数据
- 食物图是脚本生成的原创 SVG 插画，保存在 `docs/assets/food/`，没有使用用户照片、真实成员或真实云文件引用
- 原生标签、`rpx`、导航栏和 Tab 栏通过简易适配器转为浏览器元素；微信特有控件和字体在真机上可能有差异

生成过程只有本地文件读取和绘图，不连接 CloudBase，不读取或修改真实厨房数据。图片不包含登录凭据、环境 ID、openid、邀请码、Connected 调试条或工具窗口。

## 复现

需要 Node.js 18+、Python 3，以及 Playwright CLI 支持的本地浏览器。在仓库根目录执行：

```sh
node scripts/showcase/generate.js
python3 -m http.server 8764 --bind 127.0.0.1
```

保持这个本地静态服务运行，在另一个终端执行：

```sh
npx --package @playwright/cli playwright-cli --session kitchen-showcase open http://127.0.0.1:8764/output/playwright/showcase/menu.html
npx --package @playwright/cli playwright-cli --session kitchen-showcase run-code --filename scripts/showcase/capture.js
```

截图暂存在 `output/playwright/`。逐张检查后，将以下七张图片复制到 `docs/assets/screenshots/`：

```text
menu.png
wishes.png
meal.png
meal-detail.png
records.png
space.png
complete-menu.png
```

捕捉脚本在保存前等待绘制完成，并检查横向溢出、图片加载和未替换的模板表达式。它只核对文档页面，不代替小程序业务测试。

截图使用 390 × 844 的逻辑视窗与 3 倍设备像素比，六张页面 PNG 为 1170 × 2532；页面内容独立滚动，底部 Tab 保持可见。完整 Menu 为 1170 × 1596 的整页图，Canvas 本身按 3 倍绘制为 1800 × 2298，再进行截图，并非放大旧 PNG。

## 浏览器交互演示

在仓库根目录生成可发布的静态目录：

```sh
node scripts/showcase/generate.js --site
python3 -m http.server 8764 --bind 127.0.0.1
```

打开 `http://127.0.0.1:8764/output/showcase-site/index.html`。生成目录自带原创食物插画、Tab 图标、字形文件和字体许可，无需连接外部字体服务。

可操作分类筛选、菜名或标签搜索、加减选菜、选菜后查看本地饭单，以及菜单、心愿、记录、我们、吃饭详情与完整 Menu 的页面切换。选择和“演示饭单”只保存在当前浏览器内存，刷新即重置。吃饭详情和完整 Menu 展示固定的虚构历史记录，与刚选择的演示饭单分开，不模拟完成和保存。

登录、照片上传、云端保存、删除、导出和成员管理未在此网页实现；点击相关入口会说明限制，不提示保存成功。真实业务代码仍在小程序和云函数中，浏览器 Demo 不读取、写入或同步 CloudBase 数据。

可用已有 Playwright CLI 复现本轮交互检查：

```sh
npx --package @playwright/cli playwright-cli --session kitchen-showcase open http://127.0.0.1:8764/output/showcase-site/index.html
npx --package @playwright/cli playwright-cli --session kitchen-showcase run-code --filename scripts/showcase/check.js
```

`check.js` 检查分类、搜索与空状态、加减选择、本地饭单、未实现操作提示、Menu 绘制、页面切换和刷新重置。它只验证此文档 Demo，不代表真机或云端验收。

`.github/workflows/showcase-pages.yml` 将同一生成目录发布为 GitHub Pages。它与应用检查工作流分开，不部署小程序或云函数。

结束后关闭 Playwright 会话，并在静态服务终端按 Ctrl+C：

```sh
npx --package @playwright/cli playwright-cli --session kitchen-showcase close
```

`output/` 和 `.playwright-cli/` 是本地临时产物，不应提交。仓库保留七张 PNG、原创 SVG、生成与检查脚本；Actions 构建的静态目录用于 Pages 发布。
