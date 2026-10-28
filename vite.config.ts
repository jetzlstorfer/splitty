import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RECEIPT_ASSET_PATH, RECEIPT_CACHE, receiptAssets } from "./src/receiptAssets";

const ocrFiles = Object.entries(receiptAssets).map(([name, source]) => ({
  url: `${RECEIPT_ASSET_PATH}/${name}`,
  source: resolve("node_modules", source),
  contentType: name.endsWith(".gz") ? "application/gzip" : name.endsWith(".txt") ? "text/plain" : "text/javascript"
}));

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-receipt-assets",
      generateBundle() {
        for (const file of ocrFiles) {
          this.emitFile({ type: "asset", fileName: file.url.slice(1), source: readFileSync(file.source) });
        }
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const file = ocrFiles.find((candidate) => candidate.url === request.url);
          if (!file) return next();
          response.setHeader("Content-Type", file.contentType);
          response.end(readFileSync(file.source));
        });
      }
    },
    VitePWA({
      registerType: "prompt",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Splitty - Gemeinsame Ausgaben",
        short_name: "Splitty",
        description: "Gemeinsame Ausgaben einfach teilen. Nur für zwei.",
        lang: "de",
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
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        globIgnores: ["**/receipt-ocr-*/**"],
        navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/receipt-ocr-/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [{
          urlPattern: ({ url }) => url.origin === self.location.origin && url.pathname.startsWith("/receipt-ocr-v1/"),
          handler: "CacheFirst",
          options: { cacheName: RECEIPT_CACHE, cacheableResponse: { statuses: [200] } }
        }]
      }
    })
  ],
  server: {
    proxy: { "/api": { target: "http://127.0.0.1:7071", changeOrigin: false } }
  }
});
