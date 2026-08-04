# pi-tokyo-night

A [pi](https://github.com/earendil-works/pi) theme + extension that brings the tokyo-night color scheme to your terminal, with a Powerline-style status bar and an animated panel.

<p>

  <img src="assets/screenshot.png" alt="pi-tokyo-night" width="1100">

</p>

## ✨ Features

**Tokyo Night theme** — Full color scheme for the pi TUI: editor, messages, syntax highlighting, diff view, tool output, and markdown rendering.

**Powerline status bar** — Purple gradient left section (model, thinking level, path, git branch) and right section (tokens, cost, context progress bar).

**Animated rain panel** — A Tokyo night sky above the editor with drifting cyan raindrops, a crescent moon, and purple stars. Toggle on/off at runtime.

**Borderless editor** — Editor renders inside an optional rounded card frame with a glowing purple prompt chevron.

**Settings UI** — Interactive settings panel to tweak rain animation (rows, speed, drop count) without editing config files.

## 📦 Install

```bash
pi install npm:@wishx127/pi-tokyo-night
```

Restart pi to activate.

## 🛠 Usage

Activates automatically on install. Use `/tokyo-night` to control the extension:

```
/tokyo-night          # toggle settings panel
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


### Settings panel

Open with `/tokyo-night`, then navigate with ↑/↓ and press Enter to toggle or edit values. Press Esc to save and close.


| Setting        | Default | Description                                                         |
| -------------- | ------- | ------------------------------------------------------------------- |
| Top Panel      | On      | Show rain/moon/stars above editor                                   |
| Input Frame    | On      | Show the rounded frame around the input editor                      |
| Codex Limit    | Off     | Show Codex quota in the status bar (requires Pi transport=sse)      |
| Kimi Limit     | On      | Show Kimi Code 5h/weekly quota in the status bar (polls usages API) |
| Status Icons   | Nerd    | Use Nerd Font or ASCII icons in the status bar                     |
| Rain Rows      | 3       | Height of rain panel (1–10)                                         |
| Rain Tick (ms) | 130     | Animation speed (50–1000)                                           |
| Max Rain Drops | 25      | Simultaneous drops (5–100)                                          |


Settings are persisted to `~/.pi/agent/settings.json` under the `pi-tokyo-night` key. Status module visibility is configured directly in this file; omitted module keys default to `true` and changes take effect on the next Pi session:

```json
{
  "pi-tokyo-night": {
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
}
```

## 🌗 Light / Dark auto-switching

The package ships two themes: `tokyo-night-dark` and `tokyo-night-light` .

To let pi follow your terminal's light/dark mode automatically, set the theme in `~/.pi/agent/settings.json` with the `light/dark` syntax:

```json
{
  "theme": "tokyo-night-light/tokyo-night-dark"
}
```

Pi detects the terminal background on startup and live-switches when your terminal changes color scheme. Pick either name alone via `/settings` if you prefer to pin one variant.

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

- **Windows:** `%USERPROFILE%\.pi\agent\node_modules\@wishx127\pi-tokyo-night\themes\tokyo-night-dark.json`
- **macOS / Linux:** `~/.pi/agent/node_modules/@wishx127/pi-tokyo-night/themes/tokyo-night-dark.json`

## 📌 Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi)
- Terminal with 24-bit true color support
- [Nerd Font](https://www.nerdfonts.com/) for icons (optional)

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

For bug reports and feature requests, open an issue.

## License

MIT
