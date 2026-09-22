// Mapbox's own filter evaluator, shipped inside mapbox-gl but without types at this
// path. Used by tests to run a filter expression exactly as the map would.
declare module "mapbox-gl/dist/style-spec/index.es.js" {
  export function featureFilter(filter: unknown): {
    filter(
      globals: { zoom: number },
      feature: { type: number; properties: object; geometry: unknown[] },
    ): boolean;
  };
}
