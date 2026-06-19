/**
 * In-browser recipe authoring wizard (a client-only React island).
 *
 * Flow: import a URL (via the CORS-proxy Worker) or write by hand → review each
 * ingredient's USDA match and metric weight → see live per-serving macros and
 * scores → publish, which commits the markdown to the repo and auto-redeploys.
 * Sign-in (in the header, or inline at publish time) gates only the commit. The
 * compute logic lives in ./addLib + src/core; this file is the UI and orchestration.
 */
import { useMemo, useState, useEffect } from 'react';
import { extractRecipe } from '../../core/extract';
import { toRecipeMarkdown, recipeFilename, type RecipeDraft } from '../../core/markdown';
import { commitTextFile, GitHubError, type GitHubRepo } from '../../core/github';
import type { NutriCategory } from '../../core/nutriscore';
import {
  EMPTY_FORM,
  linesToRows,
  reparseRows,
  buildDraft,
  computeNutrition,
  formFromExtract,
  selectedConfidence,
  type FormState,
  type IngredientRow,
} from './addLib';
import {
  type AuthSession,
  signIn,
  refreshSession,
  freshSession,
  loadSession,
  saveSession,
  notifyAuthChange,
  onAuthChange,
} from './auth';
import { GITHUB_MARK_PATH } from '../../lib/icons';
import { withBase } from '../../lib/url';

const PROXY = (import.meta.env.PUBLIC_IMPORT_PROXY as string | undefined)?.trim();

// Single-deployment app: recipes always commit to this repo's default branch.
const OWNER = 'milenaveleva';
const REPO = 'recipes-archive';
const BRANCH = 'main';

export default function AddRecipe() {
  // The GitHub session (tokens) lives in sessionStorage via auth.ts.
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authState, setAuthState] = useState<'idle' | 'checking' | 'error'>('idle');
  const [authMsg, setAuthMsg] = useState('');

  // Restore a sign-in from this tab's sessionStorage on mount.
  useEffect(() => {
    const restored = loadSession();
    if (restored) setSession(restored);
  }, []);

  // Reflect a sign-in/out done from the header widget (same tab).
  useEffect(() => {
    return onAuthChange(() => {
      const s = loadSession();
      setSession(s);
      if (!s) {
        setAuthState('idle');
        setAuthMsg('');
      }
    });
  }, []);

  // Recipe content.
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [ingredientsText, setIngredientsText] = useState('');
  const [rows, setRows] = useState<IngredientRow[]>([]);

  // Import + publish status.
  const [importUrl, setImportUrl] = useState('');
  const [importState, setImportState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [importMsg, setImportMsg] = useState('');
  const [publishState, setPublishState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [publishMsg, setPublishMsg] = useState('');

  // On a successful publish, let the confirmation land, then return to the
  // recipe index (the rebuild surfaces the new recipe within ~a minute).
  useEffect(() => {
    if (publishState !== 'done') return;
    const t = setTimeout(() => window.location.assign(withBase('/')), 2200);
    return () => clearTimeout(t);
  }, [publishState]);

  const ghRepo: GitHubRepo = { owner: OWNER, repo: REPO, branch: BRANCH };
  const macro = useMemo(() => computeNutrition(rows, form.servings), [rows, form.servings]);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const draft = useMemo(() => buildDraft(form, rows, macro, today), [form, rows, macro, today]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function patchRow(id: string, patch: Partial<IngredientRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  const persist = (s: AuthSession) => {
    setSession(s);
    saveSession(s);
    notifyAuthChange(); // keep the header sign-in widget in sync
  };

  // Sign in with GitHub. Anyone may sign in; push access is enforced by GitHub
  // at commit time (and surfaced as a friendly message in handlePublish).
  async function handleSignIn() {
    if (!PROXY) {
      setAuthState('error');
      setAuthMsg('Sign-in needs the import Worker configured (PUBLIC_IMPORT_PROXY).');
      return;
    }
    setAuthState('checking');
    setAuthMsg('');
    try {
      persist(await signIn(PROXY));
      setAuthState('idle');
    } catch (err) {
      setAuthState('error');
      setAuthMsg(err instanceof Error ? err.message : String(err));
    }
  }

  // Return a session with a currently-valid access token, refreshing (and
  // persisting) when the stored one has expired.
  async function ensureFresh(current: AuthSession): Promise<AuthSession> {
    const fresh = await freshSession(PROXY, current, Date.now());
    if (fresh !== current) persist(fresh);
    return fresh;
  }

  function parseIngredients() {
    // Re-parse, keeping match/weight/exclude edits for unchanged lines.
    setRows((prev) => reparseRows(ingredientsText, prev));
  }

  async function handleImport() {
    if (!PROXY) return;
    setImportState('loading');
    setImportMsg('');
    try {
      const res = await fetch(`${PROXY}?url=${encodeURIComponent(importUrl)}`);
      if (!res.ok) throw new Error(`Proxy returned ${res.status}`);
      const html = await res.text();
      const extracted = extractRecipe(html, { sourceUrl: importUrl });
      if (!extracted) throw new Error('No recipe metadata found on that page.');
      const ingredientsText = extracted.ingredients.join('\n');
      setForm(formFromExtract(extracted));
      setIngredientsText(ingredientsText);
      setRows(linesToRows(ingredientsText));
      setImportState('idle');
    } catch (err) {
      setImportState('error');
      setImportMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handlePublish() {
    if (!session) return;
    setPublishState('saving');
    setPublishMsg('');
    try {
      // Stamp createdAt at publish time (not island mount).
      const publishDraft = buildDraft(form, rows, macro, new Date().toISOString().slice(0, 10));
      const file = {
        path: recipeFilename(publishDraft),
        content: toRecipeMarkdown(publishDraft),
        message: `Add recipe: ${publishDraft.title}`,
      };
      const active = await ensureFresh(session);
      let result;
      try {
        result = await commitTextFile(active.accessToken, ghRepo, file);
      } catch (err) {
        // One reactive retry if the token was revoked/expired between checks.
        if (active.refreshToken && PROXY && err instanceof GitHubError && err.status === 401) {
          const refreshed = await refreshSession(PROXY, active.refreshToken);
          persist(refreshed);
          result = await commitTextFile(refreshed.accessToken, ghRepo, file);
        } else {
          throw err;
        }
      }
      setPublishState('done');
      setPublishMsg(result.updated ? 'Updated an existing recipe at the same slug.' : '');
    } catch (err) {
      setPublishState('error');
      if (err instanceof GitHubError && err.status === 403) {
        setPublishMsg(
          `No push access to ${OWNER}/${REPO}. Confirm the GitHub App is installed on the repo and you have write access.`,
        );
      } else {
        setPublishMsg(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const hasIngredient = rows.some((r) => !r.parsed.isGroupHeader);
  const canPublish = draft.title.trim().length > 0 && hasIngredient && publishState !== 'saving';

  return (
    <div className="font-body text-ink grid gap-6">
      {publishState === 'done' && <PublishSuccessOverlay note={publishMsg} />}

      {PROXY && (
        <Card>
          <h2 className="font-display text-xl text-ink">Import from a link</h2>
          <div className="mt-3 flex flex-col sm:flex-row gap-3">
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://example.com/recipe"
              className={`${inputCls} flex-1`}
            />
            <button
              onClick={handleImport}
              disabled={!importUrl || importState === 'loading'}
              className={primaryBtn}
            >
              {importState === 'loading' ? 'Fetching…' : 'Import'}
            </button>
          </div>
          {importState === 'error' && <Alert tone="bad">{importMsg}</Alert>}
          <p className="mt-2 text-xs text-ink-faint">Or just fill in the details below by hand.</p>
        </Card>
      )}

      <Card>
        <h2 className="font-display text-xl text-ink">Details</h2>
        <div className="mt-4 grid gap-4">
          <Field label="Title">
            <input value={form.title} onChange={(e) => setField('title', e.target.value)} className={inputCls} />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => setField('description', e.target.value)}
              rows={2}
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Field label="Servings">
              <input
                type="number"
                min={1}
                value={form.servings || ''}
                onChange={(e) => setField('servings', Math.max(0, Math.floor(Number(e.target.value)) || 0))}
                className={inputCls}
              />
            </Field>
            <Field label="Prep (min)">
              <input type="number" min={0} value={form.prepMin ?? ''} onChange={(e) => setField('prepMin', intOrNull(e.target.value))} className={inputCls} />
            </Field>
            <Field label="Cook (min)">
              <input type="number" min={0} value={form.cookMin ?? ''} onChange={(e) => setField('cookMin', intOrNull(e.target.value))} className={inputCls} />
            </Field>
            <Field label="Category">
              <input value={form.category} onChange={(e) => setField('category', e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Tags (comma-separated)">
              <input value={form.tags} onChange={(e) => setField('tags', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Lists (comma-separated)">
              <input value={form.lists} onChange={(e) => setField('lists', e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Cuisine">
              <input value={form.cuisine} onChange={(e) => setField('cuisine', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Course">
              <input value={form.course} onChange={(e) => setField('course', e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Nutri-Score category">
            <select
              value={form.nutriCategory}
              onChange={(e) => setField('nutriCategory', e.target.value as NutriCategory)}
              className={inputCls}
            >
              <option value="general">General food — most recipes (incl. soups &amp; composite dishes)</option>
              <option value="beverage">Beverage — drinks, incl. milk &amp; plant-based drinks</option>
              <option value="fat-oil-nut-seed">Fats, oils, nuts &amp; seeds</option>
            </select>
          </Field>
          <p className="-mt-2 text-xs text-ink-faint">
            Nutri-Score grades drinks and fats with stricter, category-specific rules. Match it to the finished
            dish; leave it on “general” unless the recipe really is a drink or a fat/oil/nut product. (Alcoholic
            drinks over 1.2% are outside Nutri-Score.)
          </p>
          {form.nutriCategory === 'beverage' && (
            <label className="flex items-center gap-2 font-ui text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={form.nnsPresent}
                onChange={(e) => setField('nnsPresent', e.target.checked)}
              />
              Contains a non-nutritive sweetener (stevia, sucralose, aspartame, …)
            </label>
          )}
          <Field label="Image URL">
            <input value={form.imageUrl} onChange={(e) => setField('imageUrl', e.target.value)} placeholder="https://…" className={inputCls} />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Source name">
              <input value={form.sourceName} onChange={(e) => setField('sourceName', e.target.value)} className={inputCls} />
            </Field>
            <Field label="Source URL">
              <input value={form.sourceUrl} onChange={(e) => setField('sourceUrl', e.target.value)} placeholder="https://…" className={inputCls} />
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-4">
          <h2 className="font-display text-xl text-ink">Ingredients</h2>
          <button onClick={parseIngredients} className={ghostBtn}>
            {rows.length ? 'Re-parse' : 'Parse'}
          </button>
        </div>
        <p className="mt-1 text-xs text-ink-faint">One ingredient per line, e.g. “1 cup red lentils, rinsed”.</p>
        <textarea
          value={ingredientsText}
          onChange={(e) => setIngredientsText(e.target.value)}
          rows={6}
          className={`${inputCls} mt-3 font-mono text-sm`}
          placeholder={'1 cup red lentils, rinsed\n2 cloves garlic, minced\n1 tbsp olive oil'}
        />

        {rows.length > 0 && (
          <div className="mt-5 grid gap-3">
            {rows.filter((r) => !r.parsed.isGroupHeader).map((row) => (
              <IngredientRowEditor key={row.id} row={row} onPatch={(p) => patchRow(row.id, p)} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-display text-xl text-ink">Method</h2>
        <p className="mt-1 text-xs text-ink-faint">One step per line; numbered automatically.</p>
        <textarea
          value={form.instructions}
          onChange={(e) => setField('instructions', e.target.value)}
          rows={6}
          className={`${inputCls} mt-3`}
          placeholder={'Rinse the lentils.\nSimmer until soft.'}
        />
      </Card>

      <MacroPanel macro={macro} servings={form.servings} />
      <ScorePanel nutrition={draft.nutrition} />

      <div className="grid gap-3">
        {authState === 'error' && <Alert tone="bad">{authMsg}</Alert>}
        {publishState === 'error' && <Alert tone="bad">{publishMsg}</Alert>}
        <div className="flex items-center justify-end gap-3">
          {session ? (
            <button onClick={handlePublish} disabled={!canPublish} className={primaryBtn}>
              {publishState === 'saving' ? 'Publishing…' : 'Publish recipe'}
            </button>
          ) : (
            <button
              onClick={handleSignIn}
              disabled={authState === 'checking' || !PROXY}
              className={`${primaryBtn} inline-flex items-center gap-2`}
            >
              <GitHubMark />
              {authState === 'checking' ? 'Signing in…' : 'Sign in with GitHub to publish'}
            </button>
          )}
        </div>
        {!session && (
          <p className="text-right text-xs text-ink-faint">
            {PROXY
              ? 'Sign in to commit this recipe — it publishes straight to the archive.'
              : 'Sign-in needs the import Worker configured (PUBLIC_IMPORT_PROXY).'}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---- sub-components ---- */

function IngredientRowEditor({
  row,
  onPatch,
}: {
  row: IngredientRow;
  onPatch: (patch: Partial<IngredientRow>) => void;
}) {
  const confidence = selectedConfidence(row);
  return (
    <div className="rounded-xl border border-line bg-paper/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-ui text-sm text-ink">{row.raw}</span>
        <ConfidenceBadge confidence={confidence} />
      </div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_7rem_auto] gap-2 items-center">
        <select
          value={row.selectedFdcId ?? ''}
          onChange={(e) => onPatch({ selectedFdcId: e.target.value ? Number(e.target.value) : null })}
          className={`${inputCls} text-sm`}
        >
          <option value="">— no nutrition match —</option>
          {row.candidates
            .filter((c) => c.food.fdcId != null)
            .map((c) => (
              <option key={c.food.fdcId} value={c.food.fdcId}>
                {c.food.description}
              </option>
            ))}
        </select>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="number"
            min={0}
            value={row.grams ?? ''}
            onChange={(e) => onPatch({ grams: gramsOrNull(e.target.value) })}
            className={`${inputCls} text-sm`}
          />
          <span className="text-ink-faint">g</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-soft whitespace-nowrap">
          <input
            type="checkbox"
            checked={row.excludeFromNutrition}
            onChange={(e) => onPatch({ excludeFromNutrition: e.target.checked })}
          />
          exclude
        </label>
      </div>
    </div>
  );
}

function MacroPanel({ macro, servings }: { macro: ReturnType<typeof computeNutrition>; servings: number }) {
  const p = macro.perServing;
  const rows: [string, string][] = [
    ['Energy', p.energyKcal != null ? `${p.energyKcal} kcal` : '—'],
    ['Protein', fmt(p.protein_g)],
    ['Carbs', fmt(p.carbs_g)],
    ['Available carb', fmt(p.availableCarb_g)],
    ['Fibre', fmt(p.fiber_g)],
    ['Sugar', fmt(p.sugar_g)],
    ['Fat', fmt(p.fat_g)],
    ['Sat. fat', fmt(p.satFat_g)],
    ['Sodium', p.sodium_mg != null ? `${p.sodium_mg} mg` : '—'],
  ];
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-xl text-ink">Per serving</h2>
        <span className="text-xs text-ink-faint">{servings} servings · estimates</span>
      </div>
      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between border-b border-line/60 py-1">
            <dt className="text-sm text-ink-soft">{label}</dt>
            <dd className="font-ui text-sm text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {macro.missingDataCount > 0 && (
        <p className="mt-3 text-xs text-band-bad">
          {macro.missingDataCount} ingredient{macro.missingDataCount === 1 ? '' : 's'} need a match or weight to count
          toward nutrition.
        </p>
      )}
    </Card>
  );
}

function ScorePanel({ nutrition }: { nutrition: RecipeDraft['nutrition'] }) {
  const gly = nutrition?.glycemic;
  const nutri = nutrition?.nutriScore;
  const inflam = nutrition?.inflammation;
  if (!gly && !nutri && !inflam) return null;

  const tiles: [string, string, string][] = [
    ['Glycemic index', gly?.gi != null ? String(gly.gi) : '—', gly?.giBand ?? ''],
    ['Glycemic load', gly?.gl != null ? String(gly.gl) : '—', 'per serving'],
    ['Nutrition score', nutri?.grade ?? '—', nutri ? 'Nutri-Score 2023' : ''],
    [
      'Inflammation',
      inflam ? (inflam.score > 0 ? `+${inflam.score}` : String(inflam.score)) : '—',
      inflam ? inflam.band.replace(/-/g, ' ') : '',
    ],
  ];
  return (
    <Card>
      <h2 className="font-display text-xl text-ink">Scores</h2>
      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map(([label, value, sub]) => (
          <div key={label} className="rounded-xl border border-line bg-paper/60 px-3 py-3 text-center">
            <dd className="font-display text-2xl text-ink">{value}</dd>
            <dt className="mt-1 font-ui text-[0.62rem] uppercase tracking-wide text-ink-faint">{label}</dt>
            {sub && <div className="mt-0.5 font-ui text-[0.66rem] capitalize text-ink-soft">{sub}</div>}
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-ink-faint">
        Glycemic and inflammation figures are estimates for comparison, not medical advice; the grade
        follows the Nutri-Score 2023 method. The carb-weighted GI tends to over-predict mixed-meal GI.
      </p>
    </Card>
  );
}

function ConfidenceBadge({ confidence }: { confidence: 'high' | 'medium' | 'low' | 'none' }) {
  const map = {
    high: 'bg-band-good/15 text-band-good',
    medium: 'bg-band-mid/15 text-band-mid',
    low: 'bg-band-bad/15 text-band-bad',
    none: 'bg-line text-ink-faint',
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 font-ui text-[0.65rem] uppercase tracking-wide ${map[confidence]}`}>
      {confidence === 'none' ? 'unmatched' : confidence}
    </span>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-line bg-card p-5 sm:p-6">{children}</div>;
}

/** The GitHub mark, for the sign-in button. Decorative — the button text labels it. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d={GITHUB_MARK_PATH} />
    </svg>
  );
}

/** Full-screen confirmation shown after a successful publish, just before the
 *  island redirects back to the recipe index. */
function PublishSuccessOverlay({ note }: { note?: string }) {
  return (
    <div
      role="alert"
      className="publish-overlay fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm"
    >
      <div className="publish-badge flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-line bg-card px-8 py-9 text-center shadow-2xl">
        <SuccessCheck />
        <div>
          <p className="font-display text-2xl text-ink">Published!</p>
          {note && <p className="mt-1 font-ui text-sm text-band-mid">{note}</p>}
          <p className="mt-1 font-ui text-sm text-ink-soft">Taking you back to your recipes…</p>
        </div>
      </div>
    </div>
  );
}

/** An animated tick — circle and check draw themselves in on mount. */
function SuccessCheck() {
  return (
    <svg viewBox="0 0 52 52" width="72" height="72" className="text-band-good" role="img" aria-label="Success">
      <circle
        className="publish-check-circle"
        cx="26"
        cy="26"
        r="24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        className="publish-check-mark"
        d="M15 27 l7.5 7.5 L37.5 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <span className="font-ui text-xs uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function Alert({ tone, children }: { tone: 'good' | 'bad'; children: React.ReactNode }) {
  const cls = tone === 'good' ? 'border-band-good/40 text-band-good' : 'border-band-bad/40 text-band-bad';
  return <div className={`mt-4 rounded-lg border bg-paper/60 px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

function fmt(g?: number): string {
  return g != null ? `${g} g` : '—';
}

/** Parse a number input to a non-negative integer, or null when blank/invalid. */
function intOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse a number input to a non-negative weight, or null when blank/invalid. */
function gramsOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const inputCls =
  'w-full rounded-lg border border-line-strong bg-paper px-3 py-2 text-ink outline-none focus:border-spice';
const primaryBtn =
  'rounded-full bg-ink px-5 py-2 font-ui text-sm font-semibold text-paper transition-colors hover:bg-spice disabled:opacity-40 disabled:hover:bg-ink';
const ghostBtn =
  'rounded-full border border-line-strong px-4 py-1.5 font-ui text-sm text-ink-soft transition-colors hover:border-spice hover:text-spice';
