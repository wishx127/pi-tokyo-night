# pi-tokyo-night

A [pi](https://github.com/earendil-works/pi) theme + extension that brings the tokyo-night color scheme to your terminal, with a Powerline-style status bar and animated rain panel.

<p>
  <img src="assets/screenshot.png" alt="pi-tokyo-night" width="1100">
</p>

## ✨ Features

**Tokyo Night theme** — Full color scheme for the pi TUI: editor, messages, syntax highlighting, diff view, tool output, and markdown rendering.

**Powerline status bar** — Purple gradient left section (model, thinking level, path, git branch) and right section (tokens, cost, context progress bar).

**Animated rain panel** — A Tokyo night sky above the editor with drifting cyan raindrops, a crescent moon, and purple stars. Toggle on/off at runtime.

**Borderless editor** — Editor renders inside an optional rounded card frame with a glowing purple prompt chevron.

**Neon Studio** — Grouped, non-overlay settings center with local theme preview and live frame, rain, quota, icon, and status-module updates.

## 📦 Install

```bash
pi install npm:@wishx127/pi-tokyo-night
```

Restart pi to activate.

## 🛠 Usage

Activates automatically on install. Use `/tokyo-night` to control the extension:

```
/tokyo-night          # open Neon Studio
/tokyo-night on       # enable the rain panel
/tokyo-night off      # disable the rain panel
```

Codex usage is shown in the status bar only when `codexQuota` is enabled and the session is using a Codex-compatible model over `transport=sse`.

Kimi Code usage (5-hour rolling window + weekly quota) is shown in the status bar only when `kimiQuota` is enabled and the session is using a `kimi-coding` model.

### Status bar modules


| Position | Module      | Description                                                                       |
| -------- | ----------- | --------------------------------------------------------------------------------- |
| Left     | Model       | Current AI model name                                                             |
| Left     | Thinking    | Thinking level (off / minimal / low / medium / high / xhigh)                      |
| Left     | Path        | Shortened working directory                                                       |
| Left     | Branch      | Current Git branch (hidden when not in a repo)                                    |
| Right    | Codex Limit | Codex quota / reset status (SSE + Codex-compatible models only)                   |
| Right    | Kimi Limit  | Kimi Code 5h window + weekly quota with reset countdown (kimi-coding models only) |
| Right    | Tokens      | Cumulative input + output token count                                             |
| Right    | Cost        | Session cost                                                                      |
| Right    | Progress    | Context window usage bar with percentage                                          |


### Neon Studio

Open with `/tokyo-night`. Neon Studio uses Pi's standard custom UI area—not an overlay—so the Rain and Status widgets remain visible while settings are previewed. Rain, Neon Studio, and Status share one continuous outer frame instead of stacking nested cards.

| Section    | Settings                                                                 |
| ---------- | ------------------------------------------------------------------------ |
| Appearance | Theme preview, Top Panel, Interface Frame, Status Icons                 |
| Status     | Model, Thinking, Path, Git Branch, Provider Limit, Tokens, Cost, Context |
| Usage      | Codex Limit, Kimi Limit                                                 |
| Rain       | Rain Rows, Rain Tick, Max Rain Drops                                    |

Extension settings are persisted in an extension-owned file:

- **Windows:** `%USERPROFILE%\.pi\agent\extensions\pi-tokyo-night.json`
- **macOS / Linux:** `~/.pi/agent/extensions/pi-tokyo-night.json`

Existing settings are copied here automatically on first run. Neon Studio applies changes live; the file remains available for manual editing, with unspecified status modules enabled by default. Manually edited values are loaded on the next Pi start:

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
  "rainRows": 3,
  "rainTickMs": 130,
  "maxRainDrops": 25
}
```

## 🌗 Light / Dark auto-switching

The package ships two themes: `tokyo-night-dark` and `tokyo-night-light`.

All supported Pi versions can automatically switch between separate light and dark themes. Configure both variants through Pi's `/settings` screen. For manual configuration, set Pi's own `theme` setting—not the Tokyo Night extension config—in `~/.pi/agent/settings.json` using `<light-theme>/<dark-theme>` order:

```json
{
  "theme": "tokyo-night-light/tokyo-night-dark"
}
```

The first name is used for light terminals and the second for dark terminals. Pi detects the terminal background on startup and switches when the terminal color scheme changes. Select either theme by itself in `/settings` if you prefer to pin one variant.

### Customizing colors

Edit the theme file to change any color. All color variables are defined in the `vars` block:

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

Theme location:

- **Windows:** `%USERPROFILE%\.pi\agent\npm\node_modules\@wishx127\pi-tokyo-night\themes\tokyo-night-dark.json`
- **macOS / Linux:** `~/.pi/agent/npm/node_modules/@wishx127/pi-tokyo-night/themes/tokyo-night-dark.json`

## 📌 Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi) `>=0.80.5`
- Terminal with 24-bit true color support
- [Nerd Font](https://www.nerdfonts.com/) for icons (optional)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

For bug reports and feature requests, open an issue.

## License

MIT
