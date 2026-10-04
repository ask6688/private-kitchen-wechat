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

结束后关闭 Playwright 会话，并在静态服务终端按 Ctrl+C：

```sh
npx --package @playwright/cli playwright-cli --session kitchen-showcase close
```

`output/` 和 `.playwright-cli/` 是本地临时产物，不应提交。正式展示只保留七张 PNG、原创 SVG 和复现脚本。
