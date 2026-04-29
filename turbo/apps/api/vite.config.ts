import build from "@hono/vite-build/vercel";
import { defineConfig } from "vite";

import vercelConfig from "./vercel.json";

export default defineConfig({
  build: {
    copyPublicDir: false,
  },
  plugins: [
    build({
      emptyOutDir: true,
      entry: "./src/index.ts",
      vercel: {
        config: {
          crons: vercelConfig.crons,
        },
      },
    }),
  ],
});
