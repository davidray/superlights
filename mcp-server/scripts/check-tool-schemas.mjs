#!/usr/bin/env node
// Regression guard: every tool registered on the server must declare an outputSchema
// and readOnlyHint/destructiveHint/idempotentHint annotations, so a future tool added
// without them doesn't quietly slip back to "the model has to guess the response shape."
//
// Talks to the built server over real stdio JSON-RPC (same as a real MCP client), rather
// than importing src/index.ts directly, so this also catches the server failing to start.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distIndex = join(__dirname, "..", "dist", "index.js");

function callServer(requests) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [distIndex], { stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    let buf = "";
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Timed out waiting for a response from dist/index.js. Did `npm run build` run first?"));
    }, 5000);

    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON startup log line (e.g. dotenv's banner)
        }
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    (async () => {
      for (const req of requests) {
        proc.stdin.write(JSON.stringify(req) + "\n");
        if (req.id === undefined) continue; // notification, no response to await
        while (!responses.has(req.id)) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
      clearTimeout(timeout);
      proc.kill();
      resolve(responses);
    })();
  });
}

const responses = await callServer([
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check-tool-schemas", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
]);

const listResult = responses.get(2)?.result;
if (!listResult || !Array.isArray(listResult.tools)) {
  console.error("tools/list did not return a tool list:", JSON.stringify(responses.get(2)));
  process.exit(1);
}

const { tools } = listResult;
if (tools.length === 0) {
  console.error("tools/list returned zero tools -- that's certainly wrong.");
  process.exit(1);
}

const problems = [];
for (const tool of tools) {
  if (!tool.outputSchema || tool.outputSchema.type !== "object") {
    problems.push(`${tool.name}: missing outputSchema`);
  }
  const hints = tool.annotations ?? {};
  if (typeof hints.readOnlyHint !== "boolean") {
    problems.push(`${tool.name}: missing annotations.readOnlyHint`);
  } else if (!hints.readOnlyHint && (typeof hints.destructiveHint !== "boolean" || typeof hints.idempotentHint !== "boolean")) {
    problems.push(`${tool.name}: non-read-only tool missing destructiveHint/idempotentHint`);
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} tool(s) missing schema/annotation conventions:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}

console.log(`OK: all ${tools.length} tools declare outputSchema and annotations.`);
