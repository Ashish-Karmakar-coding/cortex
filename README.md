# Cortex 🧠

**An open-source, local-first agentic coding CLI — a Claude Code / Codex CLI alternative that runs on your own models.**

Cortex gives an LLM controlled hands inside your terminal: it explores repositories, reads and edits files, runs shell commands, checks git state, and iterates on failures. It works out of the box with **local models via Ollama / LM Studio**, and supports **bring-your-own-key** cloud providers when you want more horsepower.

```
 ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗
██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝
██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝
██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗
╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
```

---

## Install

**Requirements:** [Node.js](https://nodejs.org) **22.13 or newer** (Cortex uses the built-in `node:sqlite` module).

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.ps1 | iex
```

Or with curl, if you prefer:

```powershell
curl.exe -fsSL https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.ps1 | powershell -NoProfile -ExecutionPolicy Bypass -Command -
```

### What the installer does

- Downloads the latest **self-contained release** from GitHub Releases (a single bundled `cortex.js` — no `npm install` of dependencies).
- Installs it to `~/.cortex` (override with `CORTEX_HOME`).
- Adds a `cortex` launcher to `~/.local/bin` (Unix) or `~/.cortex\bin` on your user `PATH` (Windows).
- Verifies Node.js 22.13+ is present.

Then open a new terminal and run:

```bash
cortex
```

> **Windows note:** if `cortex` is not recognized, open a new terminal so the updated `PATH` is loaded.

### Install options

| Variable | Default | Purpose |
| --- | --- | --- |
| `CORTEX_HOME` | `~/.cortex` | Install directory and config/data directory |
| `CORTEX_BIN_DIR` | `~/.local/bin` | Where the `cortex` launcher is linked (Unix) |
| `CORTEX_VERSION` | `latest` | Install a specific release tag (e.g. `v0.1.0`) |
| `CORTEX_REPO` | `Ashish-Karmakar-coding/cortex` | Repo to download releases from |
| `CORTEX_DOWNLOAD_URL` | — | Direct archive URL (mirrors, air-gapped installs) |

Example:

```bash
CORTEX_HOME="$HOME/tools/cortex" CORTEX_VERSION=v0.1.0 \
  curl -fsSL https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.sh | bash
```

### Update

```bash
cortex upgrade
```

The same installer is re-run, so the latest release replaces the current bundle. Your config, API keys, and sessions in `~/.cortex` are preserved.

### Uninstall

```bash
# macOS / Linux
rm -rf ~/.cortex ~/.local/bin/cortex

# Windows (PowerShell)
Remove-Item -Recurse -Force "$HOME\.cortex"
# then remove %USERPROFILE%\.cortex\bin from your user PATH
```

---

## Quick start with a local model (no API key)

1. Install [Ollama](https://ollama.com) and pull a coding model:

   ```bash
   ollama pull qwen2.5-coder:7b
   ```

2. Start Cortex in any project:

   ```bash
   cd my-project
   cortex
   ```

Cortex defaults to Ollama at `http://localhost:11434`. Inside the TUI:

```
/model
```

lists models installed on your machine and lets you switch.

Switch directly from the command line:

```bash
cortex --provider ollama --model qwen2.5-coder:7b
```

### LM Studio / llama.cpp / vLLM

Use the OpenAI-compatible provider:

```bash
cortex --provider lmstudio --model <model-id>
```

The default endpoint is `http://localhost:1234/v1`. Set a custom host by editing `~/.cortex/config.json` or `OLLAMA_HOST` for Ollama.

---

## Cloud providers (bring your own key)

Cortex never requires a key, but it will use one if you provide it.

| Provider | `--provider` | API key env var |
| --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `google` | `GOOGLE_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |

Either export the env var:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
cortex --provider anthropic --model claude-sonnet-4-20250514
```

Or save it once from inside Cortex (stored in `~/.cortex/config.json`, `chmod 0600` on Unix):

```text
/key anthropic sk-ant-...
```

Then switch providers/models interactively:

```text
/provider
/model
```

The current provider, model, and context window are always shown in the TUI header.

---

## Usage

### Interactive TUI

```bash
cortex
```

Keyboard shortcuts: `Ctrl+C` aborts the current operation (press twice when idle to exit).

Cortex uses a dark-green / warm-beige palette: **`#2C3930` background** with **`#DCD7C9` elements**. The TUI asks your terminal to adopt the colors (OSC 10/11) and restores your original theme on exit. To customize, edit `src/tui/palette.ts`.

### Non-interactive / pipe mode

```bash
cortex -p "explain the architecture of this repo"

git diff | cortex -p "review this diff for bugs"
git diff --cached | cortex -p "write a conventional commit message"
cortex -p "run the tests and fix any failures" --yes
```

`--yes` auto-approves mutating tools. Without it, pipe mode rejects mutations and tells the model why.

### CLI flags

```
-p, --prompt <text>     Non-interactive prompt (pipe mode)
--provider <name>       Override provider
--model <name>          Override model
--yes                   Auto-approve all tool calls
--resume <session-id>   Resume a previous session
--plain                 Line-based mode instead of the Ink TUI
--num-ctx <number>      Ollama context window size (default 16384)
-V, --version           Print version
-h, --help              Help
```

### Slash commands

| Command | Description |
| --- | --- |
| `/model` | List/select a model (auto-discovers Ollama models) |
| `/provider` | Switch provider |
| `/key <provider> <key>` | Save an API key |
| `/compact` | Summarise and shrink the conversation |
| `/sessions` | List saved sessions |
| `/clear` | Reset the conversation |
| `/help` | Show help |

Resume work later:

```bash
cortex --resume <session-id>
```

---

## How it works

- **ReAct agent loop** with up to 25 tool iterations per request, streaming output, and abort support.
- **Tools:** `read_file` (line ranges), `write_file`, `edit_file` (surgical SEARCH/REPLACE blocks with unified diffs), `glob_files`, `grep_search` (ripgrep with JS fallback), `bash_exec` (timeouts, output truncation, dangerous-command blocking).
- **Human-in-the-loop safety:** read-only tools run automatically; file writes, edits, and shell commands show a colour-coded diff/command preview and ask `[y] once / [a] session / [n] reject`.
- **Small-model friendly:** models without native tool calling get an XML `<tool_call>` fallback parser, so local 7B models still work.
- **Context management:** token estimation and automatic conversation compaction at ~75% of the model's context window.
- **MCP support:** connect external tool servers over stdio or Streamable HTTP.

### Configuration files

All state lives in `~/.cortex` (or `$CORTEX_HOME`):

```
~/.cortex/
├── bin/cortex.js        # installed bundle
├── config.json          # active provider/model, keys, endpoints
├── sessions.db          # SQLite session history
└── mcp.json             # optional MCP servers
```

`mcp.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    }
  }
}
```

Environment variables always override saved keys.

---

## Build from source

```bash
git clone https://github.com/Ashish-Karmakar-coding/cortex.git
cd cortex
npm install
npm run build       # bundles src/ -> dist/cortex.js
node dist/cortex.js --version
```

Useful scripts:

| Script | Description |
| --- | --- |
| `npm run build` | Type-check-free esbuild bundle (fast, single file) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Subsystem verification suite |
| `npm run dev` | Build and launch |
| `npm run package` | Stage release files in `release/cortex` |

### Releasing

Pushing a tag triggers the GitHub Actions release workflow, which builds the bundle, runs tests, and publishes:

```
cortex.tar.gz        # macOS / Linux installer asset
cortex.zip           # Windows installer asset
cortex-<version>.*   # versioned copies
SHA256SUMS
```

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `cortex: command not found` | Open a new terminal, or add `~/.local/bin` (Unix) / `%USERPROFILE%\.cortex\bin` (Windows) to `PATH`. |
| `Node.js ... is too old` | Install Node.js 22.13+. |
| `No models found` | Make sure Ollama is running (`ollama serve`) or LM Studio's server is enabled. |
| Local model never calls tools | Try `/model` with a tool-capable model (e.g. `qwen2.5-coder`); Cortex also falls back to XML tool calls for smaller models. |
| Windows SQLite warning | `node:sqlite` is still marked experimental by Node; the warning is harmless. |
| Installer 404 | No release has been published yet — check the repo's **Releases** page, or build from source. |

---

## License

[MIT](LICENSE)
