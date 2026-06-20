/**
 * Client-only island for the 404 page. A just-published recipe has no built
 * /recipes/<slug> page yet, so its card link lands here. If a pending create/edit
 * with a stored recipe matches the path, render the full RecipePreview plus an
 * Edit link, so the recipe is viewable + editable the moment it's committed —
 * instead of a dead 404. Otherwise (or if the preview throws) the static "not
 * found" content shows, so the page is never left blank.
 */
import { useEffect, useState } from 'react';
import { prunePending } from '../../core/pending';
import type { RecipeDraft } from '../../core/markdown';
import RecipePreview from './RecipePreview';
import { PreviewBoundary } from './PreviewBoundary';
import { withBase } from '../../lib/url';

function resolve(): { slug: string; recipe: RecipeDraft } | null {
  let slug: string | null = null;
  try {
    const m = /\/recipes\/([^/]+)\/?$/.exec(window.location.pathname);
    slug = m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null; // malformed percent-escape in the path → no match
  }
  if (!slug) return null;
  const hit = prunePending(Date.now()).find(
    (x) => x.slug === slug && (x.kind === 'create' || x.kind === 'edit') && x.recipe,
  );
  return hit?.recipe ? { slug, recipe: hit.recipe } : null;
}

const staticEl = () => document.getElementById('notfound-static');
function hideStatic() {
  const s = staticEl();
  if (s) s.style.display = 'none';
}
function revealStatic() {
  const s = staticEl();
  if (s) s.style.display = '';
  document.getElementById('notfound-static-hide')?.remove();
}
function markReady() {
  (window as unknown as { __pendingFallbackReady?: boolean }).__pendingFallbackReady = true;
}

export default function PendingFallback() {
  const [found] = useState(resolve);
  const [failed, setFailed] = useState(false);
  const show = !!found && !failed;

  useEffect(() => {
    if (show) hideStatic();
    else revealStatic();
  }, [show]);

  if (!show || !found) return null;
  return (
    <PreviewBoundary onError={() => setFailed(true)}>
      <RecipePreview recipe={found.recipe} onReady={markReady} />
      <a
        href={withBase(`/add?edit=${encodeURIComponent(found.slug)}`)}
        aria-label="Edit recipe"
        className="group fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-ink text-paper no-underline shadow-xl ring-1 ring-ink/10 transition-[transform,background-color] duration-200 hover:scale-110 hover:bg-spice active:scale-95 sm:bottom-8 sm:right-8"
      >
        <span className="pointer-events-none absolute right-full mr-3 hidden whitespace-nowrap rounded-full bg-ink px-3 py-1.5 font-ui text-xs text-paper opacity-0 shadow-md transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 sm:block">
          Edit recipe
        </span>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      </a>
    </PreviewBoundary>
  );
}
