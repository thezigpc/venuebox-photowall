import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the client runs on :5190 and talks to the server on :3014 (proxied).
export default defineConfig({
  // Relative asset URLs, so the built page works at the root and under a prefix (/photowall/;
  // the server injects <base href="/photowall/">).
  base: "./",
  plugins: [react()],
  server: {
    host: true,
    port: 5190,
    proxy: {
      "/photos": "http://localhost:3014",
      "/api": "http://localhost:3014",
      "/__bargames": "http://localhost:3014",
    },
  },
});
