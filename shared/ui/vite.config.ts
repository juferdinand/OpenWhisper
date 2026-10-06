import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

export default defineConfig({
  base: "./",
  build: {
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    rolldownOptions: { output: { format: "iife" } },
  },
  plugins: [
    {
      name: "local-webview-assets",
      generateBundle() {
        for (const locale of ["en", "de"]) this.emitFile({
          type: "asset", fileName: `locales/${locale}.json`,
          source: readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8"),
        });
      },
      apply: "build",
      // A classic bundle can be loaded by WKWebView from the signed app's local resources.
      // No local server, remote UI, or file-origin CORS exception is needed.
      transformIndexHtml: {
        order: "post",
        handler: (html) =>
          html
            .replace(/<script /g, "<script defer ")
            .replace(/type="module"\s*/g, "")
            .replace(/\bcrossorigin\b/g, ""),
      },
    },
  ],
});
