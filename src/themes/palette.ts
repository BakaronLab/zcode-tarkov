/**
 * The single source of truth for the Tarkov colours.
 *
 * Two things live here and they are deliberately separate:
 *
 *  - `DEFAULT_PALETTE` — the hand-tuned values the theme shipped with. When the
 *    user has not overridden anything, this object is returned untouched, so the
 *    generated CSS is identical to what this release produced before the
 *    palette became editable. (The accent itself moved in v0.2, `#e07930` →
 *    `#ee8a3a`; that change is separate from this one and is in the changelog.)
 *    That matters: a derivation formula, however principled, would have shifted
 *    the colours of every existing install on upgrade.
 *  - `resolvePalette(overrides)` — the same shape, derived from a background
 *    and an accent the user chose. It is only consulted when a colour has
 *    actually been customised.
 *
 * A note on provenance, because it is easy to overclaim: no official
 * Escape from Tarkov hex palette has been published by Battlestate Games, so
 * `#ee8a3a` is NOT an "official EFT orange". It is this project's own accent,
 * chosen in the warm-orange direction the theme is built around and picked so
 * that near-black ink stays comfortably readable on it.
 */

/** The Tarkov accent. Every accent surface in the product resolves to this. */
export const TARKOV_ACCENT = "#ee8a3a";

/** The same accent as an `r, g, b` triple, for compositing at arbitrary alpha. */
export const TARKOV_ACCENT_RGB = "238, 138, 58";

/** Near-black ink used for text painted on the accent band. */
export const TARKOV_INK = "#1c1207";

/** The ink above, as an `r, g, b` triple. */
export const TARKOV_INK_RGB = "28, 18, 7";

/** The default surface colour, and the value the background picker starts on. */
export const TARKOV_BACKGROUND = "#1c1207";

/** Every colour the theme needs, in the form the token builders consume. */
export interface PaletteColors {
  /** Primary accent: borders, focus rings, active states, the band. */
  accent: string;
  /** The accent as an `r, g, b` triple, for inline alpha compositing. */
  accentRgb: string;
  /** Deepest tone, as a hex; used directly for the terminal background. */
  deep: string;
  /**
   * The same tone as an `r, g, b` triple.
   *
   * Both forms are needed and mixing them is a real bug: `rgba()` takes the
   * triple, so interpolating the hex into it produced
   * `rgba(#140d04, 0.5)` — an invalid token stream that a `var()` consumer
   * resolves to "invalid at computed-value time" rather than to a colour.
   */
  deepRgb: string;
  /** Base background. */
  background: string;
  /** Main panel tone, as an `r, g, b` triple. */
  panelRgb: string;
  /** Secondary panel tone. */
  panelAltRgb: string;
  /** Raised surface (cards). */
  raisedRgb: string;
  /** Popover / menu surface, kept more opaque for legibility. */
  popoverRgb: string;
  /** Primary text, chosen for contrast against the panel surfaces. */
  text: string;
  /**
   * Text for the popover and tooltip surfaces, which sit further from the
   * background than the panels do.
   *
   * Its own ink because one ink cannot serve the whole ramp: the panels and the
   * popovers can end up on opposite sides of the luminance that a single colour
   * can cover, and then no shared choice clears the bar on both. The theme
   * already has separate tokens here — this is what makes them independent.
   */
  popoverText: string;
  /** Warm emphasis. */
  highlight: string;
  /** Warning emphasis. */
  warning: string;
  /** Muted text. */
  muted: string;
  /** Muted text as an `r, g, b` triple. */
  mutedRgb: string;
  /**
   * Ink for text on a **solid** accent surface — a filled button, a badge.
   * Chosen by contrast against the accent, so a pale accent gets dark text.
   */
  onAccent: string;
  /**
   * Ink for text on the translucent accent **band** (the top warning strip and
   * the empty-chat notice).
   *
   * Separate from `onAccent` because the band is not the accent: it is the
   * accent *composited over the background* at the band's opacity, which is a
   * considerably darker colour and can want the opposite ink.
   */
  bandInk: string;
}

/**
 * The shipped palette: unchanged from the version this module was extracted
 * from, so an install that customises nothing looks exactly as it did.
 */
export const DEFAULT_PALETTE: PaletteColors = {
  accent: TARKOV_ACCENT,
  accentRgb: TARKOV_ACCENT_RGB,
  deep: "#140d04",
  deepRgb: "20, 13, 4",
  background: TARKOV_BACKGROUND,
  panelRgb: "26, 18, 10",
  panelAltRgb: "30, 20, 10",
  raisedRgb: "42, 29, 16",
  popoverRgb: "46, 32, 18",
  text: "#e8d9c8",
  highlight: "#ffd7ae",
  warning: "#ffb27a",
  muted: "#8b877c",
  mutedRgb: "139, 135, 124",
  // Both match what the shipped theme already painted: dark ink on the accent,
  // and the reference project's #111111 on the band. They are held as constants
  // rather than recomputed so the default render stays byte-identical — the
  // contrast logic below only runs once a colour has actually been chosen.
  onAccent: "#1c1207",
  bandInk: "#111111",
  // Matches what the popover foreground already resolved to, so the shipped
  // render is unchanged.
  popoverText: "#e8d9c8",
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parses `#rgb` or `#rrggbb` (with or without the hash) into channels.
 *
 * Returns undefined for anything else, so a caller can tell "not a colour" from
 * "black" — which is the difference between falling back to the default and
 * silently rendering the whole UI black.
 */
export function parseHex(value: unknown): Rgb | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return {
      r: Number.parseInt(raw[0] + raw[0], 16),
      g: Number.parseInt(raw[1] + raw[1], 16),
      b: Number.parseInt(raw[2] + raw[2], 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
    };
  }
  return undefined;
}

/** `#rrggbb`, lower-case, so two spellings of one colour compare equal. */
export function toHex({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** The channel triple in the unbracketed form the CSS builders interpolate. */
export function toTriple({ r, g, b }: Rgb): string {
  const part = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return `${part(r)}, ${part(g)}, ${part(b)}`;
}

/**
 * Relative luminance, 0-1, using the sRGB coefficients.
 *
 * Only used to *rank* candidates here — never on its own to decide whether text
 * is readable. Luminance answers "how bright is this colour"; readability is a
 * question about a *pair*, which is what `contrastRatio` answers. Judging ink by
 * a luminance threshold against the background is the mistake this module used
 * to make: at a mid-grey background the threshold still chose the light ink, and
 * the measured result was 1.7:1.
 */
export function luminance({ r, g, b }: Rgb): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG 2.x contrast ratio between two colours, 1:1 to 21:1.
 *
 * The 4.5:1 bar is for body text and 3:1 for large text; the derived palette
 * aims at 4.5:1 for anything a user reads, and accepts 3:1 only for the
 * deliberately muted secondary tone.
 */
/** The two extremes every contrast decision is measured against. */
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };
export const WHITE: Rgb = { r: 255, g: 255, b: 255 };

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Snaps a colour to the integer channels it will actually be emitted as.
 *
 * Every triple leaves this module through `toTriple`, which rounds. Measuring
 * an unrounded colour and then painting the rounded one is a real off-by-one:
 * the contrast check passes on a value that never reaches the stylesheet, and
 * the rendered pair can miss the bar by a hundredth (measured: 4.48:1 against a
 * panel that had cleared 4.5 before rounding).
 */
export function roundRgb(color: Rgb): Rgb {
  return { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) };
}
/** `foreground` at `alpha` painted over `background`, as an opaque colour. */
export function compositeOver(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  const t = Math.min(1, Math.max(0, alpha));
  return {
    r: foreground.r * t + background.r * (1 - t),
    g: foreground.g * t + background.g * (1 - t),
    b: foreground.b * t + background.b * (1 - t),
  };
}

/**
 * The candidate that reads better on `background`.
 *
 * This is the whole contrast strategy: rather than asking "is the background
 * light or dark?" and hoping the answer implies a readable ink, it measures
 * both candidates against the actual surface and takes the winner. A mid-tone
 * background has no good answer, but it still gets the better of the two
 * instead of whichever one its luminance happened to select.
 */
export function readableInk(background: Rgb, candidates: Rgb[]): Rgb {
  let best = candidates[0];
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/**
 * The candidate that clears `target` against **every** surface it will be
 * painted on.
 *
 * A single ink token is used on several surfaces of one ramp, and those
 * surfaces are not the same colour. Choosing against only the middle one left
 * the extremes short — a mid-dark grey background measured fine on the panel
 * and rendered 2.86:1 on the popover. This prefers the candidate with the best
 * *worst-case* ratio, so the choice is made by the surface that hurts most.
 */
export function readableInkAll(backgrounds: Rgb[], candidates: Rgb[]): Rgb {
  const worstCase = (candidate: Rgb) =>
    Math.min(...backgrounds.map((background) => contrastRatio(candidate, background)));
  let best = candidates[0];
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = worstCase(candidate);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return best;
}

/**
 * Blends `color` toward `base` until its luminance is within [min, max].
 *
 * The reason this exists: a single ink token is painted on several surfaces, and
 * one ink can only clear 4.5:1 across a bounded band of luminance. Against a
 * colour with luminance L, a light ink gives at best 1.05/(L+0.05) and a dark ink
 * at best 20·L+1, so a light ink needs every surface below ~0.183 and a dark ink
 * needs every surface above ~0.175. A ramp that runs past the band cannot be
 * covered by any single colour, and no amount of searching for a better ink will
 * help — the spread itself has to give way.
 *
 * The returned colour is the closest one to `color` that fits, so the ramp keeps
 * as much separation as the readability bar allows rather than a fixed amount.
 */
function clampLuminance(color: Rgb, base: Rgb, min: number, max: number): Rgb {
  const fits = (candidate: Rgb) => {
    const l = luminance(candidate);
    return l >= min && l <= max;
  };
  if (fits(color)) return color;
  // Bisect on the blend factor rather than walking toward the base in steps.
  // A fixed step converges faster in channel values than in luminance, so it
  // stops short: 24 steps of 5% toward a mid-grey background left a surface at
  // 0.191 when the band allowed 0.17, and the ink chosen for it then measured
  // 4.43:1. Bisection finds the closest fitting blend in a fixed 24 iterations
  // regardless of how the curve behaves.
  let lo = 0;
  let hi = 1;
  // Falls back to the colour itself, not to the background: if no blend fits,
  // erasing the ramp would leave every surface identical to the page and the
  // theme without panels. Keeping the colour leaves the ink search to do its own
  // job, which is the lesser of the two failures.
  let best = color;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = compositeOver(base, color, mid);
    if (fits(candidate)) {
      best = candidate;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return roundRgb(best);
}

/**
 * Nudges `color` toward whichever extreme is farther from `backgrounds` until
 * it clears `target` against all of them.
 *
 * The extreme that is farthest from the *nearest* surface is the one to move
 * toward, because that is the surface the ink is already closest to and
 * therefore the one limiting the ratio.
 */
export function ensureContrastAll(color: Rgb, backgrounds: Rgb[], target: number): Rgb {
  const worstCase = (candidate: Rgb) =>
    Math.min(...backgrounds.map((background) => contrastRatio(candidate, background)));
  // Aim a little above the bar. The channel values are rounded to integers on
  // the way out, and rounding can move luminance far enough to drop a colour
  // that measured exactly 4.50 back below it — observed as 4.50:1 printed for a
  // pair that was really 4.486:1. A 1% margin costs nothing perceptible and
  // makes the stated bar true of the value that is painted.
  const aim = target * 1.01;
  if (worstCase(color) >= aim) return color;

  // Pick the direction by the surface that limits us, not by the ramp as a
  // whole: with a light ink the lightest surface is the constraint, so white is
  // the way out; with a dark ink it is the darkest one and black is.
  const extreme = worstCase(WHITE) >= worstCase(BLACK) ? WHITE : BLACK;
  let current = color;
  for (let i = 0; i < 24 && worstCase(current) < aim; i += 1) {
    current = compositeOver(extreme, current, 0.25);
  }
  return worstCase(current) >= aim ? current : extreme;
}
/**
 * Nudges `color` toward whichever extreme is farther from `background` until
 * it clears `target`.
 *
 * Moving in steps keeps as much of the tone's character as the bar allows,
 * which matters for the muted and warning accents: slamming them to pure white
 * or black would clear the ratio and lose the colour.
 */
export function ensureContrast(color: Rgb, background: Rgb, target: number): Rgb {
  // The same 1% margin as `ensureContrastAll`, for the same rounding reason.
  const aim = target * 1.01;
  if (contrastRatio(color, background) >= aim) return color;
  // Move toward whichever extreme is *farther* from the background. Measuring
  // rather than testing a luminance threshold matters here too: against a
  // mid-grey the farther extreme is white, and a threshold would have picked
  // black and made the text worse with every step.
  const extreme = contrastRatio(WHITE, background) >= contrastRatio(BLACK, background) ? WHITE : BLACK;
  let current = color;
  for (let i = 0; i < 24 && contrastRatio(current, background) < aim; i += 1) {
    current = compositeOver(extreme, current, 0.25);
  }
  // No colour can be far from both extremes — the worst case for black is
  // 20·L+1 and for white 1.05/(L+0.05), and every luminance clears one of them —
  // so landing on the extreme is a guaranteed floor rather than a last resort.
  return contrastRatio(current, background) >= aim ? current : extreme;
}
/** Mixes toward white (positive) or black (negative) by a fraction of the way. */
function shift(color: Rgb, amount: number): Rgb {
  const target = amount >= 0 ? 255 : 0;
  const t = Math.min(1, Math.abs(amount));
  return {    r: color.r + (target - color.r) * t,
    g: color.g + (target - color.g) * t,
    b: color.b + (target - color.b) * t,
  };
}

export interface PaletteOverrides {
  /** Base background, as a hex string. Invalid input falls back to the default. */
  background?: unknown;
  /** Accent, as a hex string. Invalid input falls back to the default. */
  accent?: unknown;
}

/** True when neither colour was customised, so the shipped palette applies. */
export function isDefaultPalette(overrides: PaletteOverrides): boolean {
  const background = parseHex(overrides.background);
  const accent = parseHex(overrides.accent);
  const defaultBackground = parseHex(TARKOV_BACKGROUND)!;
  const defaultAccent = parseHex(TARKOV_ACCENT)!;
  const sameBackground = !background || toHex(background) === toHex(defaultBackground);
  const sameAccent = !accent || toHex(accent) === toHex(defaultAccent);
  return sameBackground && sameAccent;
}

/**
 * The palette to render with.
 *
 * Returns the shipped palette untouched when nothing was customised — that is
 * the whole reason this returns a constant rather than always deriving. When a
 * colour *was* chosen, the ramp is derived from it and **every ink is chosen by
 * measured contrast** against the surface it will sit on.
 *
 * That last part is the important one, and it is not the obvious implementation.
 * Asking "is the background light or dark?" and picking the text accordingly
 * fails in the middle: a mid-grey background passes a luminance threshold either
 * way while the ink on the other side of it is unreadable, and a grey is exactly
 * what someone reaches for first in a colour picker. Measuring the pair instead
 * means a mid-tone background gets the *better* of the two inks rather than the
 * one a threshold happened to select, and the same treatment is applied to the
 * text on the accent and on the beta band, where the band's real colour is the
 * accent composited over the background rather than the accent alone.
 */
export function resolvePalette(overrides: PaletteOverrides = {}): PaletteColors {
  if (isDefaultPalette(overrides)) return DEFAULT_PALETTE;

  const background = parseHex(overrides.background) ?? parseHex(TARKOV_BACKGROUND)!;
  const accent = parseHex(overrides.accent) ?? parseHex(TARKOV_ACCENT)!;
  const light = luminance(background) > 0.4;

  // Panels move *away* from the background so a surface is always distinguishable
  // from the page behind it, whichever direction the background sits.
  // Which ink can serve the page is decided by **measuring** black and white
  // against the background, not by a lightness threshold. A threshold gets the
  // mid-tones wrong in a way that costs twice: at L≈0.3 it calls the page "dark"
  // and picks the light ink, when black actually measures 7.9:1 there and white
  // 2.7:1 — and it then aims the ramp away from the band that ink needs, so every
  // surface is clamped back onto the page colour and the panel, card and popover
  // tones stop being distinguishable at all (measured: 65 of 256 greys produced
  // four identical surfaces).
  const inkIsDark = contrastRatio(BLACK, background) >= contrastRatio(WHITE, background);
  // The band that ink can cover. The margin is for rounding: a light ink needs
  // every surface at or below ~0.183 and a dark one at or above ~0.175, and
  // clamping to those exact figures left 4.49:1 once the channels were rounded to
  // integers.
  const band = inkIsDark ? { min: 0.18, max: 1 } : { min: 0, max: 0.165 };
  // Surfaces move *deeper into that band*, which is the direction away from the
  // ink. Moving away from the background instead is what collapsed them: for a
  // page just outside the band there is no blend that fits, and the clamp then
  // returned the page colour for every surface.
  const toward = inkIsDark ? 1 : -1;
  // Rounded first, so the measurement is against the colour that is emitted, and
  // clamped into the band so the ink chosen below can always clear the bar.
  const fit = (shifted: Rgb) => clampLuminance(roundRgb(shifted), background, band.min, band.max);
  const surface = fit(shift(background, 0.05 * toward));
  const panel = fit(shift(background, 0.1 * toward));
  const raised = fit(shift(background, 0.22 * toward));
  const popover = fit(shift(background, 0.28 * toward));

  // **Every** surface this ink is painted on, not just the middle one.
  //
  // A single `text` value is used for foreground, popover-foreground and
  // tooltip-foreground, and those sit on three different tones. Measuring it
  // against only the middle one left the extreme surfaces short: a mid-dark grey
  // background put 2.86:1 text on the popover while the panel measured fine. The
  // ink has to clear the bar against the *worst* of them, which is the one
  // closest to the ink itself — a light ink suffers most on the lightest surface,
  // and vice versa. Choosing per-surface inks instead would mean three text
  // tokens where the theme has one, which is a bigger change than the problem
  // warrants.
  // The panel-side surfaces a foreground token is painted on. The popover is
  // excluded here and given its own ink below: the ramp can straddle the
  // luminance a single colour can cover, so a shared choice would leave one end
  // short (measured: 2.65:1 on the outermost panel for a mid-dark grey).
  const textSurfaces = [surface, panel, raised];
  const text = ensureContrastAll(
    readableInkAll(textSurfaces, [parseHex("#e8d9c8")!, parseHex("#1b1410")!]),
    textSurfaces,
    4.5
  );
  // Secondary text is allowed the large-text bar; it is deliberately quieter.
  const muted = ensureContrastAll(
    readableInkAll(textSurfaces, [parseHex("#8b877c")!, parseHex("#5c5348")!]),
    textSurfaces,
    3
  );
  // Emphasis tones keep their relationship to the accent but must still read.
  const highlight = ensureContrastAll(
    readableInkAll(textSurfaces, [shift(accent, 0.65), shift(accent, -0.3)]),
    textSurfaces,
    4.5
  );
  const warning = ensureContrastAll(
    readableInkAll(textSurfaces, [shift(accent, 0.45), shift(accent, -0.2)]),
    textSurfaces,
    4.5
  );

  // Ink for text sitting on the accent itself. Picked by measurement and then
  // nudged until it clears the body-text bar: at a mid-grey accent the better of
  // the two candidates is only 4.47:1, which is short of 4.5, and the fix for
  // that is to keep moving rather than to accept the nearest miss. One of the
  // extremes always reaches the bar, because no colour can be far from both
  // black and white.
  // The popover and tooltip surfaces get their own ink, measured against
  // themselves. This is what the two separate tokens are for.
  const popoverText = ensureContrastAll(
    readableInkAll([popover], [parseHex("#e8d9c8")!, parseHex("#1b1410")!]),
    [popover],
    4.5
  );

  const onAccent = ensureContrast(readableInk(accent, [parseHex("#0d0a06")!, parseHex("#ffffff")!]), accent, 4.5);
  // Ink for the empty-chat notice's band, whose real colour is the accent
  // composited over the page at the notice's own opacity — not the accent alone.
  // A dark accent would otherwise leave near-black text on a near-black band,
  // which makes the beta warning unreadable and defeats its only purpose.
  const noticeSurface = roundRgb(compositeOver(accent, background, 0.62));
  const bandInk = ensureContrast(
    readableInk(noticeSurface, [parseHex("#111111")!, parseHex("#ffffff")!]),
    noticeSurface,
    4.5
  );

  return {
    accent: toHex(accent),
    accentRgb: toTriple(accent),
    deep: toHex(roundRgb(shift(background, -0.3 * (light ? -1 : 1)))),
    deepRgb: toTriple(roundRgb(shift(background, -0.3 * (light ? -1 : 1)))),
    background: toHex(background),
    panelRgb: toTriple(surface),
    panelAltRgb: toTriple(panel),
    raisedRgb: toTriple(raised),
    popoverRgb: toTriple(popover),
    text: toHex(text),
    popoverText: toHex(popoverText),
    highlight: toHex(highlight),
    warning: toHex(warning),
    muted: toHex(muted),
    mutedRgb: toTriple(muted),
    onAccent: toHex(onAccent),
    bandInk: toHex(bandInk),
  };
}

/**
 * Composes the accent at an alpha, so translucent accent surfaces (hover
 * washes, borders, selected states) all track the one accent value.
 */
export function accentAlpha(alpha: number, palette: PaletteColors = DEFAULT_PALETTE): string {
  if (alpha >= 1) return `rgb(${palette.accentRgb})`;
  const rounded = Math.round(alpha * 100) / 100;
  return `rgba(${palette.accentRgb}, ${rounded})`;
}
