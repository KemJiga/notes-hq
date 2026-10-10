import { loadConfig } from "./config.js";
import { startRelay } from "./server.js";

const config = loadConfig();
const relay = await startRelay(config);
const addr = relay.server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`notes-hq relay listening on ${config.host}:${port}`);
console.log(`  data:   ${config.dataDir}`);
if (config.staticDir) console.log(`  app:    serving ${config.staticDir}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await relay.close();
    process.exit(0);
  });
}
