import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxyServer, type ProxyOptions } from "../src/proxy.ts";
import type { ImageRef } from "../src/images.ts";

interface Received {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
  body: Buffer;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Stands in for the real chat server: records the request it got, then runs the test's responder. */
async function fakeUpstream(respond: (req: IncomingMessage, res: ServerResponse, received: Received) => void) {
  const received: Received = { body: Buffer.alloc(0) };
  const closed: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    Object.assign(received, { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.on("close", () => closed.push(res.writableFinished ? "finished" : "aborted"));
    respond(req, res, received);
  });
  return { url: await listen(server), server, received, closed };
}

/** A describer that labels each image with its decoded bytes, and records calls. */
function fakeDescriber() {
  const calls: string[][] = [];
  return {
    calls,
    async describe(images: ImageRef[]) {
      calls.push(images.map((i) => i.data?.toString() ?? "null"));
      return {
        texts: images.map((i) => `[Image, described by test-vision]\nA screenshot reading ${i.data?.toString()}`),
        stats: { cached: 0, captioned: images.length, failed: 0, captionMs: 7 },
      };
    },
  };
}

async function startProxy(t: { after(fn: () => void): void }, options: ProxyOptions) {
  const server = createProxyServer(options);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return listen(server);
}

const chatWithImage = JSON.stringify({
  model: "text-model",
  stream: true,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "secret prompt text: what failed?" },
        // "VFMyMzQ1IGluIHJvdXRlci50cw==" is base64 for "TS2345 in router.ts".
        { type: "image_url", image_url: { url: "data:image/png;base64,VFMyMzQ1IGluIHJvdXRlci50cw==" } },
      ],
    },
  ],
});

test("forwards a request without images byte-for-byte and returns the upstream reply unchanged", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "x-upstream": "chat-server" });
    res.end('{"error":{"message":"rate limited"}}');
  });
  t.after(() => upstream.server.close());
  const proxy = await startProxy(t, { upstream: upstream.url, describer: fakeDescriber() });

  // Whitespace and \u escapes that a parse-and-reserialize would normalize away.
  const raw = '{"model": "text-model",  "messages":[{"role":"user","content":"caf\\u00e9 \\ud83d\\ude00"}]}';
  const res = await fetch(`${proxy}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret-key" },
    body: raw,
  });

  assert.equal(res.status, 429);
  assert.equal(res.headers.get("x-upstream"), "chat-server");
  assert.equal(await res.text(), '{"error":{"message":"rate limited"}}');
  assert.equal(upstream.received.method, "POST");
  assert.equal(upstream.received.url, "/v1/chat/completions");
  assert.equal(upstream.received.headers?.authorization, "Bearer secret-key");
  assert.equal(upstream.received.body.toString("utf8"), raw);
});

test("replaces images with their descriptions so the upstream never receives image_url", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) => res.writeHead(200).end("ok"));
  t.after(() => upstream.server.close());
  const describer = fakeDescriber();
  const proxy = await startProxy(t, { upstream: upstream.url, describer });

  await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: chatWithImage, headers: { "content-type": "application/json" } });

  const forwarded = upstream.received.body.toString("utf8");
  assert.ok(!forwarded.includes("image_url"), forwarded);
  assert.deepEqual(JSON.parse(forwarded).messages[0].content, [
    { type: "text", text: "secret prompt text: what failed?" },
    { type: "text", text: "[Image, described by test-vision]\nA screenshot reading TS2345 in router.ts" },
  ]);
  assert.deepEqual(describer.calls, [["TS2345 in router.ts"]]);
});

test("streams the upstream response through as it arrives instead of buffering it", { timeout: 5000 }, async (t) => {
  let clientGotFirstChunk!: () => void;
  const firstChunkSeen = new Promise<void>((resolve) => (clientGotFirstChunk = resolve));
  const upstream = await fakeUpstream(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    await firstChunkSeen; // a buffering proxy never delivers this chunk, so the test would hang
    res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  });
  t.after(() => upstream.server.close());
  const proxy = await startProxy(t, { upstream: upstream.url, describer: fakeDescriber() });

  const res = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: '{"stream":true,"messages":[]}' });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.ok(text.includes('"Hel"'), text);
  clientGotFirstChunk();
  for (let r = await reader.read(); !r.done; r = await reader.read()) text += decoder.decode(r.value);
  assert.ok(text.endsWith("data: [DONE]\n\n"), text);
});

test("passes other paths through, such as GET /v1/models", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) =>
    res.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"text-model"}]}'),
  );
  t.after(() => upstream.server.close());
  const proxy = await startProxy(t, { upstream: upstream.url, describer: fakeDescriber() });

  const res = await fetch(`${proxy}/v1/models`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"data":[{"id":"text-model"}]}');
  assert.equal(upstream.received.method, "GET");
  assert.equal(upstream.received.url, "/v1/models");
});

test("answers 502 with an OpenAI-style error when the upstream is unreachable", { timeout: 5000 }, async (t) => {
  const dead = createServer();
  const deadUrl = await listen(dead);
  await new Promise((resolve) => dead.close(resolve));
  const proxy = await startProxy(t, { upstream: deadUrl, describer: fakeDescriber() });

  const res = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: '{"messages":[]}' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(typeof body.error.message, "string");
  assert.match(body.error.message, /upstream/i);
});

test("aborts the upstream request when the client goes away mid-stream", { timeout: 5000 }, async (t) => {
  let upstreamStarted!: () => void;
  const started = new Promise<void>((resolve) => (upstreamStarted = resolve));
  const upstream = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {}\n\n");
    upstreamStarted(); // then never ends, like a long GLM generation
  });
  t.after(() => {
    upstream.server.closeAllConnections();
    upstream.server.close();
  });
  const proxy = await startProxy(t, { upstream: upstream.url, describer: fakeDescriber() });

  const controller = new AbortController();
  const res = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: '{"messages":[]}', signal: controller.signal });
  await res.body!.getReader().read();
  await started;
  controller.abort();
  for (let i = 0; i < 50 && upstream.closed.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(upstream.closed, ["aborted"]);
});

test("forwards the original bytes when a body mentions image_url but is not valid JSON", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) => res.writeHead(400).end("bad json"));
  t.after(() => upstream.server.close());
  const describer = fakeDescriber();
  const proxy = await startProxy(t, { upstream: upstream.url, describer });

  const raw = '{"messages":[{"content":[{"type":"image_url"';
  const res = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: raw });
  assert.equal(res.status, 400);
  assert.equal(upstream.received.body.toString("utf8"), raw);
  assert.deepEqual(describer.calls, []);
});

test("still forwards the request, with notes in place of images, if describing throws unexpectedly", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) => res.writeHead(200).end("ok"));
  t.after(() => upstream.server.close());
  const proxy = await startProxy(t, {
    upstream: upstream.url,
    describer: {
      describe: async () => {
        throw new Error("bug");
      },
    },
  });

  const res = await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: chatWithImage });
  assert.equal(res.status, 200);
  const forwarded = upstream.received.body.toString("utf8");
  assert.ok(!forwarded.includes("image_url"), forwarded);
  assert.match(forwarded, /Image could not be described/);
});

test("logs one line per request with image counts but no prompt or image content", { timeout: 5000 }, async (t) => {
  const upstream = await fakeUpstream((_req, res) => res.writeHead(200).end("ok"));
  t.after(() => upstream.server.close());
  const lines: string[] = [];
  const proxy = await startProxy(t, { upstream: upstream.url, describer: fakeDescriber(), log: (line) => lines.push(line) });

  await (await fetch(`${proxy}/v1/chat/completions`, { method: "POST", body: chatWithImage })).text();
  for (let i = 0; i < 50 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /POST \/v1\/chat\/completions 200/);
  assert.match(lines[0], /images=1 cached=0 captioned=1 failed=0/);
  assert.ok(!lines[0].includes("secret prompt text"), lines[0]);
  assert.ok(!lines[0].includes("TS2345"), lines[0]);
});
