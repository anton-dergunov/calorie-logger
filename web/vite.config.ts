import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { load } from "js-yaml";

// The version identity every layer reports. The semantic version comes from the repository's own
// package.json; the build number is supplied by scripts/version.sh so that one build's web bundle,
// macOS application, and server release all name the same build. A bare `vite build` still gets a
// usable stamp of its own.
const repositoryPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
) as { version?: string };
const appVersion = process.env.CALORIE_LOGGER_VERSION || repositoryPackage.version || "0.0.0";
const appBuild = process.env.CALORIE_LOGGER_BUILD
  || new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

// The food catalogue and the picture catalogue are hand-edited YAML, which is pleasant to keep a
// hundred foods in and unpleasant to parse at runtime. They are converted here, so the bundle only
// ever carries the resulting data and no parser.
function yamlData(): Plugin {
  return {
    name: "calorie-logger-yaml",
    transform(source, id) {
      if (!id.endsWith(".yaml")) return null;
      return { code: `export default ${JSON.stringify(load(source))};`, map: null };
    }
  };
}

export default defineConfig({
  plugins: [yamlData(), react(), VitePWA({
    // The application asks before it updates. Taking the update automatically meant a silent
    // reload in the middle of whatever was being typed, after a long invisible download.
    registerType: "prompt",
    injectRegister: false,
    includeAssets: ["app-icon-64.png", "apple-touch-icon.png"],
    manifest: {
      name: "Calorie Logger",
      short_name: "Calorie Logger",
      description: "A calm, private calorie and macro logger.",
      theme_color: "#395a44",
      background_color: "#f4f2eb",
      display: "standalone",
      start_url: ".",
      scope: ".",
      // Lets `navigator.getInstalledRelatedApps()` recognise this very app, so a browser tab can
      // tell the owner it is already installed instead of silently dropping the install button.
      prefer_related_applications: false,
      related_applications: [{ platform: "webapp", url: "./manifest.webmanifest" }],
      icons: [
        { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
      ]
    },
    workbox: {
      // Every bundled asset type, so adding artwork or a font later does not quietly leave the
      // app unable to open offline. Only files in the build are listed here; photographs from
      // external food catalogues are transient and must never be cached.
      globPatterns: ["**/*.{html,js,css,svg,png,jpg,jpeg,webp,avif,gif,ico,woff,woff2,txt,json,bin,wasm,webmanifest}"],
      navigateFallback: "index.html",
      // The app shell answers navigations so it opens offline, but it must not answer for paths
      // the server owns: `/api/` is the Calorie Logger API, and `/_/` is PocketBase's own
      // dashboard, which is how the owner creates accounts after a deployment resets the database.
      navigateFallbackDenylist: [/^\/api\//, /^\/_\//],
      // Deliberately absent: skipWaiting and clientsClaim. The new worker waits until the person
      // accepts the update, which is what makes the offer meaningful.
      runtimeCaching: []
    }
  })],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_BUILD__: JSON.stringify(appBuild)
  },
  assetsInclude: ["**/*.bin"],
  // Food pictures always ship as files. Inlining the smallest of them scattered a few of the
  // catalogue's artwork into the JavaScript bundle as data URIs, where neither the precache check
  // nor the macOS host's decoding test can see them.

  base: "./",
  experimental: {
    // The macOS host injects the compiled JavaScript as a classic WKUserScript.
    // Document-relative asset paths work in both that host and an ordinary PWA,
    // while Vite's default `import.meta.url` form is module-only syntax.
    renderBuiltUrl(filename, { hostType }) {
      return hostType === "js" ? `./${filename}` : { relative: true };
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Food pictures always ship as files. Inlining the smallest of them scattered part of the
    // catalogue's artwork into the JavaScript bundle as data URIs, where neither the precache
    // check nor the macOS host's decoding test can see it.
    assetsInlineLimit: (file: string) => (file.endsWith(".webp") ? false : undefined)
  },
  test: { environment: "jsdom", globals: true }
});
