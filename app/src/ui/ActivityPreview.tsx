// The Activities page's quick look at one activity, opened under its row and hung under
// its name. Left: the track on a still image of the basemap, with the ways out under it
// (the map, the provider pages). Beside it, the map panel's stats (plus the time span
// the panel puts in its subtitle) and the buttons; under both, the panel's charts,
// side by side. Hovering a chart moves a marker along the track.

import { useMemo, useState, type CSSProperties } from "react";
import { ActivityChartsBlock, ActivityStats } from "./ActivitySummary";
import { useActivityDetail } from "./useActivityDetail";
import { useElementWidth } from "./useElementWidth";
import { MapIcon } from "./icons";
import { actionSize, ProviderLink } from "./ProviderLink";
import { primaryButton, R } from "./theme";
import { trackSketch } from "../trackSketch";
import { projector } from "../homeCamera";
import { cursorLngLat } from "../routeCursor";
import type { DetailState } from "../detail";
import { ROUTE_GLOW, ROUTE_LINE } from "../routePath";
import { MAPBOX_TOKEN, STATIC_STYLE_URL, staticMapUrl } from "../mapStyle";
import type { StatCard } from "../stats";
import { activityLinks, formatDuration, timeSpan } from "../format";
import type { ActivityRecord, Theme } from "../types";

/** The track box's size in CSS px (the map image's too); it scales to the box's width. */
const TRACK_W = 320;
const TRACK_H = 200;

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
  /** The heart-rate zones' lower bounds (activities.json's hr_zone_limits), to color the heart-rate line. */
  zoneLimits?: readonly number[];
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
  zoneLimits,
}: Props) {
  const sketch = useMemo(() => (coords ? trackSketch(coords, TRACK_W, TRACK_H, 20, 1.5) : null), [coords]);
  // The basemap under the route (mapStyle.ts: STATIC_STYLE_URL), taken with the camera
  // the route was drawn with. The grid shows until it loads, and stays if it fails.
  const mapUrl = sketch && token ? staticMapUrl(STATIC_STYLE_URL[theme], sketch.camera, TRACK_W, TRACK_H, token) : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const links = activityLinks(a.sources);

  // The samples, as the map panel loads them when an activity is selected.
  const fetched = useActivityDetail(givenDetail ? null : a.id, a.detail === true);
  const detailState = givenDetail ?? fetched;
  const detail = detailState.status === "ready" ? detailState.detail : null;
  const time = useMemo(() => timeCard(a), [a]);
  const extra = useMemo(() => (time ? [time] : []), [time]);
  // Five stats share one row where the column is wide enough; three to a row otherwise.
  const [sideRef, sideW] = useElementWidth<HTMLDivElement>(800);

  // The chart's cursor, and where it sits on the track, through the sketch's camera.
  const [cursor, setCursor] = useState<number | null>(null);
  const marker = useMemo(() => {
    const at = detail && sketch ? cursorLngLat(detail, cursor) : null;
    return at && sketch ? projector(sketch.camera, TRACK_W, TRACK_H)(at[0], at[1]) : null;
  }, [detail, sketch, cursor]);

  // Short labels, at their own width beside the track; on a phone they fill its width.
  const stretch = mobile;
  const actionButton: CSSProperties = { ...actionSize, flex: stretch ? "1 1 auto" : "none" };
  const actions = (onShowOnMap || links.length > 0) && (
    <div style={actionRow}>
      {onShowOnMap && (
        <button
          type="button"
          className="ctl-accent"
          // On a phone, with two provider links, it takes its own line and they share the next.
          style={{ ...primaryButton, ...actionButton, ...(stretch && links.length > 1 && { flexBasis: "100%" }) }}
          onClick={onShowOnMap}
        >
          <MapIcon />
          Show on map
        </button>
      )}
      {links.map((l) => (
        <ProviderLink key={l.url} link={l} style={{ flex: actionButton.flex }} />
      ))}
    </div>
  );

  return (
    <div
      id={id}
      className="activities__preview"
      data-track={sketch ? "" : undefined}
      data-compact={mobile ? "" : undefined}
    >
      {/* No route, no box: the row already says "No route". */}
      {sketch && (
        // A click on the track does what the Show on map button says; the button is the
        // keyboard's and the screen reader's way in, so the box takes no focus.
        <div className="activities__track" style={{ ...trackBox, cursor: onShowOnMap ? "pointer" : undefined }} onClick={onShowOnMap}>
            {mapUrl && (
              <img
                src={mapUrl}
                alt=""
                decoding="async"
                onLoad={() => setLoadedUrl(mapUrl)}
                style={{ ...fill, objectFit: "cover", opacity: loadedUrl === mapUrl ? 1 : 0, transition: "opacity .25s" }}
              />
            )}
            {/* Cropped like the image (cover), so the route stays on its roads. */}
            <svg
              viewBox={`0 0 ${TRACK_W} ${TRACK_H}`}
              preserveAspectRatio="xMidYMid slice"
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
      )}

      <div ref={sideRef} style={{ ...side, maxWidth: sketch || mobile ? undefined : 720 }}>
        <ActivityStats activity={a} extraCards={extra} columns={mobile || sideW < 560 ? 3 : undefined} />
        {!mobile && actions}
      </div>

      {/* The charts span the preview, the track box's column too: side by side, three
          across where they fit. */}
      <div className="activities__preview-wide">
        <ActivityChartsBlock
          activity={a}
          detail={detailState}
          cursor={cursor}
          onCursor={setCursor}
          minColumn={240}
          routeLinked={false}
          zoneLimits={zoneLimits}
        />
      </div>
      {mobile && actions && <div className="activities__preview-wide">{actions}</div>}
    </div>
  );
}

/** Stops long enough to mention: elapsed this much past moving time. */
const STOPPED_S = 120;

/**
 * When: the local start to finish, naming the elapsed time when it stopped along the
 * way; just the start without an elapsed time; nothing without a local start.
 */
export function timeCard(a: ActivityRecord): StatCard | null {
  const span = timeSpan(a.start_local, a.elapsed_time);
  if (!span) return null;
  if (a.elapsed_time === undefined) return { value: span, label: "Start time" };
  const stopped = a.moving_time !== undefined && a.elapsed_time - a.moving_time >= STOPPED_S;
  return { value: span, label: stopped ? `Time · ${formatDuration(a.elapsed_time)} elapsed` : "Time", wide: true };
}


// Beside the stats, the box takes their height (index.css: .activities__track), within
// limits that crop no more than the sketch's margin; the image and the route drawing
// both fill it and crop alike. Stacked, it keeps the image's shape.
const trackBox: CSSProperties = {
  position: "relative",
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

const side: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 18,
};


const actionRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };




