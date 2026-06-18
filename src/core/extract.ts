/**
 * Recipe extraction from web-page HTML.
 *
 * Primary path is schema.org JSON-LD (`<script type="application/ld+json">`),
 * which covers the large majority of recipe sites; it handles a top-level
 * Recipe object, an array, or a node inside an `@graph`, and the several
 * shapes `recipeIngredient` / `recipeInstructions` take in the wild (string,
 * string[], HowToStep[], HowToSection[]). When no Recipe node is found it
 * falls back to OpenGraph tags for title/description/image.
 *
 * Pure and isomorphic: takes an HTML string, uses no DOM, so it runs in the
 * browser during import and is directly unit-testable in Node.
 */
import type { ExtractedRecipe } from './types';

/** Extract and JSON-parse every ld+json script block; bad blocks are skipped. */
export function extractJsonLdNodes(html: string): unknown[] {
  const re =
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const out: unknown[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return out;
}

/** Flatten parsed JSON-LD values (arrays + `@graph`) into a flat node list. */
function flattenNodes(values: unknown[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      nodes.push(obj);
      if (Array.isArray(obj['@graph'])) obj['@graph'].forEach(visit);
    }
  };
  values.forEach(visit);
  return nodes;
}

function typeMatches(node: Record<string, unknown>, wanted: string): boolean {
  const t = node['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && x.toLowerCase() === wanted.toLowerCase());
}

/** Find the first Recipe node among parsed JSON-LD values. */
export function findRecipeNode(values: unknown[]): Record<string, unknown> | null {
  return flattenNodes(values).find((n) => typeMatches(n, 'Recipe')) ?? null;
}

/** Extract a recipe from an HTML string, or null when nothing usable is found. */
export function extractRecipe(
  html: string,
  opts: { sourceUrl?: string } = {},
): ExtractedRecipe | null {
  const node = findRecipeNode(extractJsonLdNodes(html));
  if (node) return recipeFromNode(node, opts);
  return openGraphFallback(html, opts);
}

/** Build an ExtractedRecipe from a schema.org Recipe JSON-LD node. */
export function recipeFromNode(
  node: Record<string, unknown>,
  opts: { sourceUrl?: string } = {},
): ExtractedRecipe {
  const ingredients = asStringArray(node.recipeIngredient ?? node.ingredients).map(cleanText);
  const instructions = flattenInstructions(node.recipeInstructions);
  const servings = yieldToServings(node.recipeYield);

  return prune({
    title: optText(node.name),
    description: optText(node.description),
    imageUrl: pickImageUrl(node.image),
    ingredients: ingredients.filter(Boolean),
    instructions: instructions.filter(Boolean),
    prepTime: isoDuration(node.prepTime),
    cookTime: isoDuration(node.cookTime),
    totalTime: isoDuration(node.totalTime),
    servings,
    yield: yieldToString(node.recipeYield),
    author: pickName(node.author),
    cuisine: optText(firstOf(node.recipeCuisine)),
    course: optText(firstOf(node.recipeCategory)),
    sourceName: hostnameOf(opts.sourceUrl),
    sourceUrl: opts.sourceUrl,
  });
}

/* ---- normalisers ---- */

function flattenInstructions(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    return splitHtmlBlocks(value).map(cleanText).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return [cleanText(item)];
      if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        if (typeMatches(obj, 'HowToSection') && Array.isArray(obj.itemListElement)) {
          return flattenInstructions(obj.itemListElement);
        }
        const text = obj.text ?? obj.name;
        if (typeof text === 'string') return [cleanText(text)];
      }
      return [];
    });
  }
  // A single HowToStep / HowToSection object (schema.org allows a non-array).
  if (typeof value === 'object') return flattenInstructions([value]);
  return [];
}

/** Split a string of step HTML into per-step chunks before tag-stripping. */
function splitHtmlBlocks(s: string): string[] {
  const parts = s.split(/<\/(?:li|p|div|h[1-6])>|<br\s*\/?>|\r?\n/i);
  const cleaned = parts.map(cleanText).filter(Boolean);
  return cleaned.length ? cleaned : [cleanText(s)].filter(Boolean);
}

function pickImageUrl(image: unknown): string | undefined {
  const first = Array.isArray(image) ? image[0] : image;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const url = (first as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}

function pickName(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return cleanText(first) || undefined;
  if (first && typeof first === 'object') {
    const name = (first as Record<string, unknown>).name;
    if (typeof name === 'string') return cleanText(name) || undefined;
  }
  return undefined;
}

function yieldToServings(value: unknown): number | undefined {
  const first = firstOf(value);
  let n: number | undefined;
  if (typeof first === 'number' && Number.isFinite(first)) n = Math.round(first);
  else if (typeof first === 'string') {
    const m = /\d+/.exec(first);
    if (m) n = Number(m[0]);
  }
  // Guard against 0 / negatives (the schema requires a positive integer).
  return n != null && n >= 1 ? n : undefined;
}

function yieldToString(value: unknown): string | undefined {
  const first = firstOf(value);
  if (typeof first === 'string') return cleanText(first) || undefined;
  if (typeof first === 'number') return String(first);
  return undefined;
}

function isoDuration(value: unknown): string | undefined {
  return typeof value === 'string' && /^P/i.test(value.trim()) ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function optText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = cleanText(value);
  return t || undefined;
}

function hostnameOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/* ---- OpenGraph fallback ---- */

function openGraphFallback(
  html: string,
  opts: { sourceUrl?: string },
): ExtractedRecipe | null {
  const og = readMetaTags(html);
  const title = og['og:title'] ?? og.title ?? titleTag(html);
  if (!title) return null;
  return prune({
    title: cleanText(title),
    description: og['og:description'] ? cleanText(og['og:description']) : undefined,
    imageUrl: og['og:image'],
    ingredients: [],
    instructions: [],
    sourceName: hostnameOf(opts.sourceUrl),
    sourceUrl: opts.sourceUrl,
  });
}

/**
 * Attribute matchers for <meta> parsing. The `(?<![\w-])` lookbehind anchors
 * the name so `name=` does not also match `data-name=` / `twitter:name=`.
 */
const META_ATTR = {
  property: /(?<![\w-])property\s*=\s*["']([^"']*)["']/i,
  name: /(?<![\w-])name\s*=\s*["']([^"']*)["']/i,
  itemprop: /(?<![\w-])itemprop\s*=\s*["']([^"']*)["']/i,
  content: /(?<![\w-])content\s*=\s*["']([^"']*)["']/i,
} as const;

/** Parse <meta> property/name + content pairs (attribute order independent). */
function readMetaTags(html: string): Record<string, string> {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const out: Record<string, string> = {};
  for (const tag of tags) {
    const key = attr(tag, 'property') ?? attr(tag, 'name') ?? attr(tag, 'itemprop');
    const content = attr(tag, 'content');
    if (key && content != null) out[key.toLowerCase()] = content;
  }
  return out;
}

function attr(tag: string, name: keyof typeof META_ATTR): string | undefined {
  const m = META_ATTR[name].exec(tag);
  return m ? m[1] : undefined;
}

/** The document <title>, as a last-resort fallback for the recipe title. */
function titleTag(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? cleanText(m[1]) : '';
  return t || undefined;
}

/* ---- text cleanup ---- */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
};

/**
 * Decode entities first, then strip tags, then collapse whitespace. Decoding
 * before stripping means entity-escaped markup (`&lt;b&gt;`) is removed rather
 * than resurrected into literal tags in the output.
 */
export function cleanText(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Decode common named + numeric HTML entities, dropping invalid code points. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      // Reject anything that would inject junk or make fromCodePoint throw:
      // non-finite, NUL/control chars, surrogates, and beyond the Unicode max.
      const ok =
        Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff) &&
        !(code < 0x20 && code !== 9 && code !== 10 && code !== 13) &&
        !(code >= 0x7f && code <= 0x9f);
      return ok ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? `&${e};`;
  });
}

/** Drop undefined/empty fields so frontmatter stays tidy. */
function prune(r: ExtractedRecipe): ExtractedRecipe {
  const out = { ...r };
  for (const k of Object.keys(out) as (keyof ExtractedRecipe)[]) {
    const v = out[k];
    if (v === undefined || (typeof v === 'string' && v === '')) delete out[k];
  }
  return out;
}
