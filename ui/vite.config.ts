import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": "http://localhost:3000",
    },
  },
});
