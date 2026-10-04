import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../deploy/install.sh", import.meta.url).pathname;

// --dry-run prints the LaunchAgent instead of installing it, so nothing touches launchd here.
function dryRun(vpSettings: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "vp-home-"));
  try {
    return spawnSync("bash", [script, "--dry-run"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, ...vpSettings },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("writes every VP_* setting given at install time into the LaunchAgent", () => {
  const run = dryRun({ VP_UPSTREAM: "http://203.0.113.10:8000", VP_MODEL: "qwen3-vl:8b" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /<key>VP_UPSTREAM<\/key>\s*<string>http:\/\/203\.0\.113\.10:8000<\/string>/);
  assert.match(run.stdout, /<key>VP_MODEL<\/key>\s*<string>qwen3-vl:8b<\/string>/);
  assert.match(run.stdout, /<string>[^<]*\/src\/main\.ts<\/string>/);
});

test("leaves out settings that were not given, so the built-in defaults apply", () => {
  const run = dryRun({ VP_UPSTREAM: "http://203.0.113.10:8000" });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /VP_OLLAMA|VP_MODEL/);
});

test("refuses to install without VP_UPSTREAM", () => {
  const run = dryRun({});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /VP_UPSTREAM/);
});
