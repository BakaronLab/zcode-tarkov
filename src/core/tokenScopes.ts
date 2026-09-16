/**
 * The selector scopes ZCode reads its `--color-*` semantic tokens from.
 *
 * Verified against ZCode 3.11.2 (`out/renderer/assets/styles-t2tKjMWX.css` and
 * the renderer bundle): the renderer toggles classes on `document.documentElement`:
 *
 *   classList.toggle('dark',            theme === 'dark')
 *   classList.toggle('theme-zai-light', resolved === 'zai-light')
 *   classList.toggle('theme-zai-dark',  resolved === 'zai-dark')
 *
 * ZCode defines its own tokens inside `@layer theme`, while `.dark` and
 * `.theme-zai-*` sit *outside* any layer. Injected CSS is unlayered too, so it
 * wins over the layered defaults by cascade order alone; matching the real
 * `.theme-zai-*` selectors as well makes the override independent of which
 * scope ZCode happens to be in rather than relying on that ordering.
 *
 * Both blocks match `<html>`, so the DARK block must always be emitted last:
 * equal specificity means document order decides.
 */
export const LIGHT_SCOPES = ":root,:host,.theme-zai-light";
export const DARK_SCOPES = ".dark,.theme-zai-dark";
