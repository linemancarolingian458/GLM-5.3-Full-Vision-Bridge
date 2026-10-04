import { test } from "node:test";
import assert from "node:assert/strict";
import { extractImages, replaceImages } from "../src/images.ts";

// "aGVsbG8=" is base64 for "hello", "d29ybGQ=" for "world".
const chatBody = () => ({
  model: "text-model",
  stream: true,
  messages: [
    { role: "system", content: "You are ZCode." },
    {
      role: "user",
      content: [
        { type: "text", text: "What failed?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
      ],
    },
    { role: "assistant", content: "Let me read the screenshot file." },
    { role: "tool", tool_call_id: "call_1", content: "Read image" },
    {
      // ZCode moves Read-tool images into a trailing user message like this one.
      role: "user",
      content: [
        { type: "text", text: "Tool result media from Read" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,d29ybGQ=" } },
      ],
    },
  ],
});

test("finds every image_url part with its decoded bytes", () => {
  const refs = extractImages(chatBody());
  assert.deepEqual(
    refs.map((r) => [r.messageIndex, r.partIndex, r.data?.toString()]),
    [
      [1, 1, "hello"],
      [4, 1, "world"],
    ],
  );
});

test("replaces only the image parts, in order, without mutating the input", () => {
  const input = chatBody();
  const out = replaceImages(input, extractImages(input), ["CAPTION A", "CAPTION B"]);
  const expected = chatBody();
  expected.messages[1].content = [
    { type: "text", text: "What failed?" },
    { type: "text", text: "CAPTION A" },
  ] as never;
  expected.messages[4].content = [
    { type: "text", text: "Tool result media from Read" },
    { type: "text", text: "CAPTION B" },
  ] as never;
  assert.deepEqual(out, expected);
  assert.deepEqual(input, chatBody());
});

test("finds no images in string content, text-only parts, or a body without messages", () => {
  const body = {
    messages: [
      { role: "user", content: "a message that merely mentions image_url" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  };
  assert.deepEqual(extractImages(body), []);
  assert.deepEqual(extractImages({ prompt: "legacy completion" }), []);
});

test("marks an image that is not an inline base64 data URL as undecodable", () => {
  const refs = extractImages({
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
    ],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].data, null);
  assert.ok(refs[0].problem);
});
