// Owns the Mapbox GL map: renders all activity routes as one line layer and
// applies the active filter. Presentation (style, colors, layout) is intentionally
// minimal — Claude Design will restyle this later against the same data contract.

import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { buildFilter, type FilterState } from "./filters";
import type { ActivityFeatureCollection } from "./types";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

const SOURCE_ID = "activities";
const LAYER_ID = "activities-line";

interface Props {
  data: ActivityFeatureCollection | null;
  filter: FilterState;
}

/** Fit the map viewport to the bounding box of all route coordinates. */
function fitToData(map: mapboxgl.Map, data: ActivityFeatureCollection) {
  const bounds = new mapboxgl.LngLatBounds();
  for (const f of data.features) {
    for (const c of f.geometry.coordinates) {
      bounds.extend(c as [number, number]);
    }
  }
  if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40, duration: 0 });
}

export function MapView({ data, filter }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const loadedRef = useRef(false);

  // Init map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [0, 20],
      zoom: 1.5,
    });
    mapRef.current = map;
    map.on("load", () => {
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#fc4c02", "line-width": 2, "line-opacity": 0.6 },
      });
      loadedRef.current = true;
      if (data) {
        (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource).setData(data);
        fitToData(map, data);
      }
    });
    return () => {
      map.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
  }, []);

  // Update source when data arrives/changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !data) return;
    (map.getSource(SOURCE_ID) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
    fitToData(map, data);
  }, [data]);

  // Apply filter changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer(LAYER_ID)) return;
    map.setFilter(LAYER_ID, buildFilter(filter));
  }, [filter]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
