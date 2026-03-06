import { defineConfig } from "vite";

// When deploying to GitHub Pages as a project page (not a user/org page),
// set BASE to the repo name, e.g. "/YouDontKnowZurich/".
// For local dev and user-page deploys, "./" works fine.
const BASE = process.env.VITE_BASE_URL ?? "./";

export default defineConfig({
  base: BASE,
  build: {
    outDir: "dist",
  },
});
