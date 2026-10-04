# GLM-5.3 Full Vision Bridge

Let a text-only LLM, such as GLM-5.3, read your screenshots. The program is called
**vision-proxy**, and it works with any OpenAI-compatible chat server.

Many strong open coding models are text-only. Paste a screenshot of an error into a coding
agent that runs one, and the image is simply dropped. vision-proxy sits between your client
and your model's OpenAI-compatible server. When a request contains images, a small vision
model (via [Ollama](https://ollama.com)) transcribes and describes each one. The proxy swaps
the image for that text and forwards the request. Your main model stays the agent: it does
the reasoning and the tool calls, and it reads an exact transcript of what was on screen.

```
client (e.g. ZCode) ──► vision-proxy :11435 ──► your chat server (OpenAI-compatible, text-only model)
                            │ only for requests with images
                            └──► Ollama + a vision model (same machine or another one)
```

Requests without images pass through byte-for-byte, so the proxy can stay in front of your
model all the time.

![A text-only GLM-5.3 in ZCode describing a pasted image through vision-proxy](docs/zcode-demo.png)

*A text-only GLM-5.3 in ZCode answering a question about a pasted image, through vision-proxy.
The pasted image is the artwork "velvet diva" by **Ramin Nasibov** (@RaminNasibov on X), shown
here with credit to the artist. The answer below it is the model's own output. The model ID in
the picker is covered.*

## What you need

- **Node.js 23.6 or newer.** The proxy runs its TypeScript directly: no build step, no dependencies.
- **An OpenAI-compatible chat server** for your main model: vLLM, SGLang, llama.cpp
  `llama-server`, LM Studio, TabbyAPI, and so on.
- **Ollama with a vision model**, on this machine or another one. The default is
  `qwen2.5vl:7b` (a 6 GB download).

## Quick start

1. Get the vision model on the machine that runs Ollama:

   ```sh
   ollama pull qwen2.5vl:7b
   ```

2. Run the proxy, pointing it at your chat server:

   ```sh
   git clone https://github.com/Leoid/GLM-5.3-Full-Vision-Bridge.git ~/vision-proxy && cd ~/vision-proxy
   VP_UPSTREAM=http://<chat-server>:<port> node src/main.ts
   ```

   If Ollama runs on another machine, add `VP_OLLAMA=http://<ollama-host>:11434`.
   Check it with `curl http://127.0.0.1:11435/v1/models`: you should see your chat server's models.

3. Point your client at `http://127.0.0.1:11435/v1` instead of your chat server. Keep the same
   API key and model name, and turn on image input for that model (see [ZCode](#using-it-with-zcode)
   below). Clients only send images to models they believe can see them.

## Run it as a service

**macOS** installs a LaunchAgent that starts at login and restarts if it exits. Every `VP_*`
variable you set is stored in it:

```sh
VP_UPSTREAM=http://<chat-server>:<port> VP_OLLAMA=http://<ollama-host>:11434 ./deploy/install.sh
```

- Log: `~/Library/Logs/vision-proxy.log`.
- `./deploy/install.sh --dry-run` shows what would be installed.
- `./deploy/uninstall.sh` removes it.
- On first start, macOS may ask whether `node` may access your local network. Allow it if
  your servers are on your LAN.

**Linux** uses a systemd user service. Copy `deploy/vision-proxy.service` to
`~/.config/systemd/user/`, edit its `Environment=` lines, then run
`systemctl --user enable --now vision-proxy`. The file assumes the repo is at `~/vision-proxy`
(as in the quick start) and explains the details.

**Anywhere else:** `VP_UPSTREAM=... node src/main.ts`, started however you start services.

## Using it with ZCode

In ZCode, open **Settings → Model settings → Add provider → Custom endpoint**:

| Field | Value |
|---|---|
| API format | Chat completions |
| Base URL | `http://127.0.0.1:11435/v1` |
| API key | your chat server's key |
| Add model → Model ID | the same model ID your current provider uses |
| Input types | **Text** and **Image** |

**Input types → Image** is the setting that matters. Without it, ZCode replaces each image
with "[Media omitted … the selected model does not support image input]" before the request
ever leaves ZCode.

Keep your existing provider as a fallback. Images only work in chats that use the new
provider, so check the model picker in the chat you're pasting into.

**Editing the config file instead:** ZCode keeps providers in `~/.zcode/v2/provider_config.json`.
Quit ZCode, back up the file, and copy your existing provider's two entries: its entry in
`providerConfigRules.providerRules` and its entry in `modelConfigRules.manualProviderModelRules`.
In the copies, change:

- `providerId` (both entries) to a new ID, for example `"vision-proxy"`, and add that ID to `providerOrder`;
- `providerName` to something like `"My model + vision"`;
- `config.api.baseUrl` to `"http://127.0.0.1:11435/v1"`;
- `config.properties.inputFormat.supportsImage` to `true`.

**Other clients** work the same way, as long as they speak OpenAI chat completions and send
images as `image_url` parts with base64 `data:` URLs.

## Running the vision model on another machine

A common setup is a separate GPU box (a gaming PC, say) running Ollama while your main model
runs elsewhere. To make that work:

- **Make Ollama listen on your network.** Set `OLLAMA_HOST=0.0.0.0:11434` and restart Ollama.
  - Linux: `sudo systemctl edit ollama`, add `Environment="OLLAMA_HOST=0.0.0.0:11434"` under `[Service]`.
  - Windows: set it as a user environment variable, then quit and restart Ollama.
  - macOS: `launchctl setenv OLLAMA_HOST 0.0.0.0:11434`, then restart the Ollama app.
- **Allow the port from your LAN only.** Ollama has no authentication, and anyone who can
  reach it can use or delete your models.
  - Windows (elevated PowerShell):
    `New-NetFirewallRule -DisplayName "Ollama LAN" -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress <your-lan>/24 -Action Allow`
  - Linux with ufw: `sudo ufw allow from <your-lan>/24 to any port 11434 proto tcp`
- **Ollama inside WSL2 with mirrored networking** also needs a Hyper-V firewall rule for the
  WSL VM, as described in Microsoft's [WSL networking docs](https://learn.microsoft.com/windows/wsl/networking#mirrored-mode-networking):
  `New-NetFirewallHyperVRule -Name OllamaLAN -DisplayName "Ollama LAN" -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 11434`
  (`Get-NetFirewallHyperVVMCreator` lists the WSL ID). WSL doesn't start until something
  starts it, so after a Windows reboot Ollama stays down until then. The proxy copes; see below.
- **Test it** from the proxy's machine: `curl http://<ollama-host>:11434/api/tags`.
- **Sharing the GPU** with other apps, such as image generation? Ollama unloads the model after
  it has been idle for `VP_KEEP_ALIVE` (default 5 minutes).

## How it works

- **No images in the request:** the original bytes go to your chat server unchanged.
- **Each image** is hashed (SHA-256) and looked up in a caption cache (memory, backed by
  `~/.cache/vision-proxy`). Clients re-send earlier images on every turn, so each image is
  captioned only once. On a cache miss, the proxy makes one call to Ollama's `/api/chat`
  (temperature 0). The prompt asks for all visible text verbatim, including dialogs and
  buttons, then a short factual description of the image. Two requests for the same image
  share one caption.
- **The image part** becomes `[Image, described by qwen2.5vl:7b because the main model can't
  see images]` followed by the caption.
- **The response,** including SSE streams, is piped back as it arrives. If the client cancels,
  the request to your chat server is aborted.

**When the vision server is down,** your chat still works:

- If Ollama can't be reached, takes more than 3 s to connect or more than 90 s for an image, or
  returns an error, the image becomes `[Image could not be described: <reason>]` and the
  request goes ahead. Failures aren't cached, so the next turn tries again.
- After a connection failure, the proxy skips Ollama for the rest of that request and for
  the next 60 s. A sleeping GPU box costs one 3-second wait, not one per image.

**Security:**

- The proxy listens on `127.0.0.1` only and passes your `Authorization` header to your chat
  server. Don't expose it to a network you don't trust.
- Logs get one line per request: image count, cache hits, caption time, status. Prompt text
  and image data are never logged.

## Settings

All settings are environment variables.

| Variable | Default | Notes |
|---|---|---|
| `VP_UPSTREAM` | (required) | your OpenAI-compatible chat server, e.g. `http://127.0.0.1:8000` |
| `VP_OLLAMA` | `http://127.0.0.1:11434` | |
| `VP_MODEL` | `qwen2.5vl:7b` | any Ollama vision model; part of the cache key, so switching re-captions |
| `VP_HOST` / `VP_PORT` | `127.0.0.1` / `11435` | where your client connects |
| `VP_NUM_CTX` | `8192` | context per caption; a 2000×1125 screenshot is about 2.7K tokens |
| `VP_NUM_PREDICT` | `2048` | maximum caption length in tokens |
| `VP_KEEP_ALIVE` | `5m` | how long Ollama keeps the model loaded after a caption |
| `VP_CAPTION_TIMEOUT_MS` | `90000` | per image |
| `VP_CONNECT_TIMEOUT_MS` | `3000` | how long to wait for Ollama to accept a connection |
| `VP_SKIP_MS` | `60000` | how long to skip Ollama after it was unreachable |
| `VP_CACHE_DIR` | `~/.cache/vision-proxy` | one small text file per caption |

## Tests

- `npm test` runs the unit and integration tests, with no network needed.
- `npm run live-check` captions `test/fixtures/terminal-error-2000.png` with your Ollama. It
  checks 18 strings that must be transcribed exactly: error codes, paths, line numbers, and
  dialog text. Run it after changing `VP_MODEL` or the prompt in `src/prompt.ts`, and bump
  `PROMPT_VERSION` whenever the prompt text changes.

## Example numbers

Measured with a text-only GLM model as the main model and `qwen2.5vl:7b` in Ollama on an
RTX 3090 (24 GB):

| | |
|---|---|
| New 2000×1125 screenshot | about 4.5 s to caption with the model loaded, about 13 s if Ollama has to load it first |
| Screenshot seen before | served from the cache, no vision call |
| VRAM while loaded (`num_ctx` 8192) | about 15 GB |
| Live check | 18/18 strings exact |

An earlier prompt that didn't mention dialogs sometimes summarized a pop-up instead of
transcribing it. The live check catches that kind of regression.

## Limits

- Only inline base64 images, which is what clients normally send. Remote image URLs, PDFs,
  and video aren't handled.
- Your model reads a description, not pixels. Text and structure come through well. Layout,
  colors, and fine visual detail are partly lost, and tiny text in low-resolution images can
  be garbled.

## License

MIT
