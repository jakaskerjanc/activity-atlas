// The loading indicator: a hilly route line drawing itself in, the finish ring popping
// at its end, then the line wiping away from the start before it draws again. A faint
// copy of the route stays underneath so the shape reads before the stroke reaches it.
// The animation lives in index.css (.route-loader); this only holds the geometry.

const ROUTE =
  "M6 22C9 16 12 15 14 19C17 26 21 33 27 30C33 27 35 11 40 10C44 9 43 27 48 27" +
  "C53 27 54 3 61 3C68 3 70 31 76 32C82 33 83 14 90 13C97 12 102 15 108 19";
const END = { x: 108, y: 19 };

/** Width in px; the height follows the 120×36 viewBox. */
export function RouteLoader({ width = 40 }: { width?: number }) {
  return (
    <svg
      className="route-loader"
      viewBox="0 0 120 36"
      width={width}
      height={(width * 36) / 120}
      fill="none"
      aria-hidden="true"
    >
      <path className="route-loader__track" d={ROUTE} />
      <path className="route-loader__line" d={ROUTE} pathLength={1} />
      <circle className="route-loader__finish" cx={END.x} cy={END.y} r={4} />
    </svg>
  );
}
