/**
 * Recipe course → canonical course key, and the glycemic-load banding basis it implies.
 *
 * `course` is free text in frontmatter ("Main Course", "mains", "Entrée", "Starter"), so it
 * is normalised (case, whitespace, accents, plural, common synonyms) before it drives
 * scoring. Only a full meal — main course, soup, salad, breakfast — is banded for GL with
 * the whole-meal cut-offs; every other course (and an unknown one) is a single portion of
 * one food or a side, banded with the classic single-food cut-offs (gi.ts `glBandOf`).
 *
 * This is the one course normaliser: the GL basis, the validation gate's kcal-per-serving
 * ranges (validate.ts) and every reader of a stored GL basis key off `normalizeCourse`.
 */
import { DEFAULT_GL_BASIS, type GlBasis } from './gi';

export type CourseKey =
  | 'main'
  | 'soup'
  | 'salad'
  | 'breakfast'
  | 'appetizer'
  | 'side'
  | 'snack'
  | 'dessert'
  | 'drink'
  | 'sauce'
  | 'condiment';

/** Normalised spellings → course key. Keys are lowercase, accent-free, single-spaced. */
const COURSE_SYNONYMS: Record<string, CourseKey> = {
  main: 'main',
  'main course': 'main',
  'main dish': 'main',
  'main meal': 'main',
  entree: 'main',
  dinner: 'main',
  lunch: 'main',
  supper: 'main',
  soup: 'soup',
  stew: 'soup',
  broth: 'soup',
  salad: 'salad',
  breakfast: 'breakfast',
  brunch: 'breakfast',
  appetizer: 'appetizer',
  appetiser: 'appetizer',
  starter: 'appetizer',
  'hors d oeuvre': 'appetizer',
  antipasto: 'appetizer',
  antipasti: 'appetizer',
  tapa: 'appetizer',
  tapas: 'appetizer',
  mezze: 'appetizer',
  meze: 'appetizer',
  side: 'side',
  'side dish': 'side',
  snack: 'snack',
  dessert: 'dessert',
  pudding: 'dessert',
  sweet: 'dessert',
  cake: 'dessert',
  baking: 'dessert',
  'baked good': 'dessert',
  drink: 'drink',
  beverage: 'drink',
  cocktail: 'drink',
  mocktail: 'drink',
  smoothie: 'drink',
  juice: 'drink',
  sauce: 'sauce',
  dip: 'sauce',
  dressing: 'sauce',
  condiment: 'condiment',
  spread: 'condiment',
  preserve: 'condiment',
  jam: 'condiment',
  pickle: 'condiment',
  chutney: 'condiment',
  relish: 'condiment',
};

/** Courses that are a whole meal, so their per-serving GL is banded with meal cut-offs. */
const MEAL_COURSES: ReadonlySet<CourseKey> = new Set(['main', 'soup', 'salad', 'breakfast']);

function canonical(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

function lookup(text: string): CourseKey | null {
  const key = canonical(text);
  if (!key) return null;
  // Exact, then plural forms ("Side dishes", "Mains", "Desserts").
  for (const form of [key, key.replace(/es$/, ''), key.replace(/s$/, '')]) {
    if (Object.hasOwn(COURSE_SYNONYMS, form)) return COURSE_SYNONYMS[form];
  }
  return null;
}

/**
 * Canonical course key for a free-text course, or null when unrecognised/empty. A list
 * ("Main Course, Side Dish") resolves to its first recognised entry.
 */
export function normalizeCourse(course?: string | null): CourseKey | null {
  if (course == null) return null;
  for (const part of course.split(/[,;/|]/)) {
    const key = lookup(part);
    if (key) return key;
  }
  return null;
}

/**
 * GL banding basis for a recipe's course: 'meal' for a full meal, 'portion' for any other
 * recognised course, and DEFAULT_GL_BASIS when the course is missing or unrecognised.
 */
export function glBasisForCourse(course?: string | null): GlBasis {
  const key = normalizeCourse(course);
  if (key == null) return DEFAULT_GL_BASIS;
  return MEAL_COURSES.has(key) ? 'meal' : 'portion';
}

/**
 * The GL basis a stored glycemic block was banded on: its own `glBasis` when valid, else
 * the basis its recipe's course implies (glBasisForCourse, which falls back to
 * DEFAULT_GL_BASIS). Every reader of a stored block (the dials, the GL facet, the
 * score-change report) resolves the basis here so they never disagree with the engine.
 */
export function resolveGlBasis(stored?: string | null, course?: string | null): GlBasis {
  if (stored === 'meal' || stored === 'portion') return stored;
  return glBasisForCourse(course);
}
