import build from "@hono/vite-build/vercel";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    copyPublicDir: false,
  },
  plugins: [
    build({
      emptyOutDir: true,
      entry: "./src/index.ts",
    }),
  ],
});
