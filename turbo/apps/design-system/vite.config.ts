import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // The catalogue is published under a path, not a domain root.
  base: "./",
  plugins: [tailwindcss(), react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
