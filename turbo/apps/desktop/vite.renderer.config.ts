import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.join(__dirname, "src", "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(__dirname, "dist", "renderer"),
    emptyOutDir: true,
  },
});
