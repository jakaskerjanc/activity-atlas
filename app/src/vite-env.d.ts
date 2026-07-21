/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public, URL-restricted Mapbox access token (build-time). */
  readonly VITE_MAPBOX_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
