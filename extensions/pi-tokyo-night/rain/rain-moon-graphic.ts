import { readFileSync } from "node:fs";
import { getCellDimensions } from "@earendil-works/pi-tui";

export interface RainMoonGraphic {
  readonly columns: number;
  readonly sequence: string;
}

const pngByTheme = new Map<string, string>();

/** Keep the authored pixels at their native size inside the two sky rows. */
export function getAmberMoonGraphic(themeName: string | undefined, imageId: number): RainMoonGraphic | undefined {
  const theme = themeName === "tokyo-night-light" ? "light"
    : themeName === "tokyo-night-dark" ? "dark" : undefined;
  if (!theme) return undefined;
  const { widthPx, heightPx } = getCellDimensions();
  if (!(widthPx > 0) || !(heightPx >= 14)) return undefined;

  let png = pngByTheme.get(theme);
  if (png === undefined) {
    try {
      png = readFileSync(new URL(`../../../assets/rain-moon/${theme}.png`, import.meta.url), "base64");
    } catch {
      png = "";
    }
    pngByTheme.set(theme, png);
  }
  if (!png) return undefined;
  return {
    columns: Math.ceil(24 / widthPx),
    // Transmit and place at the native pixel size. The ID lets Pi erase or redraw the image.
    sequence: `\x1b_Ga=T,f=100,q=2,C=1,i=${imageId};${png}\x1b\\`,
  };
}
