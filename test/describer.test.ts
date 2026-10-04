import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptionCache } from "../src/caption-cache.ts";
import { createDescriber, type DescriberOptions } from "../src/describer.ts";
import type { ImageRef } from "../src/images.ts";
import { CaptionFailedError, VisionUnavailableError } from "../src/ollama.ts";

const image = (bytes: string, index = 0): ImageRef => ({ messageIndex: 1, partIndex: index, data: Buffer.from(bytes) });

/** A vision model stand-in that records which images it was asked about. */
function fakeVision(reply: (bytes: string) => Promise<string> | string) {
  const calls: string[] = [];
  return {
    calls,
    caption: async (img: Buffer) => {
      calls.push(img.toString());
      return reply(img.toString());
    },
  };
}

async function setup(reply: (bytes: string) => Promise<string> | string, overrides: Partial<DescriberOptions> = {}) {
  const vision = fakeVision(reply);
  const cache = new CaptionCache(await mkdtemp(join(tmpdir(), "vision-proxy-describer-")));
  const describer = createDescriber({
    cache,
    caption: vision.caption,
    model: "qwen2.5vl:7b",
    promptVersion: "v1",
    skipMs: 60_000,
    ...overrides,
  });
  return { describer, vision, cache };
}

test("describes an image with the vision model's caption, labeled as a description", async () => {
  const { describer } = await setup((bytes) => `caption of ${bytes}`);
  const { texts, stats } = await describer.describe([image("screenshot-1")]);
  assert.equal(texts.length, 1);
  assert.ok(texts[0].startsWith("[Image, described by qwen2.5vl:7b"), texts[0]);
  assert.ok(texts[0].endsWith("caption of screenshot-1"), texts[0]);
  assert.deepEqual({ ...stats, captionMs: 0 }, { cached: 0, captioned: 1, failed: 0, captionMs: 0 });
});

test("an image seen before is served from the cache without asking the vision model again", async () => {
  const { describer, vision } = await setup((bytes) => `caption of ${bytes}`);
  await describer.describe([image("screenshot-1")]);
  const { texts, stats } = await describer.describe([image("screenshot-1")]);
  assert.deepEqual(vision.calls, ["screenshot-1"]);
  assert.ok(texts[0].endsWith("caption of screenshot-1"));
  assert.equal(stats.cached, 1);
});

test("different images get their own captions", async () => {
  const { describer } = await setup((bytes) => `caption of ${bytes}`);
  await describer.describe([image("screenshot-1")]);
  const { texts } = await describer.describe([image("screenshot-2")]);
  assert.ok(texts[0].endsWith("caption of screenshot-2"), texts[0]);
});

test("switching the vision model re-captions instead of reusing the old model's caption", async () => {
  const first = await setup((bytes) => `old model on ${bytes}`);
  await first.describer.describe([image("screenshot-1")]);
  const vision = fakeVision((bytes) => `new model on ${bytes}`);
  const describer = createDescriber({ cache: first.cache, caption: vision.caption, model: "qwen3-vl:8b", promptVersion: "v1", skipMs: 60_000 });
  const { texts } = await describer.describe([image("screenshot-1")]);
  assert.ok(texts[0].endsWith("new model on screenshot-1"), texts[0]);
});

test("the same image in two concurrent requests is captioned once", async () => {
  let release!: (caption: string) => void;
  const pending = new Promise<string>((resolve) => (release = resolve));
  const { describer, vision } = await setup(() => pending);
  const both = Promise.all([describer.describe([image("screenshot-1")]), describer.describe([image("screenshot-1")])]);
  await new Promise((resolve) => setImmediate(resolve));
  release("shared caption");
  const [a, b] = await both;
  assert.equal(vision.calls.length, 1);
  assert.ok(a.texts[0].endsWith("shared caption"));
  assert.ok(b.texts[0].endsWith("shared caption"));
});

test("a failed caption becomes a could-not-be-described note and is retried next time", async () => {
  let attempt = 0;
  const { describer, vision } = await setup((bytes) => {
    attempt += 1;
    if (attempt === 1) throw new CaptionFailedError("vision model returned HTTP 500: boom");
    return `caption of ${bytes}`;
  });
  const first = await describer.describe([image("screenshot-1")]);
  assert.ok(first.texts[0].startsWith("[Image could not be described:"), first.texts[0]);
  assert.match(first.texts[0], /boom/);
  assert.equal(first.stats.failed, 1);
  const second = await describer.describe([image("screenshot-1")]);
  assert.ok(second.texts[0].endsWith("caption of screenshot-1"), second.texts[0]);
  assert.equal(vision.calls.length, 2);
});

test("once the vision server is unavailable, the rest of that request skips it", async () => {
  const { describer, vision } = await setup(() => {
    throw new VisionUnavailableError("203.0.113.20:11434 unreachable (EHOSTUNREACH)");
  });
  const { texts, stats } = await describer.describe([image("a", 0), image("b", 1), image("c", 2)]);
  assert.deepEqual(vision.calls, ["a"]);
  assert.equal(texts.length, 3);
  for (const text of texts) assert.ok(text.startsWith("[Image could not be described:"), text);
  assert.equal(stats.failed, 3);
});

test("unavailability is remembered for skipMs, then the vision server is tried again", async () => {
  let clock = 1_000;
  const { describer, vision } = await setup(
    () => {
      throw new VisionUnavailableError("no connection within 3000 ms");
    },
    { skipMs: 60_000, now: () => clock },
  );
  await describer.describe([image("a")]);
  clock = 1_000 + 59_999;
  await describer.describe([image("b")]);
  assert.deepEqual(vision.calls, ["a"]);
  clock = 1_000 + 60_000;
  await describer.describe([image("c")]);
  assert.deepEqual(vision.calls, ["a", "c"]);
});

test("cached captions are still used while the vision server is marked unavailable", async () => {
  let up = true;
  const { describer } = await setup((bytes) => {
    if (!up) throw new VisionUnavailableError("unreachable");
    return `caption of ${bytes}`;
  });
  await describer.describe([image("old-screenshot")]);
  up = false;
  await describer.describe([image("new-screenshot")]);
  const { texts } = await describer.describe([image("old-screenshot")]);
  assert.ok(texts[0].endsWith("caption of old-screenshot"), texts[0]);
});

test("an image that couldn't be decoded gets a note without asking the vision model", async () => {
  const { describer, vision } = await setup((bytes) => `caption of ${bytes}`);
  const { texts } = await describer.describe([
    { messageIndex: 1, partIndex: 0, data: null, problem: "only inline base64 images can be described" },
  ]);
  assert.deepEqual(vision.calls, []);
  assert.match(texts[0], /^\[Image could not be described: only inline base64 images can be described\]/);
});
