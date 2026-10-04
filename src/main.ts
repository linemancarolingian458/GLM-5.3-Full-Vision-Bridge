// Entry point: wires config → cache → Ollama captioner → describer → proxy, then listens.
import { CaptionCache } from "./caption-cache.ts";
import { loadConfig } from "./config.ts";
import { createDescriber } from "./describer.ts";
import { createOllamaCaptioner } from "./ollama.ts";
import { CAPTION_PROMPT, PROMPT_VERSION } from "./prompt.ts";
import { createProxyServer } from "./proxy.ts";

const stamp = () => new Date().toISOString();
const config = loadConfig();

const cache = new CaptionCache(config.cacheDir, {
  onWriteError: (err) => console.error(`${stamp()} caption cache write failed: ${err instanceof Error ? err.message : err}`),
});
const caption = createOllamaCaptioner({
  baseUrl: config.ollama,
  model: config.model,
  prompt: CAPTION_PROMPT,
  numCtx: config.numCtx,
  numPredict: config.numPredict,
  keepAlive: config.keepAlive,
  timeoutMs: config.captionTimeoutMs,
  connectTimeoutMs: config.connectTimeoutMs,
});
const describer = createDescriber({ cache, caption, model: config.model, promptVersion: PROMPT_VERSION, skipMs: config.skipMs });
const server = createProxyServer({ upstream: config.upstream, describer, log: (line) => console.log(line) });

server.on("error", (err) => {
  console.error(`${stamp()} vision-proxy cannot listen on ${config.host}:${config.port}: ${err.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  console.log(
    `${stamp()} vision-proxy listening on http://${config.host}:${config.port} → upstream ${config.upstream}; ` +
      `images described by ${config.model} at ${config.ollama}; cache ${config.cacheDir}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
