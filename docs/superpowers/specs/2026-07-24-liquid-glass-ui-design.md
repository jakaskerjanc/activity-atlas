# Liquid glass UI — design

Convert the floating chrome (side panel, info panel, replay bar, theme toggle) from
hand-rolled CSS glass to real refraction using
[`liquid-glass-react`](https://github.com/rdev/liquid-glass-react) v1.1.1 (MIT, no deps,
peer `react >= 19`).

## What the library actually does

Read from the unpacked package, because these constraints drive the whole design:

1. **Refraction is Chromium-only.** The effect is `backdrop-filter: blur() saturate()`
   plus an SVG displacement map applied via `filter: url(#id)`. The library nulls the
   filter on Firefox by user-agent sniff; Safari renders the blur but not the
   displacement.
2. **It ships Tailwind class names but no CSS.** This app has no Tailwind, so
   `bg-black`, `opacity-20`, `mix-blend-overlay`, `text-white` and `cursor-pointer` are
   inert. Consequence: `overLight` does **not** produce its darkening overlays here — it
   only raises the blur floor, halves `displacementScale`, and swaps the box-shadow.
3. **It always self-centers.** The rendered container gets
   `transform: translate(calc(-50% + Xpx), calc(-50% + Ypx)) <scale>`, and `style.transform`
   is overwritten. Any anchor must therefore be pre-compensated by half the panel's size.
   `style.position/top/left` do pass through (`baseStyle` is spread onto the container),
   but `top`/`left` fall back to `"50%"` when falsy — note `0` is falsy, so offsets are
   emitted as strings.
4. **The inner box is `display: inline-flex; align-items: center; gap: 24px; overflow: hidden`**
   with `font: 500 20px/1 system-ui` and a hardcoded dark `box-shadow` on the content
   wrapper. Content must bring its own font reset, column layout and scroll container.
5. **`elasticity: 0` fully disables motion** — both the elastic translation and the
   directional hover scale multiply through `elasticity`.
6. **`onClick` lands on a `div`** with no keyboard or assistive-tech affordance.

## Decisions

| Question | Choice |
| --- | --- |
| Which themes | Both dark and light, tuned separately |
| Non-Chromium fallback | Pure library look — no CSS tint/border underneath |
| Hover motion | Theme toggle only (`elasticity 0.3`); panels static (`0`) |

The fallback choice means Firefox and Safari show plain blurred rectangles with no
border. Accepted deliberately.

## Architecture

### `ui/glassOffsets.ts` — pure positioning math

```ts
type Anchor =
  | { top: number; left: number }
  | { bottom: number; centerX: true };

function glassOffsets(anchor: Anchor, size: { w: number; h: number }): CSSProperties
```

Returns the `top`/`left`/`bottom` the library must receive so the panel's visual box
lands on the anchor after `translate(-50%, -50%)`:

- `{top, left}` → `top: (top + h/2)px`, `left: (left + w/2)px`
- `{bottom, centerX}` → `bottom: (bottom - h/2)px`, `left: "50%"` (the -50% X translate
  does the horizontal centering natively)

Pure and total, so it is unit-tested with vitest alongside `stats.ts` / `replay.ts`.
There is no component-test setup in this repo and none is being added.

### `ui/GlassPanel.tsx` — the adapter

Owns positioning and material for all three panels.

- Props: `anchor`, `width`, `maxHeight?`, `cornerRadius`, `elasticity`, `theme`, `children`.
- A `ResizeObserver` on the content div supplies `{w, h}`; `glassOffsets` turns that into
  the style handed to `LiquidGlass`. The panel is `visibility: hidden` for the single
  frame before the first measurement, so it never paints half-offset.
- The content div resets the library's font declaration and text-shadow, and owns
  `width`, `display: flex; flexDirection: column`, `maxHeight` and `overflowY: auto`
  (the library's own box is `overflow: hidden` and cannot scroll).

### `ui/theme.ts` — per-theme material

`glassTheme(theme)` returns `{ displacementScale, blurAmount, saturation,
aberrationIntensity, overLight }`. Dark: `overLight: false`, lower blur, saturation ~140.
Light: `overLight: true`, saturation ~180.

`PANEL_STYLE` and `INFO_PANEL_STYLE` are deleted — both positioning and material move
into `GlassPanel`. `ACCENT`, `MONO` and `eyebrow` are unchanged.

### Call sites

| Surface | Anchor | Notes |
| --- | --- | --- |
| `SidePanel` | `{top: 82, left: 24}` | width 296, `maxHeight: calc(100vh - 182px)`, `elasticity 0` |
| `InfoPanel` | `{bottom: 24, centerX: true}` | width 420, `elasticity 0` |
| `ReplayBar` | `{bottom: 24, centerX: true}` | same slot as `InfoPanel` |
| Header toggle | fixed 38×38 | `LiquidGlass` directly, `cornerRadius 12`, `padding "0"`, `elasticity 0.3` |

`theme` is drilled from `App` into all four components, matching the existing plain-props
style of this codebase.

The theme toggle keeps a real `<button aria-label>` as the glass's child and does **not**
use the library's `onClick`, preserving keyboard and screen-reader access.

### CSS token cleanup

`--panel-bg`, `--panel-border` and `--panel-blur` stay: the error toast in `App.tsx`
still consumes them. `--panel-shadow`, `--panel-highlight` and `--glass-shadow-sm` lose
their last consumers and are removed from both theme blocks.

## Verification

- `npm run typecheck`, `npm --workspace app run build`, `npm --workspace app test`
- Launch the app and screenshot both themes. Two things checked live rather than assumed:
  1. React 19's `useId()` output resolves inside `filter: url(#…)` (the id contains
     non-ASCII guillemets; valid as a CSS identifier in principle, worth confirming).
  2. Frame rate while panning and during replay, with three `backdrop-filter` + SVG
     filter instances compositing over the Mapbox canvas.

## Risks

- **Legibility.** With no tint layer, dark-theme panel text sits on clear blur over a
  dark map. The library's own text-shadow helps. If contrast reads poorly, it gets
  flagged rather than silently fixed with a fill.
- **Performance.** Three simultaneous displacement filters over an animating WebGL
  canvas is the main unknown. Mitigation if needed: lower `displacementScale`/`blurAmount`.
- **Maintenance.** v1.1.1 is the latest release and is a year old.
