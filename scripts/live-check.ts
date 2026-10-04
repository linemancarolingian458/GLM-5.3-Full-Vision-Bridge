// Live check of the vision side (needs the configured Ollama up): captions the fixture
// screenshot with the configured model and prompt, and checks 18 strings it must transcribe
// exactly. Run after changing VP_MODEL or the prompt:  npm run live-check
// Regenerate the fixture from terminal-error.html with headless Chrome at
// --window-size=1600,900 --force-device-scale-factor=1.25 (2000x1125, what ZCode sends).
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createOllamaCaptioner } from "../src/ollama.ts";
import { CAPTION_PROMPT } from "../src/prompt.ts";

const EXPECTED = [
  "orbit-api@2.7.1", "tsconfig.build.json", "src/server/router.ts:142:17", "TS2345", "'string | undefined'",
  "registerRoute(config.basePath, handler);", "src/db/pool.ts:58:3", "TS2322", "'number | null'",
  "env.DB_POOL_MAX", "Found 2 errors in 2 files.", "exit code 2", "Deployment failed", "port 18091", "30s",
  "v2.7.1-rc.3", "View logs", "Retry",
];

// The live check only talks to Ollama, so the chat server address doesn't matter here.
const config = loadConfig({ VP_UPSTREAM: "http://127.0.0.1:8000", ...process.env });
const image = await readFile(new URL("../test/fixtures/terminal-error-2000.png", import.meta.url));
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

const started = Date.now();
const text = await caption(image);
const missing = EXPECTED.filter((s) => !text.includes(s));
console.log(
  `${config.model} at ${config.ollama}: ${((Date.now() - started) / 1000).toFixed(1)} s, ` +
    `${EXPECTED.length - missing.length}/${EXPECTED.length} expected strings transcribed exactly`,
);
if (missing.length > 0) {
  console.log("missing:", missing);
  process.exitCode = 1;
}
