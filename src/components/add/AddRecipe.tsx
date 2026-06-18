/**
 * In-browser recipe authoring wizard (a client-only React island).
 *
 * Flow: authenticate with a fine-grained GitHub PAT → import a URL (via the
 * CORS-proxy Worker) or write by hand → review each ingredient's USDA match and
 * metric weight → see live per-serving macros → preview the generated markdown
 * → commit it to the repo, which auto-redeploys. The compute logic lives in
 * ./addLib + src/core; this file is the UI and orchestration.
 */
import { useMemo, useState, useEffect } from 'react';
import { extractRecipe } from '../../core/extract';
import { toRecipeMarkdown, recipeFilename } from '../../core/markdown';
import { verifyAccess, commitTextFile, type GitHubRepo } from '../../core/github';
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

const PROXY = (import.meta.env.PUBLIC_IMPORT_PROXY as string | undefined)?.trim();
const LS = { token: 'gh_token', owner: 'gh_owner', repo: 'gh_repo', branch: 'gh_branch' };

type Step = 'auth' | 'compose' | 'publish';

export default function AddRecipe() {
  const [step, setStep] = useState<Step>('auth');

  // Auth / repo settings (persisted to localStorage).
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('milenaveleva');
  const [repo, setRepo] = useState('recipes-archive');
  const [branch, setBranch] = useState('main');
  const [authState, setAuthState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [authMsg, setAuthMsg] = useState('');

  useEffect(() => {
    try {
      setToken(localStorage.getItem(LS.token) ?? '');
      setOwner(localStorage.getItem(LS.owner) ?? 'milenaveleva');
      setRepo(localStorage.getItem(LS.repo) ?? 'recipes-archive');
      setBranch(localStorage.getItem(LS.branch) ?? 'main');
    } catch {
      // localStorage may be unavailable (private mode); fields stay at defaults.
    }
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
  const [publishUrl, setPublishUrl] = useState('');

  const ghRepo: GitHubRepo = { owner, repo, branch };
  const macro = useMemo(() => computeNutrition(rows, form.servings), [rows, form.servings]);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const draft = useMemo(() => buildDraft(form, rows, macro, today), [form, rows, macro, today]);
  const markdown = useMemo(() => toRecipeMarkdown(draft), [draft]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function patchRow(id: string, patch: Partial<IngredientRow>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleVerify() {
    setAuthState('checking');
    setAuthMsg('');
    try {
      const { canPush, defaultBranch } = await verifyAccess(token, ghRepo);
      if (!canPush) {
        setAuthState('error');
        setAuthMsg('That token cannot push to this repo. Use a fine-grained PAT with Contents: write.');
        return;
      }
      const resolvedBranch = branch || defaultBranch;
      setBranch(resolvedBranch);
      try {
        localStorage.setItem(LS.token, token);
        localStorage.setItem(LS.owner, owner);
        localStorage.setItem(LS.repo, repo);
        localStorage.setItem(LS.branch, resolvedBranch);
      } catch {
        /* persisting is best-effort */
      }
      setAuthState('ok');
      setStep('compose');
    } catch (err) {
      setAuthState('error');
      setAuthMsg(err instanceof Error ? err.message : String(err));
    }
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
    setPublishState('saving');
    setPublishMsg('');
    try {
      // Stamp createdAt at publish time (not island mount).
      const publishDraft = buildDraft(form, rows, macro, new Date().toISOString().slice(0, 10));
      const result = await commitTextFile(token, ghRepo, {
        path: recipeFilename(publishDraft),
        content: toRecipeMarkdown(publishDraft),
        message: `Add recipe: ${publishDraft.title}`,
      });
      setPublishState('done');
      setPublishUrl(result.htmlUrl ?? '');
      setPublishMsg(result.updated ? 'Note: this overwrote an existing recipe at the same slug.' : '');
    } catch (err) {
      setPublishState('error');
      setPublishMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const hasIngredient = rows.some((r) => !r.parsed.isGroupHeader);
  const canPublish = draft.title.trim().length > 0 && hasIngredient && publishState !== 'saving';

  return (
    <div className="font-body text-ink">
      <StepNav step={step} setStep={setStep} authed={authState === 'ok'} />

      {step === 'auth' && (
        <Card>
          <h2 className="font-display text-2xl text-ink">Connect to GitHub</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Saving commits the recipe markdown to your repo. Paste a{' '}
            <a
              className="text-spice underline"
              href="https://github.com/settings/tokens?type=beta"
              target="_blank"
              rel="noreferrer"
            >
              fine-grained personal access token
            </a>{' '}
            with <strong>Contents: write</strong> on this repository.
          </p>
          <div className="mt-5 grid gap-4">
            <Field label="Access token">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
                className={inputCls}
                autoComplete="off"
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Owner">
                <input value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Repo">
                <input value={repo} onChange={(e) => setRepo(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Branch">
                <input value={branch} onChange={(e) => setBranch(e.target.value)} className={inputCls} />
              </Field>
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            The token is stored only in this browser&rsquo;s localStorage — it is a real secret on this device.
          </p>
          {authState === 'error' && <Alert tone="bad">{authMsg}</Alert>}
          <div className="mt-5">
            <button
              onClick={handleVerify}
              disabled={!token || authState === 'checking'}
              className={primaryBtn}
            >
              {authState === 'checking' ? 'Verifying…' : 'Verify & continue'}
            </button>
          </div>
        </Card>
      )}

      {step === 'compose' && (
        <div className="grid gap-6">
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

          <div className="flex justify-end">
            <button onClick={() => setStep('publish')} disabled={!canPublish} className={primaryBtn}>
              Preview &amp; publish →
            </button>
          </div>
        </div>
      )}

      {step === 'publish' && (
        <div className="grid gap-6">
          <Card>
            <h2 className="font-display text-xl text-ink">Generated markdown</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Will be committed to <code>{recipeFilename(draft)}</code>.
            </p>
            <pre className="mt-3 max-h-96 overflow-auto rounded-lg bg-paper-2 p-4 text-xs leading-relaxed text-ink">
              {markdown}
            </pre>
          </Card>

          <MacroPanel macro={macro} servings={form.servings} />

          {publishState === 'error' && <Alert tone="bad">{publishMsg}</Alert>}
          {publishState === 'done' && (
            <Alert tone="good">
              Committed. The site rebuilds in ~1 minute.{' '}
              {publishUrl && (
                <a className="underline" href={publishUrl} target="_blank" rel="noreferrer">
                  View the file →
                </a>
              )}
              {publishMsg && <span className="block mt-1 text-band-mid">{publishMsg}</span>}
            </Alert>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep('compose')} className={ghostBtn}>
              ← Back to edit
            </button>
            <button onClick={handlePublish} disabled={!canPublish} className={primaryBtn}>
              {publishState === 'saving' ? 'Saving…' : 'Commit to repo'}
            </button>
          </div>
        </div>
      )}
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

function StepNav({ step, setStep, authed }: { step: Step; setStep: (s: Step) => void; authed: boolean }) {
  const steps: [Step, string][] = [
    ['auth', '1 · Connect'],
    ['compose', '2 · Compose'],
    ['publish', '3 · Publish'],
  ];
  return (
    <div className="mb-6 flex gap-2 font-ui text-xs uppercase tracking-wide">
      {steps.map(([key, label]) => {
        const active = step === key;
        const reachable = key === 'auth' || authed;
        return (
          <button
            key={key}
            onClick={() => reachable && setStep(key)}
            disabled={!reachable}
            className={`rounded-full px-3 py-1 transition-colors ${
              active ? 'bg-ink text-paper' : reachable ? 'bg-paper-2 text-ink-soft hover:text-ink' : 'bg-paper-2 text-ink-faint'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
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
