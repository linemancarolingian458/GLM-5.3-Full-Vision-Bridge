// Finds OpenAI chat-completions `image_url` parts and swaps them for text parts.
// Pure functions: no I/O, no mutation of the parsed request body.

export interface ImageRef {
  messageIndex: number;
  partIndex: number;
  /** Decoded image bytes, or null when the URL isn't an inline base64 data URL. */
  data: Buffer | null;
  problem?: string;
}

interface Part {
  type?: unknown;
  image_url?: { url?: unknown };
}

const DATA_URL = /^data:[^,]*;base64,/i;

export function extractImages(body: unknown): ImageRef[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return [];
  const refs: ImageRef[] = [];
  messages.forEach((message, messageIndex) => {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) return;
    content.forEach((part: Part, partIndex) => {
      if (part?.type !== "image_url") return;
      const url = part.image_url?.url;
      const header = typeof url === "string" ? url.match(DATA_URL) : null;
      refs.push(
        header
          ? { messageIndex, partIndex, data: Buffer.from((url as string).slice(header[0].length), "base64") }
          : { messageIndex, partIndex, data: null, problem: "only inline base64 images can be described" },
      );
    });
  });
  return refs;
}

export function replaceImages<T>(body: T, refs: ImageRef[], texts: string[]): T {
  const copy = structuredClone(body) as { messages: { content: unknown[] }[] };
  refs.forEach((ref, i) => {
    copy.messages[ref.messageIndex].content[ref.partIndex] = { type: "text", text: texts[i] };
  });
  return copy as T;
}
