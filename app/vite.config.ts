import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from the root of a custom domain (https://strava-map.jakas.si/).
export default defineConfig({
  base: "/",
  envDir: "..",
  plugins: [react()],
});
