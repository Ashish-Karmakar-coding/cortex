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
- **Creates and initializes the dedicated local storage partition** (`~/.cortex/storage` by default, or `CORTEX_STORAGE_DIR`) with `cortex.db` (sessions, file checkpoints for `/rewind`, persistent memory, prompt history, tool audit log, and model capability cache), `storage-manifest.json`, `backups/`, `logs/`, `cache/`, and `mcp.json`.
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
| `CORTEX_HOME` | `~/.cortex` | Install directory and config directory |
| `CORTEX_STORAGE_DIR` | `~/.cortex/storage` | Dedicated local storage partition directory |
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

The CLI downloads the latest `cortex.js` bundle from GitHub Releases and atomically replaces `~/.cortex/bin/cortex.js`. Your config, API keys, and sessions in `~/.cortex` are preserved.

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

Keyboard shortcuts:

| Key | Action |
| --- | --- |
| `Enter` | Send the prompt or run the selected slash command |
| `\` + `Enter` | Insert a newline |
| `↑` / `↓` | Prompt history, or navigate the `/` palette |
| `Tab` | Complete a slash command or `@file` mention |
| `Shift+Tab` | Cycle mode: manual → auto-approve → plan (read-only) |
| `@path/to/file` | Attach local file contents directly into the prompt |
| `!command` | Run a shell command directly |
| `Ctrl+C` | Interrupt the agent; press twice when idle to exit |

Type `/` to open a filterable command palette (Claude Code style), or `@` to autocomplete project files. While a response is streaming, typing keeps the prompt responsive and queues your next message.

Cortex uses a **solid, non-transparent** dark-green / warm-beige surface: **`#2C3930` background** with **`#DCD7C9` elements**. Every rendered cell, border, panel, and row edge is painted solidly in `#2C3930` alongside OSC 10/11/12 terminal theming (restored on exit). To customize, edit `src/tui/palette.ts`.

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
| `/help` | Show all commands and shortcuts |
| `/model` | List/select a model (auto-discovers Ollama/LM Studio models & tool capabilities) |
| `/provider` | Switch provider |
| `/key <provider> <key>` | Save an API key |
| `/auto` | Toggle auto-approve for tool calls |
| `/plan` | Toggle read-only Plan mode |
| `/compact` | Summarise and shrink the conversation |
| `/context` | Show token usage and context window details |
| `/diff` | View current git status and working tree diff |
| `/rewind [id]` | Undo file edits from recent checkpoints (`/undo`) |
| `/sessions` | List saved sessions |
| `/resume [id]` | Resume a session (picker if no id) |
| `/new`, `/clear` | Start a fresh conversation |
| `/init` | Generate `CORTEX.md` with project commands and layout |
| `/memory [add k=v]` | View or add persistent user/project memory |
| `/mcp [reload]` | Inspect or reload configured MCP servers |
| `/storage` | Show local storage partition location and stats |
| `/config [k v]` | View or update settings (`numCtx`, `baseUrl`, `storageDir`) |
| `/permissions` | View active permission mode and allow/deny rules |
| `/status` | Show model, context, session, storage, and mode state |
| `/doctor` | Check Node, config, local storage DB, and provider connectivity |
| `/export` | Export the conversation to Markdown |
| `/agents` | List built-in and custom subagents |
| `/quit` | Exit Cortex |

### Project instructions

Run `/init` once in a repository to create `CORTEX.md`. Cortex loads it into the system prompt on every turn, so the agent knows your package manager, scripts, and layout. Edit it freely — `/init` never overwrites an existing file.

### Subagents

Delegate broad or independent work with the `task` tool. The subagent runs in an isolated context with its own tool allowlist and returns a short report, so search noise never bloats the main conversation. Delegation is shown as an approval prompt and a live status line in the TUI.

Built-in agents:

| Agent | Tools | Purpose |
| --- | --- | --- |
| `general-purpose` | all | Multi-step research and implementation |
| `explore` | read-only | Find files, symbols, and answers about the codebase |
| `plan` | read-only | Produce a step-by-step implementation plan |
| `review` | read-only | Review the working tree for bugs and missing tests |

Add your own in `.cortex/agents/<name>.md` (project) or `~/.cortex/agents/<name>.md` (user):

```markdown
---
name: docs
description: Documentation specialist
tools: read_file, glob_files
---

You are a documentation subagent. Find and summarize project docs.
```

Run `/agents` to see everything Cortex has loaded.

Resume work later:

```bash
cortex --resume <session-id>
```

---

## How it works

- **ReAct agent loop** with up to 25 tool iterations per request, streaming output, and abort support.
- **Tools:** `read_file` (line ranges), `write_file`, `edit_file` (surgical SEARCH/REPLACE blocks with CRLF/LF normalization & unified diffs), `glob_files`, `grep_search` (ripgrep with JS fallback), `git_status`, `git_diff`, `git_log`, `todo_write`, `web_fetch`, `bash_exec` (timeouts, output truncation, dangerous-command blocking), `task` (subagent delegation), plus MCP tools.
- **Hybrid Local LLM Tool Calling:** Uses a native Ollama `/api/chat` streaming adapter with `/api/show` capability detection (`tools` + `context_length`), OpenAI-compatible tool calling for LM Studio / vLLM / llama.cpp, automatic downgrade on `"does not support tools"` errors, and a multi-format fallback parser (`<tool_call>`, Qwen `<function=...>`, pretty JSON blocks, and parameter alias normalization).
- **Human-in-the-loop safety:** read-only tools run automatically; file writes, edits, shell commands, web fetches, and subagent delegation show a preview and ask `[y] once / [a] session / [n] reject`. `Shift+Tab` cycles `manual → auto-approve → plan (read-only)`. File edits automatically record checkpoints for `/rewind`.
- **Context management:** token estimation and automatic conversation compaction at ~75% of the model's context window. The system prompt (git state + repo tree + global/project `CORTEX.md` + local memory) is built once per turn instead of once per tool iteration.
- **Solid TUI:** completed turns are printed once with Ink `<Static>`; streamed text is buffered to ~20 updates/second; every line and panel is painted solidly in `#2C3930` without transparent gaps.
- **MCP support:** connect external tool servers over stdio or Streamable HTTP via `~/.cortex/mcp.json` or `.cortex/mcp.json`.

### Configuration & local storage partition

All configuration and the default local storage partition live in `~/.cortex` (or `$CORTEX_HOME` / `$CORTEX_STORAGE_DIR`):

```
~/.cortex/
├── bin/cortex.js              # installed bundle
├── config.json                # active provider/model, keys, endpoints, storageDir
├── mcp.json                   # MCP servers
├── CORTEX.md                  # optional global instructions
├── agents/                    # optional user-level subagents (*.md)
└── storage/                   # local storage partition (created during install)
    ├── storage-manifest.json  # partition ID & schema metadata
    ├── cortex.db              # SQLite DB (sessions, checkpoints, memory, history, audit logs, model cache)
    ├── backups/
    ├── logs/
    └── cache/
```

Run `cortex init-storage [--storage-dir <path>]` to create/relocate the storage partition, or `cortex storage` to inspect its usage.

Project-level subagents live in `.cortex/agents/` and project instructions in `CORTEX.md`.

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
cortex.js            # self-contained bundle used by `cortex upgrade`
cortex.tar.gz        # macOS / Linux installer asset
cortex.zip           # Windows installer asset
cortex-<version>.*   # versioned copies
SHA256SUMS
```

```bash
git tag v0.2.0
git push origin v0.2.0
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
