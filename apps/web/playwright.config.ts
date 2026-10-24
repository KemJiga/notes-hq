import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;

// The relay serves the built app (STATIC_DIR) on the same origin, so the app's default
// relay URL points at it. Run `bun run build` first.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun ../relay/src/server/main.ts",
    url: `http://localhost:${PORT}/healthz`,
    env: { PORT: String(PORT), HOST: "127.0.0.1", STATIC_DIR: "dist", DATA_DIR: join(tmpdir(), "notes-hq-e2e") },
  },
});
