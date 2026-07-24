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

Returns the `top`/`left` the library must receive so the panel's visual box lands on the
anchor after `translate(-50%, -50%)`:

- `{top, left}` → `top: (top + h/2)px`, `left: (left + w/2)px`
- `{bottom, centerX}` → `top: calc(100% - (bottom + h/2)px)`, `left: "50%"` (the -50% X
  translate does the horizontal centering natively)

Always `top`/`left`, never `bottom`/`right`: the library copies only `position/top/left`
onto its rim and highlight layers, so any edge it doesn't read leaves those layers
stranded at their `left: 50%` default — a ghost rounded rectangle floating over the map.
This was caught on the first screenshot pass, not in review.

Pure and total, so it is unit-tested with vitest alongside `stats.ts` / `replay.ts`.
There is no component-test setup in this repo and none is being added.

### `ui/GlassPanel.tsx` — the adapter

Owns positioning and material for all three panels.

- Props: `anchor`, `width`, `maxHeight?`, `cornerRadius`, `elasticity`, `theme`, `children`.
- A `ResizeObserver` on the content div supplies `{w, h}`; `glassOffsets` turns that into
  the style handed to `LiquidGlass`. The panel is `visibility: hidden` for the single
  frame before the first measurement, so it never paints half-offset.
- The content div resets the library's font declaration and text-shadow, and owns
  `width`, `display: flex; flexDirection: column` and `maxHeight`.

**Padding lives on the content, not the glass.** The library's box is `overflow: hidden`,
so an accent glow (`box-shadow: 0 0 16px`) painted past the panel's inset is cut off.
Holding the inset inside the content box turns it into bleed room instead. `insetX`/
`insetY` must therefore be at least the largest glow in the panel: 18 for the replay
bar's play button (16px), 18 horizontally for the side panel's type dots (10px).

**Scrolling is opt-in via `maxHeight`.** A vertical scroll container clips horizontally
too, so panels that don't need it stay `overflow: visible`. When a panel does scroll, a
6px `GUTTER` moves back onto the glass so the scrollbar clears the 16px corner radius,
and the scroller takes a `.glass-scroll` class for a thin, dim bar.

### `ui/theme.ts` — per-theme material

`glassMaterial(theme)` returns `{ mode, displacementScale, blurAmount, saturation,
aberrationIntensity, overLight }`. Both themes use `mode: "shader"`, `blurAmount: 0` and
`overLight: false`, which lands both on the library's 4px blur floor — the panels
refract rather than frost. Dark: saturation 140, displacement 60. Light: saturation 180,
displacement 45.

`overLight: false` in the light theme is deliberate. It is the only way down to the 4px
floor (`overLight` raises it to 12), it stops the library halving `displacementScale`,
and it swaps the hardcoded `0 16px 70px rgba(0,0,0,.75)` shadow for a much lighter one —
all three wanted here. Its fourth effect, the darkening overlays, never applied: those
are Tailwind-classed and this app has no Tailwind.

`PANEL_STYLE` and `INFO_PANEL_STYLE` are deleted — both positioning and material move
into `GlassPanel`. `ACCENT`, `MONO` and `eyebrow` are unchanged.

### Call sites

| Surface | Anchor | Notes |
| --- | --- | --- |
| `SidePanel` | `{top: 82, left: 24}` | width 296, `insetX 18`, `maxHeight: calc(100vh - 134px)`, `elasticity 0` |
| `InfoPanel` | `{bottom: 24, centerX: true}` | width 420, inset 18, `elasticity 0` |
| `ReplayBar` | `{bottom: 24, centerX: true}` | same slot as `InfoPanel` |
| Header toggle | fixed 38×38 | `LiquidGlass` directly, `cornerRadius 12`, `padding "0"`, `elasticity 0.3` |

The toggle needs no measuring: a zero-sized wrapper marks its center (22px in from the
right, centered in the 62px header) and the glass sits at `top/left: 0` inside it, where
its own `translate(-50%, -50%)` centers it — which also keeps the rim layers aligned.

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
- Launch the app and screenshot both themes.

Confirmed live:

- React 19's `useId()` emits `_r_0_` — plain ASCII, and `document.getElementById` resolves
  the id inside `filter: url(#…)` on all three panels.
- Anchors land exactly: side panel `top 82 / left 24`, info panel and replay bar both
  `bottom 24` centered on the viewport, toggle `top 12 / right 22`.
- Panel offsets recompute as content height changes (filter toggles, selection).
- The `.side-panel` mobile hide still works through the glass wrapper.
- Range sliders drag normally inside the glass; panels do not drift (`elasticity 0`).
- No console or page errors in either theme.

**Not verified:** frame rate. Headless Chromium has no GPU, and a rAF probe returned
1–2 fps both with the glass and with it hidden — the harness floor, not a signal. Needs
a look on real hardware while panning and during replay.

## Risks

- **Legibility.** With no tint layer, dark-theme panel text sits on clear blur over a
  dark map. The library's own text-shadow helps. If contrast reads poorly, it gets
  flagged rather than silently fixed with a fill.
- **Performance.** Three simultaneous displacement filters over an animating WebGL
  canvas is the main unknown. Mitigation if needed: lower `displacementScale`/`blurAmount`.
- **Maintenance.** v1.1.1 is the latest release and is a year old.
