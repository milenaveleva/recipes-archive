/**
 * Error boundary for the optimistic preview islands. The static page (recipe
 * detail or 404) is the source of truth and must never stay gated behind JS, so
 * if RecipePreview throws on an unexpected stored shape this renders nothing and
 * calls `onError` — letting the host reveal the static content instead of a blank.
 */
import { Component, type ReactNode } from 'react';

export class PreviewBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}
