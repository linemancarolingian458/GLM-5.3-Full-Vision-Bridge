// Turns image parts into text: cached caption → shared in-flight caption → vision model.
// Vision failures never throw; they become a short note so the chat request still goes through.
import { createHash } from "node:crypto";
import type { ImageRef } from "./images.ts";
import { VisionUnavailableError } from "./ollama.ts";

export interface DescribeStats {
  cached: number;
  captioned: number;
  failed: number;
  captionMs: number;
}

export interface DescriberOptions {
  cache: { get(key: string): Promise<string | undefined>; set(key: string, caption: string): Promise<void> };
  caption: (image: Buffer) => Promise<string>;
  /** Shown to the main model and part of the cache key, so switching models re-captions. */
  model: string;
  /** Bump when the caption prompt changes, so old captions aren't reused. */
  promptVersion: string;
  /** After the vision server is unavailable, skip it for this long. */
  skipMs: number;
  now?: () => number;
}

export function createDescriber(options: DescriberOptions) {
  const now = options.now ?? Date.now;
  const inflight = new Map<string, Promise<string>>();
  let unavailableUntil = 0;
  let unavailableReason = "";

  const label = (caption: string) =>
    `[Image, described by ${options.model} because the main model can't see images]\n${caption}`;
  const note = (reason: string) => `[Image could not be described: ${reason}]`;

  function captionOnce(key: string, image: Buffer): Promise<string> {
    let pending = inflight.get(key);
    if (!pending) {
      pending = options
        .caption(image)
        .then(async (caption) => {
          await options.cache.set(key, caption);
          return caption;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return {
    async describe(images: ImageRef[]): Promise<{ texts: string[]; stats: DescribeStats }> {
      const texts: string[] = [];
      const stats: DescribeStats = { cached: 0, captioned: 0, failed: 0, captionMs: 0 };
      let skipReason: string | undefined;

      for (const image of images) {
        if (!image.data) {
          texts.push(note(image.problem ?? "the image could not be read"));
          stats.failed += 1;
          continue;
        }
        const hash = createHash("sha256").update(image.data).digest("hex");
        const key = `${options.model}|${options.promptVersion}|${hash}`;
        const cached = await options.cache.get(key);
        if (cached !== undefined) {
          texts.push(label(cached));
          stats.cached += 1;
          continue;
        }
        const skip = skipReason ?? (now() < unavailableUntil ? unavailableReason : undefined);
        if (skip) {
          texts.push(note(skip));
          stats.failed += 1;
          continue;
        }
        const started = now();
        try {
          texts.push(label(await captionOnce(key, image.data)));
          stats.captioned += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof VisionUnavailableError) {
            skipReason = `vision server unavailable (${message})`;
            unavailableUntil = now() + options.skipMs;
            unavailableReason = skipReason;
          }
          texts.push(note(message));
          stats.failed += 1;
        } finally {
          stats.captionMs += now() - started;
        }
      }
      return { texts, stats };
    },
  };
}
