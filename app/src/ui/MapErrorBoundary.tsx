// Keeps a map failure contained to the map. MapView is a lazy chunk (~520 kB gzip
// of mapbox-gl), so a flaky network or a redeploy that removed the old hashed file
// can reject its import; without a boundary React would unmount the whole app,
// panels and Analytics included. React caches a rejected lazy import, so the only
// way to retry is a reload, which the caller offers via onError.

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; onError: () => void };
type State = { failed: boolean };

export class MapErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
