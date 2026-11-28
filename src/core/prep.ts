/**
 * Infer whether a recipe's fruit and vegetables are blended or juiced before eating, which
 * re-classifies their sugars in the inflammation score (fii.ts `prep`; WHO 2015 free sugars).
 *
 * Only drinks, breakfasts, desserts and snacks are considered, so a savoury sauce or a puréed
 * soup (vegetable sugars, little effect) is left alone. A method step blends when it names a
 * blender, food processor, blending or puréeing and is not optional ("if you prefer",
 * "you can also"). In a drink every fruit and vegetable line takes the prep, since a smoothie
 * blends "everything"; in the other courses a fruit line takes it only when a blending step
 * names it. A blending step (or the step after it) that strains the mixture and keeps the
 * liquid, or any use of a juicer, makes a juice (`juiced`); a strain or sieve for texture
 * keeps it a purée (`blended`).
 */
import { normalizeCourse } from './course';
import type { Prep } from './fii';

const BLEND = /\bblend(ed|er|ing)?\b|\bpur[eé]e(d|ing)?\b|\bfood processor\b|\bsmoothie\b/i;
const OPTIONAL = /\bif you (prefer|like|want|wish)\b|\byou can (also )?\b|\boptional(ly)?\b|\bfor a (smoother|creamier|really|silkier)\b|\btexture\b/i;
const STRAIN = /\bstrain(ed|ing)?\b|\bsqueeze (out )?the (pulp|liquid|juice)\b|\bnut[- ]milk bag\b|\bcheesecloth\b/i;
const JUICER = /\bjuicer\b|\bjuice extractor\b/i;
const COURSES = new Set(['drink', 'breakfast', 'dessert', 'snack']);

/** Split a method into its steps (one per line; numbering and bullets stripped). */
export function methodSteps(method: string): string[] {
  return method.split(/\n+/).map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
}

/** The recipe's blending steps (non-optional) and the prep they make, or null. */
export function recipePrep(course: string | null | undefined, method: string): { prep: Prep; steps: string[] } | null {
  const c = normalizeCourse(course);
  if (!c || !COURSES.has(c)) return null;
  const all = methodSteps(method);
  const steps: string[] = [];
  let juiced = JUICER.test(method);
  all.forEach((s, i) => {
    if (!BLEND.test(s) && !JUICER.test(s)) return;
    if (OPTIONAL.test(s) && !JUICER.test(s)) return;
    steps.push(s);
    const next = all[i + 1] ?? '';
    for (const t of [s, next]) if (STRAIN.test(t) && !OPTIONAL.test(t)) juiced = true;
  });
  if (steps.length === 0) return null;
  return { prep: juiced ? 'juiced' : 'blended', steps };
}

/** Content words of an ingredient's item (≥ 4 letters, crude singular), for matching steps. */
function itemWords(item: string): string[] {
  return (item.toLowerCase().match(/[a-zà-ÿ]{4,}/g) ?? []).map((w) => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''));
}

/**
 * Whether an ingredient takes the recipe's prep: a fruit (or, in a drink, a vegetable) that
 * the blending steps blend — in a drink any such line, elsewhere only one a step names.
 */
export function takesPrep(
  course: string | null | undefined,
  category: string | null | undefined,
  item: string | null | undefined,
  steps: string[],
): boolean {
  const cat = category ?? '';
  const drink = normalizeCourse(course) === 'drink';
  const fruit = /^Fruits/.test(cat);
  if (!fruit && !(drink && /^Vegetables/.test(cat))) return false;
  if (drink) return true;
  const words = itemWords(item ?? '');
  const text = steps.join(' ').toLowerCase();
  return words.some((w) => text.includes(w));
}
