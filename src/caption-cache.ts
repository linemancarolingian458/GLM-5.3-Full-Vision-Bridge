// Captions keyed by (model, prompt version, image hash). Memory first, then one small
// text file per caption on disk, so restarts don't re-caption images ZCode keeps re-sending.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CaptionCacheOptions {
  maxMemoryEntries?: number;
  onWriteError?: (err: unknown) => void;
}

export class CaptionCache {
  #dir: string;
  #memory = new Map<string, string>();
  #maxMemoryEntries: number;
  #onWriteError: (err: unknown) => void;

  constructor(dir: string, options: CaptionCacheOptions = {}) {
    this.#dir = dir;
    this.#maxMemoryEntries = options.maxMemoryEntries ?? 2000;
    this.#onWriteError = options.onWriteError ?? (() => {});
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.#memory.get(key);
    if (hit !== undefined) return hit;
    try {
      const caption = await readFile(this.#file(key), "utf8");
      this.#remember(key, caption);
      return caption;
    } catch {
      return undefined;
    }
  }

  async set(key: string, caption: string): Promise<void> {
    this.#remember(key, caption);
    try {
      await mkdir(this.#dir, { recursive: true });
      const file = this.#file(key);
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, caption, "utf8");
      await rename(tmp, file);
    } catch (err) {
      // Best effort: the caption is still served from memory until the next restart.
      this.#onWriteError(err);
    }
  }

  #file(key: string): string {
    return join(this.#dir, `${createHash("sha256").update(key).digest("hex")}.txt`);
  }

  #remember(key: string, caption: string): void {
    this.#memory.delete(key);
    this.#memory.set(key, caption);
    if (this.#memory.size > this.#maxMemoryEntries) {
      this.#memory.delete(this.#memory.keys().next().value as string);
    }
  }
}
