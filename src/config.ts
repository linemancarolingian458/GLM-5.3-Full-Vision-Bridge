// Settings come from VP_* environment variables (the service files set them).
// Only VP_UPSTREAM is required; the vision model defaults to a local Ollama.
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  host: string;
  port: number;
  upstream: string;
  ollama: string;
  model: string;
  numCtx: number;
  numPredict: number;
  keepAlive: string;
  captionTimeoutMs: number;
  connectTimeoutMs: number;
  skipMs: number;
  cacheDir: string;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  return {
    host: env.VP_HOST ?? "127.0.0.1",
    port: integer(env, "VP_PORT", 11435),
    upstream: httpUrl(env, "VP_UPSTREAM"),
    ollama: httpUrl(env, "VP_OLLAMA", "http://127.0.0.1:11434"),
    model: env.VP_MODEL ?? "qwen2.5vl:7b",
    numCtx: integer(env, "VP_NUM_CTX", 8192),
    numPredict: integer(env, "VP_NUM_PREDICT", 2048),
    keepAlive: env.VP_KEEP_ALIVE ?? "5m",
    captionTimeoutMs: integer(env, "VP_CAPTION_TIMEOUT_MS", 90_000),
    connectTimeoutMs: integer(env, "VP_CONNECT_TIMEOUT_MS", 3_000),
    skipMs: integer(env, "VP_SKIP_MS", 60_000),
    cacheDir: env.VP_CACHE_DIR ?? join(homedir(), ".cache", "vision-proxy"),
  };
}

function integer(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

function httpUrl(env: Env, name: string, fallback?: string): string {
  const raw = env[name] ?? fallback;
  if (raw === undefined) {
    throw new Error(`${name} is required: the address of the OpenAI-compatible chat server to forward to, e.g. http://127.0.0.1:8000`);
  }
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`${name} must be an http:// or https:// address, got "${raw}"`);
  }
  return url.origin;
}
