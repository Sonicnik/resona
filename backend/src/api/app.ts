import express from "express";
import type { Services } from "../container.ts";
import { apiRouter } from "./routes.ts";
import { errorHandler, localOnly } from "./http.ts";

export function createApp(services: Services): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(localOnly({ allowedOrigins: services.config.allowedOrigins, token: services.config.apiToken }));
  app.use(express.json({ limit: "25mb" })); // LinkedIn archives can be posted inline
  app.use("/api", apiRouter(services));
  if (services.config.staticDir) app.use(express.static(services.config.staticDir));
  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such endpoint. See docs/api-reference.md." } });
  });
  app.use(errorHandler);
  return app;
}
