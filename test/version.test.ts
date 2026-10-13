import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SERVER_VERSION } from "../src/server.js";

test("package, lockfile, MCP server, and CLI versions stay in sync", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(SERVER_VERSION, pkg.version);
  for (const flag of ["--version", "-v"]) {
    const output = execFileSync(process.execPath, ["dist/cli.js", flag], { encoding: "utf8" });
    assert.equal(output.trim(), pkg.version);
  }
});
