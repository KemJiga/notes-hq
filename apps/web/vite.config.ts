import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "notes-hq",
        short_name: "notes",
        description: "Local-first notes that sync across your own devices.",
        theme_color: "#2f6f5e",
        background_color: "#fbfaf8",
        display: "standalone",
        start_url: "/",
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        navigateFallback: "/index.html",
        // Never let the service worker touch relay or health endpoints.
        navigateFallbackDenylist: [/^\/v1\//, /^\/healthz/],
      },
    }),
  ],
  server: { host: true },
});
