// dotenv's default lookup is relative to process.cwd(), which isn't reliably
// mcp-server/ -- whatever launches this process (Claude Code, systemd, HA's
// Supervisor) may set a different working directory. Resolve .env relative to
// this file's own location instead, matching every other config loader here.
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });
