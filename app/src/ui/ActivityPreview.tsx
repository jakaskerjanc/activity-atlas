// The Activities page's quick look at one activity, opened under its row: the track on
// a still image of the basemap, the activity's stat cards and its elevation chart (both
// the map panel's own, from the same detail file), a few more facts, and the ways out:
// the map and the provider pages. Hovering the chart moves a marker along the track, as
// on the map.

import { useMemo, useState, type CSSProperties } from "react";
import { StatGrid } from "./StatsSection";
import { ActivityCharts, detailMessage } from "./ActivityCharts";
import { useActivityDetail } from "./useActivityDetail";
import { ExternalIcon, MapIcon } from "./icons";
import { FS, MONO, primaryButton, R, secondaryButton } from "./theme";
import { trackSketch } from "../trackSketch";
import { projector } from "../homeCamera";
import { buildProfile } from "../profile";
import { cursorLngLat } from "../routeCursor";
import type { DetailState } from "../detail";
import { ROUTE_GLOW, ROUTE_LINE } from "../routePath";
import { MAPBOX_TOKEN, STATIC_STYLE_URL, staticMapUrl } from "../mapStyle";
import { activityCards } from "../stats";
import { activityLinks, formatClock } from "../format";
import type { ActivityRecord, Theme } from "../types";

/** The track box's size in CSS px (the map image's too); it scales to the box's width. */
const TRACK_W = 320;
const TRACK_H = 200;
/** The preview's one chart: the map panel draws the rest too. */
const CHART_KINDS = ["elevation"] as const;

interface Props {
  activity: ActivityRecord;
  /** The route as [lng, lat] points; absent for an activity without one. */
  coords?: readonly (readonly [number, number])[];
  /** The detail file's load state; tests pass one in, the preview fetches it otherwise. */
  detail?: DetailState;
  /** Show this activity on the map; omitted when it has no route. */
  onShowOnMap?: () => void;
  mobile?: boolean;
  id?: string;
  /** Picks the basemap style, as on the live map. */
  theme?: Theme;
  /** The Mapbox token for the map image; without one the route sits on a plain grid. */
  token?: string;
}

export function ActivityPreview({
  activity: a,
  coords,
  detail: givenDetail,
  onShowOnMap,
  mobile = false,
  id,
  theme = "dark",
  token = MAPBOX_TOKEN,
}: Props) {
  const sketch = useMemo(() => (coords ? trackSketch(coords, TRACK_W, TRACK_H, 20, 1.5) : null), [coords]);
  // The basemap under the route (mapStyle.ts: STATIC_STYLE_URL), taken with the camera
  // the route was drawn with. The grid shows until it loads, and stays if it fails.
  const mapUrl = sketch && token ? staticMapUrl(STATIC_STYLE_URL[theme], sketch.camera, TRACK_W, TRACK_H, token) : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  // Only the cards with a value: an indoor session has no distance, and a row of dashes
  // says nothing.
  const cards = useMemo(() => activityCards(a).filter((c) => c.value !== "—"), [a]);
  const links = activityLinks(a.sources);

  // The samples, as the map panel loads them when an activity is selected.
  const fetched = useActivityDetail(givenDetail ? null : a.id, a.detail === true);
  const detailState = givenDetail ?? fetched;
  const detail = detailState.status === "ready" ? detailState.detail : null;
  const profile = useMemo(() => (detail ? buildProfile(detail, a.type) : null), [detail, a.type]);
  const charted = profile?.charts.some((c) => c.kind === "elevation") === true;
  // Elapsed and the averages are in the chart's readout when it is there.
  const facts = previewFacts(a, charted);
  const message = a.detail ? detailMessage(detailState, charted) : null;

  // The chart's cursor, and where it sits on the track, through the sketch's camera.
  const [cursor, setCursor] = useState<number | null>(null);
  const marker = useMemo(() => {
    const at = detail && sketch ? cursorLngLat(detail, cursor) : null;
    return at && sketch ? projector(sketch.camera, TRACK_W, TRACK_H)(at[0], at[1]) : null;
  }, [detail, sketch, cursor]);

  return (
    <div
      id={id}
      className="activities__preview"
      style={{ gridTemplateColumns: mobile || !sketch ? "minmax(0, 1fr)" : "260px minmax(0, 1fr)" }}
    >
      {/* No route, no box: the row already says "No route". */}
      {sketch && (
        <div style={{ alignSelf: "start", minWidth: 0 }}>
          <div style={trackBox}>
            {mapUrl && (
              <img
                src={mapUrl}
                alt=""
                decoding="async"
                onLoad={() => setLoadedUrl(mapUrl)}
                style={{ ...fill, opacity: loadedUrl === mapUrl ? 1 : 0, transition: "opacity .25s" }}
              />
            )}
            <svg
              viewBox={`0 0 ${TRACK_W} ${TRACK_H}`}
              style={fill}
              role="img"
              aria-label={`Route of ${a.name}`}
            >
              {/* Drawn like the map's stand-in picture (RoutePreview): glow, then line. */}
              <g fill="none" stroke="var(--accent)" strokeLinecap="round" strokeLinejoin="round">
                <path d={sketch.d} strokeWidth={ROUTE_GLOW.width} strokeOpacity={ROUTE_GLOW.opacity} />
                <path d={sketch.d} strokeWidth={ROUTE_LINE.width} strokeOpacity={ROUTE_LINE.opacity} />
              </g>
              <circle cx={sketch.end[0]} cy={sketch.end[1]} r={4} fill="var(--accent)" stroke="var(--bg-raised)" strokeWidth={2} />
              <circle cx={sketch.start[0]} cy={sketch.start[1]} r={4.5} fill="var(--bg-raised)" stroke="var(--text-strong)" strokeWidth={2} />
              {marker && (
                <circle cx={marker[0]} cy={marker[1]} r={5} fill="var(--text-strong)" stroke="var(--accent)" strokeWidth={2.5} />
              )}
            </svg>
          </div>
        </div>
      )}

      {/* One column, as wide as the preview gives it: an implicit auto column would
          grow to the chart caption's unwrapped width and push everything off a phone. */}
      <div style={{ minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 12, alignContent: "start" }}>
        {cards.length > 0 && (
          <StatGrid cards={cards} compact columns={mobile ? Math.min(2, cards.length) : cards.length} />
        )}
        {facts.length > 0 && (
          <dl style={factRow}>
            {facts.map((f) => (
              <div key={f.label} style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <dt style={{ color: "var(--text-muted)" }}>{f.label}</dt>
                <dd style={{ margin: 0, fontFamily: MONO, color: "var(--text)" }}>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {detail && profile && charted ? (
          // ActivityCharts sets its own top margin for the map panel; the gap does it here.
          <div style={{ marginTop: -14 }}>
            <ActivityCharts
              detail={detail}
              profile={profile}
              type={a.type}
              cursor={cursor}
              onCursor={setCursor}
              kinds={CHART_KINDS}
              routeLinked={false}
            />
          </div>
        ) : (
          // Loading or failed; an activity without elevation samples just has no chart.
          message && detailState.status !== "ready" && <p style={statusLine}>{message}</p>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {onShowOnMap && (
            <button type="button" className="ctl-accent" style={primaryButton} onClick={onShowOnMap}>
              <MapIcon />
              Show on map
            </button>
          )}
          {links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ctl"
              style={{ ...secondaryButton, height: 36, textDecoration: "none" }}
            >
              {l.label}
              <ExternalIcon />
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The facts the stat cards leave out, each only when known. With the chart shown
 * (`charted`), elapsed and average heart rate are left to its readout.
 */
export function previewFacts(a: ActivityRecord, charted = false): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  // Local wall-clock start, as recorded ("2024-08-18T07:42:10" -> "07:42").
  if (a.start_local) facts.push({ label: "Started", value: a.start_local.slice(11, 16) });
  if (!charted && a.elapsed_time !== undefined) facts.push({ label: "Elapsed", value: formatClock(a.elapsed_time) });
  if (!charted && a.avg_hr !== undefined) facts.push({ label: "Avg HR", value: `${Math.round(a.avg_hr)} bpm` });
  if (a.max_hr !== undefined) facts.push({ label: "Max HR", value: `${Math.round(a.max_hr)} bpm` });
  return facts;
}

// The box keeps the image's shape (it never stretches beside taller stats, which would
// distort the map), and the image and the route drawing both fill it exactly.
const trackBox: CSSProperties = {
  position: "relative",
  aspectRatio: `${TRACK_W} / ${TRACK_H}`,
  borderRadius: R.md,
  border: "1px solid var(--card-grid)",
  overflow: "hidden",
  // A faint grid, so the track reads as a drawing on a surface rather than floating.
  backgroundColor: "var(--stat-cell-bg)",
  backgroundImage:
    "linear-gradient(var(--card-grid) 1px, transparent 1px), linear-gradient(90deg, var(--card-grid) 1px, transparent 1px)",
  backgroundSize: "24px 24px",
  backgroundPosition: "-1px -1px",
};

const fill: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "block",
  width: "100%",
  height: "100%",
};

const factRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  columnGap: 18,
  rowGap: 4,
  margin: 0,
  fontSize: FS.sm,
};

const statusLine: CSSProperties = {
  margin: 0,
  fontSize: FS.sm,
  color: "var(--text-muted)",
};
