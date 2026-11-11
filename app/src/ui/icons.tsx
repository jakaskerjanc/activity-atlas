// The house icon set: stroked 24px-grid glyphs that inherit currentColor, so every
// control (header, panels, replay) shares one stroke weight and style.

import { iconProps } from "./theme";

type P = { size?: number };

export function ChevronIcon({ size = 16, dir }: P & { dir: "left" | "right" | "up" | "down" }) {
  const d = { left: "M15 5l-7 7 7 7", right: "M9 5l7 7-7 7", up: "M5 15l7-7 7 7", down: "M5 9l7 7 7-7" }[dir];
  return (
    <svg {...iconProps(size)}>
      <path d={d} />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function FiltersIcon({ size = 16 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  );
}

/** Solid transport glyphs, optically centered (the triangle's mass sits right of center). */
export function PlayIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

export function PauseIcon({ size = 16 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4.2" height="14" rx="1.2" />
      <rect x="13.8" y="5" width="4.2" height="14" rx="1.2" />
    </svg>
  );
}

export function RestartIcon({ size = 16 }: P) {
  return (
    <svg {...iconProps(size)} strokeWidth={2.4}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" />
    </svg>
  );
}

export function MapIcon({ size = 15 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4zM9 4v13.5M15 6.5V20" />
    </svg>
  );
}

export function ChartIcon({ size = 15 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />
    </svg>
  );
}

export function SunIcon({ size = 17 }: P) {
  return (
    <svg {...iconProps(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  );
}

export function MoonIcon({ size = 16 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  );
}

export function ExternalIcon({ size = 13 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 14 }: P) {
  return (
    <svg {...iconProps(size)}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** A peak, solid: the places list's mark for a summit. */
export function PeakIcon({ size = 12 }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 4.5 21.5 19.5h-19z" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** A saddle between two shoulders: the places list's mark for a pass. */
export function SaddleIcon({ size = 12 }: P) {
  return (
    <svg {...iconProps(size)} strokeWidth={2.6}>
      <path d="M2.5 18.5 7 8.5c1.8 3.2 3 4.5 5 4.5s3.2-1.3 5-4.5l4.5 10" />
    </svg>
  );
}
