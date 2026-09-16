# zcode-tarkov

[English](README.md) | [中文](README.zh-CN.md)

为 **ZCode 桌面客户端** 提供一套 Escape from Tarkov 风格的界面主题，包含三种可即时切换的配色模式，以及一个 ZCode 内置的实时设置面板。通过 CDP 注入实现，**不会修改 ZCode 的安装文件**。

> **非官方项目。** 本项目与 Battlestate Games（《Escape from Tarkov》的开发商/发行商）**没有任何隶属、背书或赞助关系**。仓库内**不包含任何游戏素材**——没有游戏图片、语音、Logo、贴图或截图。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 三种配色模式

原有的 `monet: true/false` 只能表达两种状态，无法描述"固定配色"这第三种。现在改为显式的 `colorMode`：

| 模式 | UI 配色来源 | 壁纸是否仍可用 |
|---|---|---|
| **Monet** | 从壁纸提取（Material Design 3 动态取色），保持上游原有行为 | 是 |
| **Tarkov** | **固定**的 Tarkov 风格调色板；壁纸**不会**影响 UI 颜色 | 是——更换、隐藏、模糊、压暗、cover/contain/smart 全部照常 |
| **Native** | 完全保留 ZCode 原生颜色 | 是，通过半透明覆盖层让壁纸可见 |

**Tarkov** 模式使用固定配色：强调橙 `#e07930`、深棕底色、暖色文字 `#e8d9c8`、细暖橙描边、接近直角的圆角、橙色选中指示条，并在窗口顶部显示一条两行的"测试版界面"警示带。

功能性颜色（`success` / `warning` / `danger` / `destructive` / `git-*` / `diff-*`）以及代码块的语法配色**一律不覆盖**：状态要可辨识，代码要可读。

## 来源

- **基础设施：[zcode-beautify](https://github.com/Logocceai/zcode-beautify)**（MIT，© 2026 Logocceai）。本项目是其派生项目：CDP 注入层、MD3/Monet 取色、壁纸层、启动器/恢复/自启动机制、设置面板与 MCP 工具均沿用其成果，而非重新实现。Git 历史保留，原 remote 保存为 `upstream-beautify`。
- **视觉语言：[dsh-theme-tarkov](https://github.com/ZHIGENGNIAO258/dsh-theme-tarkov)**（MIT，© 2026 dsh-theme-tarkov contributors）。**仅作为只读参考**，借鉴其 Tarkov 配色与警示带的设计思路。该项目面向另一个应用（DeepSeek Harness / Cordis）；本项目**未复制其任何代码、选择器或素材**。

上游平台无关的 `skill-pack/` 按原 MIT 署名原样保留，它不属于 Tarkov 主题本身。

完整的来源说明与"明确排除的素材清单"见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 环境要求

- **Windows**（主要目标平台；`repair-launchers` 仅支持 Windows，其余功能跨平台）。
- **Node.js ≥ 20**，用于运行 CLI / MCP。**普通用户无需构建**——`dist/cli.js` 与 `dist/mcp/server.js` 已随仓库提交。
- **ZCode Desktop 3.11.x**，需要至少以 `--remote-debugging-port` 启动过一次。

## 快速开始（Windows，基于 clone）

```powershell
# 0) 完全退出 ZCode（包括托盘图标）。

# 1) 以 CDP 调试端口启动 ZCode。
node dist/cli.js launch

# 2) 导入壁纸（不会改变当前配色模式）。
node dist/cli.js apply "C:\path\to\wallpaper.jpg"

# 3) 切换到 Tarkov 配色。
node dist/cli.js theme tarkov

# 4) 让调试端口在正常启动时也生效。先 dry-run 预览：只会写入当前用户的
#    快捷方式和 HKCU 项，绝不提权。
node dist/cli.js repair-launchers --dry-run
node dist/cli.js repair-launchers

# 5) 启动常驻服务：设置面板 + 自动恢复。
node dist/cli.js serve --detach
```

服务运行后，ZCode 右下角会出现 🎨 按钮。Tarkov 模式下设置面板自身也会切换为 Tarkov 皮肤，切回 Monet / Native 时恢复中性外观。

## 配置与迁移

配置位于 `%USERPROFILE%\.zcode\cli\plugins\data\zcode-tarkov\config.json`（或插件作用域目录 `zcode-tarkov@zcode-tarkov`；若设置了 `ZCODE_BEAUTIFY_DATA_DIR` 则以该变量为准）。

`colorMode` 取代了旧的 `monet` 布尔值：

| 已存储的配置 | 解析结果 |
|---|---|
| `{ "monet": true }`（0.1 之前的配置） | `monet` |
| `{ "monet": false }` | `native` |
| `{ "colorMode": "tarkov" }` | `tarkov` |
| 缺失 / 格式错误 / 未知 | `monet`（上游默认值） |

两个字段始终会同步写回并保持一致，因此旧版本插件读取同一份配置也能得到等效外观。读取旧配置**不会抛错**。若检测到已有的 `zcode-beautify` 数据目录，会作为回退位置使用，从而让旧配置被识别并在下次保存时升级，而不是被静默忽略。

## 警示带（Beta banner）

**仅在 Tarkov 模式**下显示：半透明橙色色带、深色六边形 `!` 徽标、两行文字。文案与外观可通过配置项 `banner.text1` / `banner.text2` / `banner.opacity` / `banner.height`（或 `POST /api/config`）调整，未写死在代码里。

它按 fail-soft 原则实现：锚定在 ZCode 自带 HTML 中必然存在的 `#root`，并作为 **React 根节点的兄弟节点**插入，因此 React 永远不会在 reconcile 时覆盖它。锚点不存在时什么也不插入、不抛错。文字写入是**条件写入**且 observer 回调做了去抖，因此不会造成自触发死循环而卡住页面。切离 Tarkov 模式时会干净移除。

选择器调查过程（包括为何在参考机器上无法进行实时 CDP 检查）记录在 [docs/zcode-dom-notes.md](docs/zcode-dom-notes.md)。

## 开发

```powershell
npm install
npm run build      # tsc -> dist（类型检查）
npm test           # 编译到 .test-build/ 并运行 node --test
npm run bundle     # build + esbuild -> 两个随仓库提交的 dist 包
```

修改 `src/` 后请运行 `npm run bundle` 并提交更新后的 `dist/`——用户直接运行打包产物，不应需要自行构建。

## 已知限制

- **尚未在真实运行的 ZCode 中验证 Tarkov 皮肤的实际渲染效果。** 参考机器上运行的 ZCode 没有开放 CDP 端口；受 ZCode 单实例锁限制无法启动第二个隔离实例；而重启 ZCode 会终止正在执行本任务的会话本身。所有选择器均取自与已安装版本完全一致的 renderer 构建产物，证据链与复验命令见 [docs/zcode-dom-notes.md](docs/zcode-dom-notes.md)。
- 警示带在挂载期间通过 `body { padding-top }` 预留高度，依赖 ZCode 3.11.2 的 `html,body,#root{height:100%}` + border-box 结构。
- Tarkov 模式本身就是深色配色，不跟随 ZCode 自身的浅色/深色切换。
- CDP 注入属于**非官方**机制，ZCode 更新可能导致失效；`reset` 始终可以恢复默认外观。

## 许可

MIT，见 [LICENSE](LICENSE)。派生自 zcode-beautify；Tarkov 风格部分改编自 dsh-theme-tarkov。两个上游的版权声明均保留于 [LICENSE](LICENSE) 与 [licenses/](licenses/)。
