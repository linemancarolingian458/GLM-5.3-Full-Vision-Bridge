// Captions one image with Ollama's native /api/chat. The native API (unlike Ollama's
// OpenAI-style endpoint) lets us set the context size and keep_alive per request.
import http from "node:http";
import https from "node:https";

/** The vision server can't be reached or is too slow; don't try more images for a while. */
export class VisionUnavailableError extends Error {}
/** The server answered, but this caption failed (HTTP error, empty reply, bad JSON). */
export class CaptionFailedError extends Error {}

export interface OllamaCaptionerOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  numCtx: number;
  numPredict: number;
  keepAlive: string;
  timeoutMs: number;
  /** Separate, short limit for establishing the TCP connection (a sleeping PC never answers). */
  connectTimeoutMs: number;
}

export function createOllamaCaptioner(options: OllamaCaptionerOptions): (image: Buffer) => Promise<string> {
  const url = new URL("/api/chat", options.baseUrl);
  const request = url.protocol === "https:" ? https.request : http.request;

  return (image) =>
    new Promise<string>((resolve, reject) => {
      const payload = JSON.stringify({
        model: options.model,
        stream: false,
        keep_alive: options.keepAlive,
        options: { num_ctx: options.numCtx, num_predict: options.numPredict, temperature: 0 },
        messages: [{ role: "user", content: options.prompt, images: [image.toString("base64")] }],
      });

      let settled = false;
      const settle = (err: Error | null, caption?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(replyTimer);
        if (err) {
          req.destroy();
          reject(err);
        } else {
          resolve(caption as string);
        }
      };

      // A fresh connection per caption: captions take seconds, and a reused keep-alive socket
      // that the server already closed would otherwise look like an outage.
      const req = request(url, {
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      });
      const connectTimer = setTimeout(
        () => settle(new VisionUnavailableError(`no connection to ${url.host} within ${options.connectTimeoutMs} ms`)),
        options.connectTimeoutMs,
      );
      const replyTimer = setTimeout(
        () => settle(new VisionUnavailableError(`no reply from ${url.host} within ${options.timeoutMs / 1000} s`)),
        options.timeoutMs,
      );

      req.on("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        else socket.once("connect", () => clearTimeout(connectTimer));
      });
      req.on("error", (err: NodeJS.ErrnoException) =>
        settle(new VisionUnavailableError(`${url.host} unreachable (${err.code ?? err.message})`)),
      );
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", (err) => settle(new VisionUnavailableError(`reply from ${url.host} broke off (${err.message})`)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: { message?: { content?: unknown }; error?: unknown } | undefined;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          if (res.statusCode !== 200) {
            const detail = typeof json?.error === "string" ? json.error : text.slice(0, 200);
            return settle(new CaptionFailedError(`vision model returned HTTP ${res.statusCode}: ${detail}`));
          }
          const content = json?.message?.content;
          if (typeof content !== "string" || content.trim() === "") {
            return settle(new CaptionFailedError("vision model returned an empty reply"));
          }
          settle(null, content.trim());
        });
      });
      req.end(payload);
    });
}
