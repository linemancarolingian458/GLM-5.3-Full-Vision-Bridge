import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CaptionFailedError,
  createOllamaCaptioner,
  VisionUnavailableError,
  type OllamaCaptionerOptions,
} from "../src/ollama.ts";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function fakeOllama(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    handler(req, body, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const options = (baseUrl: string, overrides: Partial<OllamaCaptionerOptions> = {}): OllamaCaptionerOptions => ({
  baseUrl,
  model: "qwen2.5vl:7b",
  prompt: "Describe this image.",
  numCtx: 8192,
  numPredict: 2048,
  keepAlive: "5m",
  timeoutMs: 5000,
  connectTimeoutMs: 1000,
  ...overrides,
});

// The complete non-streaming /api/chat reply shape Ollama 0.23 returns.
const ollamaReply = (content: string) => ({
  model: "qwen2.5vl:7b",
  created_at: "2026-10-04T18:00:00.000Z",
  message: { role: "assistant", content },
  done: true,
  done_reason: "stop",
  total_duration: 3_800_000_000,
  load_duration: 100_000_000,
  prompt_eval_count: 1965,
  prompt_eval_duration: 40_000_000,
  eval_count: 393,
  eval_duration: 3_100_000_000,
});

test("posts the image to /api/chat with the configured model and options, and returns the reply", async (t) => {
  let seen: { method?: string; url?: string; body?: Record<string, any> } = {};
  const { url, server } = await fakeOllama((req, body, res) => {
    seen = { method: req.method, url: req.url, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ollamaReply("  ```\nTS2345\n```\nA terminal.  ")));
  });
  t.after(() => server.close());

  const caption = await createOllamaCaptioner(options(url))(Buffer.from("hello"));

  assert.equal(caption, "```\nTS2345\n```\nA terminal.");
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/api/chat");
  assert.deepEqual(seen.body, {
    model: "qwen2.5vl:7b",
    stream: false,
    keep_alive: "5m",
    options: { num_ctx: 8192, num_predict: 2048, temperature: 0 },
    messages: [{ role: "user", content: "Describe this image.", images: ["aGVsbG8="] }],
  });
});

test("reports the vision server as unavailable when nothing is listening", async () => {
  const { url, server } = await fakeOllama(() => {});
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(createOllamaCaptioner(options(url))(Buffer.from("x")), VisionUnavailableError);
});

test("gives up quickly on a host that never accepts the connection", async () => {
  const started = Date.now();
  // 192.0.2.1 is TEST-NET-1: reserved, never routed, so the connection can't be established.
  const caption = createOllamaCaptioner(options("http://192.0.2.1:11434", { connectTimeoutMs: 200 }));
  await assert.rejects(caption(Buffer.from("x")), VisionUnavailableError);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test("gives up on a server that accepts the request but never replies", async (t) => {
  const { url, server } = await fakeOllama(() => {});
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  const started = Date.now();
  await assert.rejects(createOllamaCaptioner(options(url, { timeoutMs: 300 }))(Buffer.from("x")), VisionUnavailableError);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test("reports an HTTP error as a failed caption carrying Ollama's message", async (t) => {
  const { url, server } = await fakeOllama((_req, _body, res) => {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "model 'qwen2.5vl:7b' not found" }));
  });
  t.after(() => server.close());
  await assert.rejects(createOllamaCaptioner(options(url))(Buffer.from("x")), (err: Error) => {
    assert.ok(err instanceof CaptionFailedError, `got ${err.constructor.name}`);
    assert.match(err.message, /not found/);
    return true;
  });
});

test("reports an empty reply as a failed caption", async (t) => {
  const { url, server } = await fakeOllama((_req, _body, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(ollamaReply("   ")));
  });
  t.after(() => server.close());
  await assert.rejects(createOllamaCaptioner(options(url))(Buffer.from("x")), CaptionFailedError);
});
