# pi-tokyo-night

一个适用于 [pi](https://github.com/earendil-works/pi) 的 Tokyo Night 主题与扩展，为终端带来 Tokyo Night 配色、Powerline 风格状态栏和动态雨景面板。

[![npm 版本](https://img.shields.io/npm/v/%40wishx127%2Fpi-tokyo-night?logo=npm)](https://www.npmjs.com/package/@wishx127/pi-tokyo-night)
[![npm 下载量](https://img.shields.io/npm/dm/%40wishx127%2Fpi-tokyo-night?logo=npm)](https://www.npmjs.com/package/@wishx127/pi-tokyo-night)
[![许可证](https://img.shields.io/npm/l/%40wishx127%2Fpi-tokyo-night)](LICENSE)

[English](README.md) · [npm](https://www.npmjs.com/package/@wishx127/pi-tokyo-night)

<p>
  <img src="assets/screenshot.png" alt="pi-tokyo-night" width="1100">
</p>

## ✨ 功能

**Tokyo Night 主题** —— 为 pi TUI 提供完整配色，覆盖编辑器、消息、语法高亮、差异视图、工具输出和 Markdown 渲染。

**Powerline 状态栏** —— 左侧为紫色渐变区域，显示模型、思考等级、路径和 Git 分支；右侧显示 tokens、费用和上下文进度条。

**动态雨景面板** —— 编辑器上方的 Tokyo 夜空，包含缓缓飘落的青色雨滴、新月和紫色星星，可在运行时切换开关。

**无边框编辑器** —— 编辑器可渲染在可选的圆角卡片边框内，并配有发光的紫色提示符箭头。

**Neon Studio** —— 分组且非覆盖式的设置中心，支持主题选择，并可实时调整边框、雨景、配额、图标和状态模块。

## 📦 安装

```bash
pi install npm:@wishx127/pi-tokyo-night
```

重启 pi 以启用主题和扩展。

## 🛠 使用

安装后会自动启用。使用 `/tokyo-night` 控制扩展：

```
/tokyo-night          # 打开 Neon Studio
/tokyo-night on       # 启用雨景面板
/tokyo-night off      # 禁用雨景面板
```

只有在启用 `codexQuota`，且当前会话使用通过 `transport=sse` 连接的 Codex 兼容模型时，状态栏才会显示 Codex 用量。

只有在启用 `kimiQuota`，且当前会话使用 `kimi-coding` 模型时，状态栏才会显示 Kimi Code 用量（5 小时滚动窗口和每周配额）。

### 状态栏模块

| 位置 | 模块       | 说明                                                                  |
| ---- | ---------- | --------------------------------------------------------------------- |
| 左侧 | 模型       | 当前 AI 模型名称                                                      |
| 左侧 | 思考       | 思考等级（off / minimal / low / medium / high / xhigh）               |
| 左侧 | 路径       | 缩短后的工作目录                                                      |
| 左侧 | 分支       | 当前 Git 分支（非 Git 仓库时隐藏）                                   |
| 右侧 | Codex 限额 | Codex 配额/重置状态（仅限 SSE + Codex 兼容模型）                      |
| 右侧 | Kimi 限额  | Kimi Code 5 小时窗口、每周配额与重置倒计时（仅限 `kimi-coding`）       |
| 右侧 | Tokens     | 累计输入和输出 token 数量                                             |
| 右侧 | 费用       | 会话费用                                                              |
| 右侧 | 进度       | 带百分比的上下文窗口使用进度条                                        |

### Neon Studio

使用 `/tokyo-night` 打开 Neon Studio。Neon Studio 使用 Pi 的标准自定义 UI 区域，而不是覆盖层，因此在预览设置时，Rain 和 Status 小组件仍会保持可见。Rain、Neon Studio 和 Status 共用一个连续的外框，不会堆叠嵌套卡片。

| 分组   | 设置                                                     |
| ------ | -------------------------------------------------------- |
| 外观   | 自动/深色/浅色主题、顶部面板、界面边框、状态图标         |
| 状态   | 模型、思考、路径、Git 分支、提供商限额、Tokens、费用、上下文 |
| 用量   | Codex 限额、Kimi 限额                                    |
| 雨景   | 雨景模式、行数；手动模式还包括刷新间隔和最大雨滴数       |

扩展设置会持久化到扩展专属文件中：

- **Windows：** `%USERPROFILE%\.pi\agent\extensions\pi-tokyo-night.json`
- **macOS / Linux：** `~/.pi/agent/extensions/pi-tokyo-night.json`

首次运行时，现有设置会自动复制到此文件。Neon Studio 会实时应用扩展设置以及固定的深色/浅色主题；自动主题会在重启 Pi 后生效。该文件仍可手动编辑，未指定的状态模块默认启用。手动编辑的值会在下一次启动 Pi 时加载：

```json
{
  "panel": true,
  "editorFrame": true,
  "codexQuota": false,
  "kimiQuota": true,
  "iconMode": "nerd",
  "statusModules": {
    "model": true,
    "thinking": true,
    "path": true,
    "git": true,
    "quota": true,
    "tokens": true,
    "cost": true,
    "context": true
  },
  "rainMode": "auto",
  "rainRows": 3,
  "rainTickMs": 130,
  "maxRainDrops": 25
}
```

## 🌗 浅色 / 深色自动切换

此软件包包含两个主题：`tokyo-night-dark` 和 `tokyo-night-light`。

你也可以通过 Pi 的 `/settings` 界面配置这两个主题变体。手动配置时，请在 `~/.pi/agent/settings.json` 中设置 Pi 自身的 `theme` 配置，而不是 Tokyo Night 扩展配置，并按 `<light-theme>/<dark-theme>` 的顺序填写：

```json
{
  "theme": "tokyo-night-light/tokyo-night-dark"
}
```

第一个名称用于浅色终端，第二个名称用于深色终端。Pi 会在启动时检测终端背景。若希望固定使用某个变体，也可以在 `/settings` 中单独选择该主题。

### 自定义颜色

编辑主题文件即可修改任意颜色。所有颜色变量都定义在 `vars` 代码块中：

```json
{
  "vars": {
    "cyan": "#7dcfff",
    "blue": "#7aa2f7",
    "green": "#9ece6a",
    ...
  }
}
```

主题位置：

- **Windows：** `%USERPROFILE%\.pi\agent\npm\node_modules\@wishx127\pi-tokyo-night\themes\tokyo-night-dark.json`
- **macOS / Linux：** `~/.pi/agent/npm/node_modules/@wishx127/pi-tokyo-night/themes/tokyo-night-dark.json`

## 📌 环境要求

- [Pi Coding Agent](https://github.com/earendil-works/pi) `>=0.80.5`
- 支持 24-bit 真彩色的终端
- [Nerd Font](https://www.nerdfonts.com/)，用于显示图标（可选）

## 🤝 参与贡献

欢迎贡献！你可以提交 Pull Request。

如需报告问题或提出功能请求，请提交 issue。

## 许可证

MIT
