import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: { rollupOptions: { output: { format: "iife" } } },
  plugins: [
    {
      name: "local-webview-assets",
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
