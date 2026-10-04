# 公开展示素材

这里保留 7 张产品演示图和 4 张原创食物插画，供 README 展示使用

| 图片 | 场景 |
| --- | --- |
| `screenshots/menu.png` | 菜单首页与分类 |
| `screenshots/wishes.png` | 心愿与选菜 |
| `screenshots/meal.png` | 当前饭单 |
| `screenshots/meal-detail.png` | 一起吃饭的 Menu 详情 |
| `screenshots/records.png` | 最近记录 |
| `screenshots/space.png` | 双人空间 |
| `screenshots/complete-menu.png` | 完整 Menu |

厨房、成员、菜品、心得和统计数据均为虚构，食物 SVG 由展示脚本原创生成。没有使用私人照片、真实成员信息、云文件链接或邀请码

页面图由项目当前 WXML/WXSS 在浏览器中本地渲染；完整 Menu 使用项目实际 Canvas 和字形代码。顶部保留来源标签。这些演示图用于说明产品效果，不代表真机、双账号或云端流程已通过验收

六张页面 PNG 为 1170 × 2532，完整 Menu 为 1170 × 1596，均以 3 倍设备像素比重新截图。完整 Menu 的 Canvas 本身以 1800 × 2298 绘制，未使用旧图放大；不同演示数据的高度会随内容变化

同一套模板也用于 GitHub Pages 的轻量浏览器 Demo：分类、搜索、加减选菜、查看本地饭单和页面切换可操作。选择仅保存在浏览器内存，刷新重置；固定的历史 Menu 与本地演示饭单分开。保存、上传、删除和成员管理等云端功能不在网页模拟，页面明确标注“不连接 CloudBase”

[生成与复现方法](../../scripts/showcase/README.md) · [业务验证说明](../ACCEPTANCE.md)
