/**
 * Full client-side render of a recipe detail, used to preview an edit instantly
 * before the static rebuild lands. Mirrors the markup of the Astro detail page
 * (src/pages/recipes/[slug].astro) and its ScoreMedallions / IngredientList /
 * NutritionPanel components, driven by the stored RecipeDraft so every field —
 * description, GI/GL, ingredients, nutrition, method, scores, tags — reflects the
 * change. Pure + presentational; the rebuilt static page remains the source of truth.
 */
import { Fragment, useEffect } from 'react';
import type { RecipeDraft, DraftIngredient } from '../../core/markdown';
import {
  formatDuration,
  formatGrams,
  round,
  slugifyTerm,
  giTone,
  glTone,
  nutriTone,
  inflammationTone,
  inflammationLabel,
  type Tone,
} from '../../lib/recipe';
import { withBase } from '../../lib/url';

const toneRing: Record<Tone, string> = {
  good: 'border-band-good text-band-good',
  mid: 'border-band-mid text-band-mid',
  bad: 'border-band-bad text-band-bad',
  unknown: 'border-line-strong text-ink-faint',
};

function Medallions({ nutrition }: { nutrition: RecipeDraft['nutrition'] }) {
  const gly = nutrition?.glycemic;
  const nutri = nutrition?.nutriScore;
  const inflam = nutrition?.inflammation;
  if (!gly && !nutri && !inflam) return null;
  const items = [
    {
      label: 'Glycemic Index',
      value: gly?.gi != null ? String(Math.round(gly.gi)) : '—',
      sub: gly?.giBand ?? undefined,
      tone: giTone(gly?.gi),
    },
    {
      label: 'Glycemic Load',
      value: gly?.gl != null ? String(Math.round(gly.gl)) : '—',
      sub: 'per serving',
      tone: glTone(gly?.gl),
    },
    {
      label: 'Nutrition Score',
      value: nutri?.grade ?? '—',
      sub: nutri ? 'Nutri-Score' : undefined,
      tone: nutriTone(nutri?.grade),
    },
    {
      label: 'Inflammation',
      value: inflam ? (inflam.score > 0 ? `+${inflam.score}` : String(inflam.score)) : '—',
      sub: inflam ? inflammationLabel(inflam.band) : undefined,
      tone: inflammationTone(inflam?.band),
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map((m) => (
        <div
          key={m.label}
          className="flex flex-col items-center text-center gap-2 rounded-xl bg-card border border-line px-3 py-4"
        >
          <div
            className={`flex items-center justify-center rounded-full border-2 bg-paper h-16 w-16 font-display font-semibold ${
              m.value.length > 3 ? 'text-xl' : 'text-2xl'
            } ${toneRing[m.tone]}`}
          >
            {m.value}
          </div>
          <div className="eyebrow !text-[0.62rem] !tracking-[0.14em] leading-tight text-ink-soft">
            {m.label}
          </div>
          {m.sub && <div className="font-ui text-[0.68rem] capitalize text-ink-faint -mt-1">{m.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** Human metric amount for an ingredient (ml/grams/count), else null. Mirrors IngredientList. */
function amount(ing: DraftIngredient): string | null {
  if (ing.milliliters != null && ing.milliliters > 0) {
    const ml = ing.milliliters;
    return ml >= 1000 ? `${round(ml / 1000, 2)} L` : `${round(ml, 0)} ml`;
  }
  if (ing.grams != null && ing.grams > 0) return formatGrams(ing.grams);
  if (ing.quantity != null) {
    const q =
      ing.quantity2 != null
        ? `${round(ing.quantity, 2)}–${round(ing.quantity2, 2)}`
        : `${round(ing.quantity, 2)}`;
    return ing.unit ? `${q} ${ing.unit}` : q;
  }
  return null;
}

function Ingredients({ ingredients }: { ingredients: DraftIngredient[] }) {
  const groups: { name: string | null; items: DraftIngredient[] }[] = [];
  for (const ing of ingredients) {
    const g = ing.group ?? null;
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) groups.push((bucket = { name: g, items: [] }));
    bucket.items.push(ing);
  }
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.name && <h3 className="eyebrow mb-3 !text-ink-soft">{group.name}</h3>}
          <ul className="flex flex-col">
            {group.items.map((ing, i) => {
              const amt = amount(ing);
              return (
                <li
                  key={i}
                  className="flex items-baseline gap-3 border-b border-line/70 py-2.5 last:border-0"
                >
                  <span className="min-w-[4.5rem] shrink-0 font-ui text-sm font-semibold tabular-nums text-spice">
                    {amt ?? ''}
                  </span>
                  <span className="font-body text-ink">
                    {ing.item}
                    {ing.note && <span className="text-ink-faint"> · {ing.note}</span>}
                    {amt == null && <span className="text-ink-faint"> {ing.raw}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Nutrition({ nutrition }: { nutrition: RecipeDraft['nutrition'] }) {
  const p = nutrition?.perServing;
  if (!p) return null;
  const rows: { label: string; value: number | null | undefined; unit: string; em?: boolean }[] = [
    { label: 'Energy', value: p.energyKcal, unit: 'kcal', em: true },
    { label: 'Protein', value: p.protein_g, unit: 'g' },
    { label: 'Carbs', value: p.carbs_g, unit: 'g' },
    { label: '— of which sugars', value: p.sugar_g, unit: 'g' },
    { label: '— fiber', value: p.fiber_g, unit: 'g' },
    { label: 'Fat', value: p.fat_g, unit: 'g' },
    { label: '— saturated', value: p.satFat_g, unit: 'g' },
    { label: 'Sodium', value: p.sodium_mg, unit: 'mg' },
  ];
  const visible = rows.filter((r) => r.value != null);
  if (!visible.length) return null;
  return (
    <div className="rounded-xl border border-line bg-card p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="font-display text-lg text-ink">Nutrition</h3>
        <span className="font-ui text-[0.66rem] uppercase tracking-[0.14em] text-ink-faint">
          per serving
        </span>
      </div>
      <dl className="flex flex-col">
        {visible.map((r) => (
          <div
            key={r.label}
            className={`flex items-baseline justify-between border-b border-line/60 py-1.5 last:border-0 ${
              r.label.startsWith('—') ? 'pl-3' : ''
            }`}
          >
            <dt className={`font-ui text-sm ${r.em ? 'font-semibold text-ink' : 'text-ink-soft'}`}>
              {r.label}
            </dt>
            <dd
              className={`font-ui tabular-nums ${
                r.em ? 'text-base font-semibold text-ink' : 'text-sm text-ink'
              }`}
            >
              {round(r.value, r.unit === 'g' ? 1 : 0)}
              <span className="text-ink-faint"> {r.unit}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A light markdown render for preserved intro / notes prose (headings, bullet
 *  and numbered lists, paragraphs) — enough fidelity for the ~1-minute preview. */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/).filter((b) => b.trim());
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]);
        if (heading) {
          const level = Math.min(heading[1].length, 3);
          const Tag = (level === 1 ? 'h2' : `h${level}`) as 'h2' | 'h3';
          const rest = lines.slice(1).join('\n').trim();
          return (
            <Fragment key={i}>
              <Tag>{heading[2]}</Tag>
              {rest && <p>{rest}</p>}
            </Fragment>
          );
        }
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*[-*]\s+/, '')}</li>
              ))}
            </ul>
          );
        }
        if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
          return (
            <ol key={i}>
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*\d+[.)]\s+/, '')}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{block}</p>;
      })}
    </>
  );
}

function sourceLabel(source: { name?: string; url?: string }): string {
  if (source.name) return source.name;
  try {
    return new URL(source.url!).hostname.replace('www.', '');
  } catch {
    return source.url ?? '';
  }
}

export default function RecipePreview({
  recipe,
  onReady,
}: {
  recipe: RecipeDraft;
  /** Called once the preview has rendered — signals the no-flash fallback that
   *  the island took over (so a never-rendered preview reveals the static page). */
  onReady?: () => void;
}) {
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  const data = recipe;
  const meta = [
    formatDuration(data.prepTime) && { label: 'Prep', value: formatDuration(data.prepTime)! },
    formatDuration(data.cookTime) && { label: 'Cook', value: formatDuration(data.cookTime)! },
    formatDuration(data.totalTime) && { label: 'Total', value: formatDuration(data.totalTime)! },
    { label: 'Serves', value: String(data.servings) },
    data.difficulty && { label: 'Difficulty', value: data.difficulty },
    data.cuisine && { label: 'Cuisine', value: data.cuisine },
  ].filter(Boolean) as { label: string; value: string }[];
  const steps = data.instructions.filter((s) => s.trim());
  const tags = data.tags ?? [];
  const hasScores =
    !!data.nutrition?.glycemic || !!data.nutrition?.nutriScore || !!data.nutrition?.inflammation;

  return (
    <>
      <div className="mx-auto max-w-5xl px-5 sm:px-8 pt-6">
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg border border-spice/40 bg-spice/5 px-4 py-3 font-ui text-sm text-ink-soft"
        >
          <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-spice" aria-hidden="true" />
          Showing your changes — publishing now, live on the site in about a minute.
        </p>
      </div>

      <article className="mx-auto max-w-5xl px-5 sm:px-8 pt-4 pb-4">
        <a
          href={withBase('/')}
          className="font-ui text-sm text-ink-soft no-underline transition-colors hover:text-spice"
        >
          ← All recipes
        </a>

        <header className="mt-6">
          {data.category && (
            <a
              href={withBase(`/categories/${slugifyTerm(data.category)}`)}
              className="eyebrow !text-spice no-underline"
            >
              {data.category}
            </a>
          )}
          <h1 className="mt-3 font-display font-medium text-4xl sm:text-5xl text-ink">{data.title}</h1>
          {data.description && (
            <p className="mt-4 max-w-2xl font-body text-lg text-ink-soft">{data.description}</p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2">
            {meta.map((m) => (
              <div key={m.label} className="flex items-baseline gap-1.5">
                <span className="font-ui text-[0.66rem] uppercase tracking-[0.14em] text-ink-faint">
                  {m.label}
                </span>
                <span className="font-ui text-sm font-semibold capitalize text-ink">{m.value}</span>
              </div>
            ))}
          </div>

          {data.source?.url && (
            <p className="mt-3 font-ui text-xs text-ink-faint">
              Adapted from{' '}
              <a
                href={data.source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-soft underline decoration-line-strong underline-offset-2 hover:text-spice"
              >
                {sourceLabel(data.source)}
              </a>
            </p>
          )}
        </header>

        {data.imageUrl && (
          <figure className="mt-8 overflow-hidden rounded-2xl border border-line">
            <img
              src={data.imageUrl}
              alt={data.imageAlt ?? data.title}
              className="aspect-[16/9] w-full object-cover"
            />
          </figure>
        )}

        {data.nutrition && (
          <section className="mt-8">
            <Medallions nutrition={data.nutrition} />
          </section>
        )}
      </article>

      <div className="mx-auto max-w-5xl px-5 sm:px-8 pb-12">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12">
          <aside className="lg:col-span-5 lg:sticky lg:top-24 lg:self-start flex flex-col gap-6">
            <div>
              <h2 className="font-display text-2xl text-ink mb-4">Ingredients</h2>
              <Ingredients ingredients={data.ingredients} />
            </div>
            {data.nutrition && <Nutrition nutrition={data.nutrition} />}
          </aside>

          <section className="lg:col-span-7">
            {(steps.length > 0 || data.bodyBefore?.trim() || data.bodyAfter?.trim()) && (
              <>
                <h2 className="font-display text-2xl text-ink mb-4">Method</h2>
                <div className="recipe-prose">
                  {data.bodyBefore?.trim() && <Prose text={data.bodyBefore} />}
                  {steps.length > 0 && (
                    <ol>
                      {steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  )}
                  {data.bodyAfter?.trim() && <Prose text={data.bodyAfter} />}
                </div>
              </>
            )}

            {tags.length > 0 && (
              <div className="mt-10 flex flex-wrap gap-2">
                {tags.map((t) => (
                  <a
                    key={t}
                    href={withBase(`/tags/${slugifyTerm(t)}`)}
                    className="rounded-full border border-line bg-card px-3 py-1 font-ui text-xs text-ink-soft no-underline transition-colors hover:border-spice hover:text-spice"
                  >
                    #{t}
                  </a>
                ))}
              </div>
            )}

            {hasScores && (
              <p className="mt-8 rounded-lg border border-line bg-paper-2/60 px-4 py-3 font-ui text-xs leading-relaxed text-ink-faint">
                Glycemic index/load and the inflammation score are estimates derived from ingredient
                data and published references — useful for comparison, not a substitute for medical or
                dietary advice. The nutrition grade follows the Nutri-Score 2023 method.
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
