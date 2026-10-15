import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => {
  // Where the dev server forwards /api/*. Inside compose this is the api service.
  const { API_PROXY_TARGET = "http://localhost:3000" } = loadEnv(
    mode,
    ".",
    "API_",
  );

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      // The browser only ever talks to its own origin; /api/health -> /health.
      // nginx does the same in the runtime image, so the api needs no CORS.
      proxy: {
        "/api/": {
          target: API_PROXY_TARGET,
          rewrite: (path) => path.replace(/^\/api\//, "/"),
        },
      },
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
