// The instruction sent to the vision model with each image. Bump PROMPT_VERSION whenever the
// text changes, so captions cached under the old prompt are not reused.
//
// Measured on qwen2.5vl:7b, 2026-10-04, fixture test/fixtures/terminal-error-2000.png:
//   v1 (no mention of dialogs): 16/18 strings with the model warm (it summarized the floating
//      dialog in prose instead of transcribing it), 18/18 cold.
//   v2 (this text): 18/18 in all runs, warm and cold, ~4.5 s warm.
export const PROMPT_VERSION = "v2";

export const CAPTION_PROMPT = `You are describing an image for a coding assistant that cannot see it.
1. Transcribe ALL visible text exactly, preserving line breaks, inside one fenced code block. Go through the whole image in reading order and include text in dialogs, pop-ups, notifications, overlays, tabs, and buttons, not just the main window. Include code, error messages, file paths, and numbers. Write [illegible] where you cannot read text; do not guess.
2. Then, in a few sentences, say what the image is (terminal, app window, browser page, diagram, chart, photo), its layout, the state of UI elements (selected, disabled, highlighted, red or error styling), and anything unusual. State only what is visible.`;
