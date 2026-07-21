// Top-level wiring: load the GeoJSON once, derive filter options, hold FilterState,
// and feed both the map and the (stub) filter panel.

import { useEffect, useMemo, useState } from "react";
import { MapView } from "./MapView";
import { FilterPanel } from "./ui/FilterPanel";
import { emptyFilter, type FilterState } from "./filters";
import type { ActivityFeatureCollection } from "./types";

const DATA_URL = `${import.meta.env.BASE_URL}activities.geojson`;

export default function App() {
  const [data, setData] = useState<ActivityFeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>(emptyFilter);

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((json: ActivityFeatureCollection) => setData(json))
      .catch((e) => setError(String(e)));
  }, []);

  const availableTypes = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.features.map((f) => f.properties.type))].sort();
  }, [data]);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <MapView data={data} filter={filter} />
      {data && (
        <FilterPanel
          availableTypes={availableTypes}
          filter={filter}
          onChange={setFilter}
        />
      )}
      {error && (
        <div style={{ position: "absolute", top: 12, right: 12, color: "#f66" }}>
          Failed to load activities: {error}
        </div>
      )}
    </div>
  );
}
