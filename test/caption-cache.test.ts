import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptionCache } from "../src/caption-cache.ts";

const tempDir = () => mkdtemp(join(tmpdir(), "vision-proxy-cache-"));

test("returns the caption stored under a key", async () => {
  const cache = new CaptionCache(await tempDir());
  await cache.set("qwen|v1|abc", "a terminal showing TS2345");
  assert.equal(await cache.get("qwen|v1|abc"), "a terminal showing TS2345");
});

test("does not return one key's caption for a different key", async () => {
  const cache = new CaptionCache(await tempDir());
  await cache.set("qwen|v1|abc", "caption for abc");
  assert.equal(await cache.get("qwen|v1|abd"), undefined);
});

test("a new instance on the same directory finds captions stored before a restart", async () => {
  const dir = await tempDir();
  await new CaptionCache(dir).set("qwen|v1|abc", "survives restarts");
  assert.equal(await new CaptionCache(dir).get("qwen|v1|abc"), "survives restarts");
});

test("keeps the caption in memory and reports the error when the directory can't be written", async () => {
  const errors: unknown[] = [];
  const cache = new CaptionCache("/dev/null/not-a-dir", { onWriteError: (err) => errors.push(err) });
  await cache.set("qwen|v1|abc", "still usable");
  assert.equal(await cache.get("qwen|v1|abc"), "still usable");
  assert.equal(errors.length, 1);
});
