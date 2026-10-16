import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Splitty - our shared expenses",
        short_name: "Splitty",
        description: "Shared expenses, simple splits. Just for two.",
        display: "standalone",
        start_url: "/",
        scope: "/",
        theme_color: "#ffffff",
        background_color: "#ffffff",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/],
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:7071", changeOrigin: false } }
  }
});
