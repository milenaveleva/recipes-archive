/**
 * Client-only island on a recipe detail page. When the page carries a pending
 * edit for this recipe (committed but not yet rebuilt), it hides the stale static
 * content (`#recipe-static`) and renders the full RecipePreview from the stored
 * recipe, so every field reflects the change immediately. A pending delete shows
 * a "rebuilding" notice over the (still-listed) content. Reconciles by build
 * time: once the rebuilt page reflects the edit, the override is dropped and the
 * static content shows. Renders nothing in the common (no-pending) case.
 *
 * Resilience: the static recipe is the source of truth and must never stay gated
 * behind JS. An ErrorBoundary reveals the static content if RecipePreview throws,
 * and the pre-paint inline script (in [slug].astro) reveals it after a timeout if
 * this island never confirms it took over (bundle blocked / offline). The island
 * confirms by calling `markReady` once the preview actually renders.
 */
import { useEffect, useState } from 'react';
import { prunePending, dropPending, isBuildFresh, type PendingMutation } from '../../core/pending';
import RecipePreview from './RecipePreview';
import { PreviewBoundary } from './PreviewBoundary';

type View =
  | { kind: 'none' }
  | { kind: 'fresh' } // rebuilt at/after the commit — drop override, show static
  | { kind: 'delete' }
  | { kind: 'preview'; recipe: NonNullable<PendingMutation['recipe']> };

function resolve(slug: string): View {
  const buildTime =
    Number(document.querySelector<HTMLMetaElement>('meta[name="x-build-time"]')?.content) || 0;
  const m = prunePending(Date.now()).find((x) => x.slug === slug);
  if (!m) return { kind: 'none' };
  if (m.kind === 'delete') return { kind: 'delete' };
  if (isBuildFresh(m, buildTime)) return { kind: 'fresh' };
  if (!m.recipe) return { kind: 'none' };
  return { kind: 'preview', recipe: m.recipe };
}

const staticEl = () => document.getElementById('recipe-static');
function hideStatic() {
  const s = staticEl();
  if (s) s.style.display = 'none';
}
function revealStatic() {
  const s = staticEl();
  if (s) s.style.display = '';
  document.getElementById('pending-static-hide')?.remove();
}
function markReady() {
  (window as unknown as { __pendingPreviewReady?: boolean }).__pendingPreviewReady = true;
}

export default function PendingDetailView({ slug }: { slug: string }) {
  // client:only, so this runs on the client and may read localStorage immediately.
  const [view] = useState<View>(() => resolve(slug));
  const [failed, setFailed] = useState(false);
  const showPreview = view.kind === 'preview' && !failed;

  useEffect(() => {
    if (view.kind === 'fresh') dropPending(slug);
    if (showPreview) hideStatic();
    else revealStatic();
  }, [slug, view, showPreview]);

  if (showPreview) {
    return (
      <PreviewBoundary onError={() => setFailed(true)}>
        <RecipePreview recipe={view.recipe} onReady={markReady} />
      </PreviewBoundary>
    );
  }
  if (view.kind === 'delete') {
    return (
      <div className="mx-auto max-w-5xl px-5 sm:px-8 pt-6">
        <p
          role="status"
          className="rounded-lg border border-spice/40 bg-spice/5 px-4 py-3 font-ui text-sm text-ink-soft"
        >
          This recipe has been deleted — it’ll disappear once the site finishes rebuilding (about a
          minute).
        </p>
      </div>
    );
  }
  return null;
}
