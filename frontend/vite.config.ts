import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

function e2eApiMiddleware(): Plugin {
  return {
    name: "e2e-api-middleware",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/api/photos/upload")) {
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ status: "ok", id: "photo-1", url: "/placeholder-photo.jpg" }));
          return;
        }
        if (req.method === "POST" && req.url && req.url.includes("/reports/")) {
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ status: "ok", id: "report-1" }));
          return;
        }
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), e2eApiMiddleware()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/healthz": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: () => "/api/health",
      },
    },
    headers: {
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.open-meteo.com; frame-ancestors 'none'; base-uri 'self';",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
    },
  },
});
