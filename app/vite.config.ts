import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH is the Pages site's path prefix, set by the deploy workflow from
// actions/configure-pages: empty on a custom domain (served from the root),
// "/<repo>" on <user>.github.io. Unset locally, so dev and preview serve from "/".
export default defineConfig({
  base: `${process.env.BASE_PATH ?? ""}/`,
  envDir: "..",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep the rarely changing vendors in their own chunks: a normal app
        // change then invalidates only the small app chunk, not mapbox-gl. Other
        // deps are left to Rollup, so one used only by the lazy map stays lazy.
        manualChunks(id) {
          if (id.includes("/node_modules/mapbox-gl/")) return "mapbox";
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
});
