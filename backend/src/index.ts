import { loadConfig } from "./config.ts";
import { createServices } from "./container.ts";
import { createApp } from "./api/app.ts";

const config = loadConfig();
const services = createServices(config);
const app = createApp(services);

const server = app.listen(config.port, config.host, () => {
  console.log(`[resona] API listening on http://${config.host}:${config.port}/api`);
  console.log(`[resona] database: ${config.dbPath}`);
  console.log(`[resona] vault:    ${config.vaultDir}`);
  console.log(`[resona] AI:       ${services.ai.isAvailable() ? `enabled (${config.ai.model})` : "offline mode (no Claude credentials)"}`);
  if (config.schedulerEnabled) services.scheduler.start();
});

function shutdown(signal: string) {
  console.log(`[resona] ${signal} received, shutting down`);
  server.close(() => {
    services.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
