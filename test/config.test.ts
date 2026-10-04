import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

// 203.0.113.0/24 is TEST-NET-3, reserved for documentation examples.
const upstream = { VP_UPSTREAM: "http://203.0.113.10:8000" };

test("environment variables override the defaults", () => {
  const config = loadConfig({
    ...upstream,
    VP_PORT: "9999",
    VP_OLLAMA: "http://203.0.113.20:11434",
    VP_MODEL: "qwen3-vl:8b",
    VP_CAPTION_TIMEOUT_MS: "45000",
    VP_CACHE_DIR: "/tmp/vp-cache",
  });
  assert.equal(config.port, 9999);
  assert.equal(config.upstream, "http://203.0.113.10:8000");
  assert.equal(config.ollama, "http://203.0.113.20:11434");
  assert.equal(config.model, "qwen3-vl:8b");
  assert.equal(config.captionTimeoutMs, 45000);
  assert.equal(config.cacheDir, "/tmp/vp-cache");
});

test("requires VP_UPSTREAM, since there is no sensible default chat server", () => {
  assert.throws(() => loadConfig({}), /VP_UPSTREAM/);
});

test("expects the vision model on a local Ollama unless told otherwise", () => {
  assert.equal(loadConfig(upstream).ollama, "http://127.0.0.1:11434");
});

test("rejects a malformed number, naming the variable", () => {
  assert.throws(() => loadConfig({ ...upstream, VP_PORT: "11435abc" }), /VP_PORT/);
  assert.throws(() => loadConfig({ ...upstream, VP_CONNECT_TIMEOUT_MS: "0" }), /VP_CONNECT_TIMEOUT_MS/);
});

test("rejects a server address without http(s)://, naming the variable", () => {
  assert.throws(() => loadConfig({ VP_UPSTREAM: "203.0.113.10:8000" }), /VP_UPSTREAM/);
  assert.throws(() => loadConfig({ ...upstream, VP_OLLAMA: "ftp://203.0.113.20" }), /VP_OLLAMA/);
});
