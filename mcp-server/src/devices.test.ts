import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDevice } from "./devices.js";

// saveDevice's validation throws before it ever reads/writes devices.json, so these
// rejection-path tests don't touch disk. (Issue #4: an arbitrary host string, used
// later to build outbound HTTP URLs to that host in wledClient.ts, is an SSRF vector
// unless it's constrained to look like a bare hostname/IP.)

test("saveDevice rejects a host with a URL scheme", () => {
  assert.throws(() => saveDevice("eaves", "http://evil.example.com"), /Invalid host/);
});

test("saveDevice rejects a host with a path", () => {
  assert.throws(() => saveDevice("eaves", "192.168.1.50/../../etc"), /Invalid host/);
});

test("saveDevice rejects a host with whitespace", () => {
  assert.throws(() => saveDevice("eaves", "192.168.1.50 extra"), /Invalid host/);
});

test("saveDevice rejects an empty host", () => {
  assert.throws(() => saveDevice("eaves", ""), /Invalid host/);
});

test("saveDevice rejects an empty device name", () => {
  assert.throws(() => saveDevice("", "192.168.1.50"), /Device name is required/);
});

test("saveDevice accepts a bare IP or hostname, with an optional port, and persists it", async () => {
  // Point WLED_DEVICES_CONFIG at a scratch file before re-importing the module, so this
  // doesn't write to the real (tracked) devices.json -- devices.ts reads that path once,
  // at module load, so a fresh dynamic import (cache-busted via the query string) is
  // needed to pick up the override.
  const dir = mkdtempSync(join(tmpdir(), "devices-test-"));
  const configPath = join(dir, "devices.json");
  writeFileSync(configPath, "{}");
  const prevConfig = process.env.WLED_DEVICES_CONFIG;
  process.env.WLED_DEVICES_CONFIG = configPath;
  try {
    const mod = await import(`./devices.js?scratch=${Date.now()}`);
    const result = mod.saveDevice("eaves", "wled.local:8080");
    assert.deepEqual(result, [{ name: "eaves", host: "wled.local:8080" }]);
  } finally {
    if (prevConfig === undefined) delete process.env.WLED_DEVICES_CONFIG;
    else process.env.WLED_DEVICES_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
