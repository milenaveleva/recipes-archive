/**
 * Medical Medium import ids, shared by build.mjs and classify.mjs. An id is the source page
 * slug, with `--<n>` for the n-th recipe block of a page (n ≥ 2); the archive recipe records
 * the block as `#<n>` on its source URL.
 */
export const LIST = 'Medical Medium';
export const SOURCE = 'medicalmedium.com';
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const pageOf = (id) => id.replace(/--\d+$/, '');
export const blockOf = (id) => Number(/--(\d+)$/.exec(id)?.[1] ?? 1) - 1;

/**
 * The import id of an archive recipe this importer wrote (its frontmatter `data`), else null.
 * A hand-written recipe that only cites the source is not in the import list, so it is never
 * treated as an import and never replaced.
 */
export function sourceIdOf(data) {
  if (data?.source?.name !== SOURCE || !(data.lists ?? []).includes(LIST)) return null;
  const m = /medicalmedium\.com\/blog\/([a-z0-9-]+)(?:#(\d+))?/.exec(data.source.url ?? '');
  if (!m) return null;
  return m[2] && m[2] !== '1' ? `${m[1]}--${m[2]}` : m[1];
}
