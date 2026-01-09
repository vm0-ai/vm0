import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    port: 3002,
    strictPort: true,
    host: true,
    allowedHosts: ["platform.vm7.ai"],
  },
  build: {
    outDir: "dist",
  },
});
