/**
 * The plugin version at runtime.
 *
 * `scripts/bundle.mjs` substitutes `__PLUGIN_VERSION__` from `package.json` when
 * it builds `dist/cli.js`, which is how the shipped artifact knows its version
 * without reading a file. Code that runs *unbundled* — the compiled test tree,
 * a `tsc`-only build — has no such substitution, and a bare reference there is a
 * `ReferenceError` at import time.
 *
 * `typeof` on an undeclared identifier is the one form that does not throw, so
 * that is what this uses; esbuild rewrites the identifier to a string literal
 * and the guard folds away, leaving the shipped bundle with a constant.
 */

declare const __PLUGIN_VERSION__: string;

/** The version, or a clearly-not-shippable marker when running unbundled. */
export function pluginVersion(): string {
  try {
    return typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}
