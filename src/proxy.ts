// The HTTP proxy ZCode talks to. Requests without images go to the upstream byte-for-byte;
// image parts are swapped for text descriptions first. Responses (including SSE streams)
// are piped back as they arrive.
import http from "node:http";
import https from "node:https";
import type { DescribeStats } from "./describer.ts";
import { extractImages, replaceImages, type ImageRef } from "./images.ts";

export interface ProxyOptions {
  /** Origin of the real chat server, e.g. http://127.0.0.1:8000 */
  upstream: string;
  describer: { describe(images: ImageRef[]): Promise<{ texts: string[]; stats: DescribeStats }> };
  log?: (line: string) => void;
  maxBodyBytes?: number;
}

// Hop-by-hop headers apply to one connection only and must not be forwarded.
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];
const SKIP_REQUEST_HEADERS = new Set([...HOP_BY_HOP, "host", "content-length"]);
const SKIP_RESPONSE_HEADERS = new Set(HOP_BY_HOP);

class BodyTooLargeError extends Error {}

export function createProxyServer(options: ProxyOptions): http.Server {
  const upstream = new URL(options.upstream);
  const request = upstream.protocol === "https:" ? https.request : http.request;
  const log = options.log ?? (() => {});
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024 * 1024;

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let summary = "images=0";
    let clientGone = false;
    res.on("close", () => {
      clientGone = !res.writableFinished;
      const gone = clientGone ? " client-went-away" : "";
      log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode}${gone} ${summary} total_ms=${Date.now() - startedAt}`);
    });

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendError(res, 413, `vision-proxy: request body over ${maxBodyBytes} bytes`, "request_too_large");
      return; // the client hung up while sending
    }

    if (req.method === "POST" && !req.headers["content-encoding"] && body.includes('"image_url"')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        parsed = undefined; // not JSON after all: let the upstream reject it as usual
      }
      const refs = parsed === undefined ? [] : extractImages(parsed);
      if (refs.length > 0) {
        let texts: string[];
        try {
          const described = await options.describer.describe(refs);
          texts = described.texts;
          const s = described.stats;
          summary = `images=${refs.length} cached=${s.cached} captioned=${s.captioned} failed=${s.failed} caption_ms=${s.captionMs}`;
        } catch (err) {
          // Never send image_url upstream: the main model is text-only and would reject it.
          texts = refs.map(() => "[Image could not be described: vision-proxy internal error]");
          summary = `images=${refs.length} describe-error=${JSON.stringify(err instanceof Error ? err.message : String(err))}`;
        }
        body = Buffer.from(JSON.stringify(replaceImages(parsed, refs, texts)));
      }
    }
    if (clientGone) return;

    const target = new URL(req.url ?? "/", upstream);
    const headers: http.OutgoingHttpHeaders = { host: target.host };
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !SKIP_REQUEST_HEADERS.has(name)) headers[name] = value;
    }
    if (body.length > 0 || (req.method !== "GET" && req.method !== "HEAD")) headers["content-length"] = body.length;

    // A fresh upstream connection per request: a reused keep-alive socket the server already
    // closed would surface as a spurious error.
    const upstreamReq = request(target, { method: req.method, headers, agent: false }, (upstreamRes) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !SKIP_RESPONSE_HEADERS.has(name)) outHeaders[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outHeaders);
      res.flushHeaders();
      upstreamRes.pipe(res);
      upstreamRes.on("error", () => res.destroy());
    });
    upstreamReq.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) return res.destroy();
      sendError(res, 502, `vision-proxy: upstream ${target.host} unreachable (${err.code ?? err.message})`, "upstream_unreachable");
    });
    // Ending a turn in ZCode closes our connection; stop the upstream generation too.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });
    upstreamReq.end(body);
  });
}

async function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendError(res: http.ServerResponse, status: number, message: string, type: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type, code: null } }));
}
