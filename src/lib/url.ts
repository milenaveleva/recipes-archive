/**
 * GitHub Pages serves this project site under `/recipes-archive/`, so every
 * internal link and asset path must be prefixed with the configured `base`.
 * `import.meta.env.BASE_URL` is `/recipes-archive/` (with trailing slash) in
 * production and `/` in some dev setups — `withBase` normalises both.
 *
 * Use for INTERNAL paths only (never on absolute http(s):// URLs).
 */
export function withBase(path = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const rel = path.replace(/^\//, '');
  return rel ? `${base}/${rel}` : `${base}/`;
}
