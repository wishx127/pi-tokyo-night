import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  formatStatus,
  getSnapshot,
  isCodexModel,
} from "./codex-usage";
import type { TokyoConfigManager } from "./config";
import { handleExtensionError } from "./errors";
import {
  bgRgb,
  fgRgb,
  RESET_BG,
  RESET_FG,
} from "./ui-primitives";

// Left module gradient (deep → light purple)
// NOTE: Not `as const` — mutable number[][] needed for Module type compatibility.
const MODULE_BG: number[][] = [
  [45, 27, 105], // Deep purple   #2d1b69
  [61, 43, 122], // Medium purple #3d2b7a
  [77, 59, 138], // Lighter purple #4d3b8a
  [93, 75, 154], // Light purple  #5d4b9a
];

const MODULE_FG: number[][] = [
  [200, 200, 255],
  [220, 220, 255],
  [240, 240, 255],
  [255, 255, 255],
];

// Right module colors
const TOKENS_BG = [109, 91, 170]; // Very light purple #6d5baa
const COST_BG = [93, 93, 93]; // Gray #5d5d5d
const CODEX_BG = [101, 83, 162]; // Mid purple — between branch and tokens backgrounds

type Module =
  | { text: string; bg: number; fg: number }
  | { text: string; bgColor: number[] | null; textColor: number[] };

const getModuleBg = (m: Module): number[] | null =>
  "bg" in m ? MODULE_BG[m.bg] : m.bgColor;
const getModuleFg = (m: Module): number[] =>
  "fg" in m ? MODULE_FG[m.fg] : m.textColor;

// Powerline transition arrow between two modules (1-char wide)
const buildTransition = (from: Module, to: Module): string => {
  const c1 = getModuleBg(from);
  const c2 = getModuleBg(to);
  const bg = c2 === null ? RESET_BG : bgRgb(c2);
  const fg = c1 === null ? RESET_FG : fgRgb(c1);
  return `${bg}${fg}\uE0B0${RESET_BG}${RESET_FG}`;
};

// Build a section (array of modules) with Powerline transitions
const buildSection = (modules: Module[]) => {
  let result = "";
  let currentWidth = 0;

  for (let i = 0; i < modules.length; i++) {
    const m = modules[i];
    const bgColor = getModuleBg(m);
    const textColor = getModuleFg(m);

    const bgCode = bgColor === null ? RESET_BG : bgRgb(bgColor);
    const fgCode = fgRgb(textColor);

    // Powerline transition before module (except first)
    if (i > 0) {
      result += buildTransition(modules[i - 1], m);
      currentWidth += 1;
    }

    const moduleText = ` ${m.text} `;
    result += `${bgCode}${fgCode}${moduleText}${RESET_BG}${RESET_FG}`;
    currentWidth += visibleWidth(moduleText);
  }

  return { result, currentWidth };
};

export function buildStatusLine(
  width: number,
  theme: Theme,
  ctx: ExtensionContext,
  branch: string,
  thinkingLevel: string,
  config: TokyoConfigManager,
): string {
  // Use a slightly smaller width to account for potential width miscalculations
  // with Nerd Font glyphs that may be rendered as double-width by the terminal
  // but counted as single-width by visibleWidth()
  const safeWidth = Math.max(1, width - 2);
  let input = 0,
    output = 0,
    cost = 0;
  try {
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        input += m.usage.input;
        output += m.usage.output;
        cost += m.usage.cost.total;
      }
    }
  } catch (err) {
    handleExtensionError(err, "session stats");
  }

  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  const fmtCost = (c: number) =>
    c < 0.01 ? `${c.toFixed(3)}` : `${c.toFixed(2)}`;

  const modelId = ctx.model?.id || ctx.model?.name || "pi-agent";

  const cwd = ctx.cwd;

  const totalTokens = input + output;
  let maxCtx = 128000;
  if (ctx.model?.contextWindow) maxCtx = ctx.model.contextWindow;
  const pct =
    totalTokens > 0
      ? Math.min(100, Math.round((totalTokens / maxCtx) * 100))
      : 0;

  const barColor = pct >= 50 ? "error" : pct >= 30 ? "warning" : "accent";
  const filled = Math.round((pct / 100) * 8);
  const progressBar =
    theme.fg(barColor, "█".repeat(filled)) +
    theme.fg("dim", "░".repeat(8 - filled));

  // Build left modules (model, thinking, path, branch) - purple gradient
  const leftModules = [
    { text: `\uE795 ${shortName(modelId)}`, bg: 0, fg: 0 },
    { text: `⚡ ${thinkingLevel}`, bg: 1, fg: 1 },
    { text: `\uF07B ${shortenPath(cwd)}`, bg: 2, fg: 2 },
    ...(branch ? [{ text: `\uE0A0 ${branch}`, bg: 3, fg: 3 }] : []),
  ];

  // Codex subscription usage (only when directly connected to official Codex/GPT)
  const codexSnapshot =
    config.get().codexQuota && isCodexModel(ctx.model) ? getSnapshot() : undefined;
  const codexModule = codexSnapshot
    ? [{
        text: `LIMIT ${formatStatus(codexSnapshot)}`,
        bgColor: CODEX_BG as number[],
        textColor: [245, 240, 255] as number[],
      }]
    : [];

  // Build right modules (codex usage, tokens, cost, progress)
  const rightModules = [
    ...codexModule,
    {
      text: `Σ ${fmt(totalTokens)} tokens`,
      bgColor: TOKENS_BG as number[],
      textColor: [255, 255, 200] as number[],
    },
    {
      text: `$${fmtCost(cost)}`,
      bgColor: COST_BG as number[],
      textColor: [200, 255, 200] as number[],
    },
    {
      text: `${progressBar} ${pct}%/${fmt(maxCtx)}`,
      bgColor: null as number[] | null,
      textColor: [255, 200, 200] as number[],
    },
  ];

  const leftSection = buildSection(leftModules);
  const rightSection = buildSection(rightModules);

  // Padding uses last left module's bg color
  const lastLeftBg = getModuleBg(leftModules[leftModules.length - 1]);
  const paddingBgCode = lastLeftBg === null ? RESET_BG : bgRgb(lastLeftBg);

  // Bridge transition from padding to first right module
  const bridgeTransition = buildTransition(
    leftModules[leftModules.length - 1],
    rightModules[0],
  );

  const paddingWidth = Math.max(
    1,
    safeWidth - leftSection.currentWidth - 1 - rightSection.currentWidth,
  );
  const padding = `${paddingBgCode}${" ".repeat(paddingWidth)}${RESET_BG}`;

  return truncateToWidth(
    leftSection.result + padding + bridgeTransition + rightSection.result,
    width,
  );
}

export function shortName(id: string): string {
  if (!id || id === "pi-agent") return "pi-agent";
  return id.length > 30 ? id.slice(0, 28) + ".." : id;
}

export function shortenPath(p: string): string {
  if (!p) return ".";
  // Replace home directory with ~
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home && p.startsWith(home)) {
    p = "~" + p.slice(home.length);
  }
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 4) return p;
  return "~/…/" + parts.slice(-2).join("/");
}
