import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH is the Pages site's path prefix, set by the deploy workflow from
// actions/configure-pages: empty on a custom domain (served from the root),
// "/<repo>" on <user>.github.io. Unset locally, so dev and preview serve from "/".
export default defineConfig({
  base: `${process.env.BASE_PATH ?? ""}/`,
  envDir: "..",
  plugins: [react()],
});
