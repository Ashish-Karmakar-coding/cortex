# Master Specification: Cortex

An open-source, production-grade agentic coding CLI tool (similar to Claude Code and Codex CLI) in TypeScript using Node.js 22+ (ESM).

### Core Product Requirements
1. **Local-First + Bring-Your-Own-Key (BYOK) Multi-Provider Support:**
   - Must work out-of-the-box with local LLMs via **Ollama** (`http://localhost:11434`) and any OpenAI-compatible local server (LM Studio, llama.cpp, vLLM).
   - Must allow users to plug in API keys for cloud providers (**Anthropic, OpenAI, Google Gemini, Groq, OpenRouter**) and switch providers/models dynamically via CLI flags (`--provider`, `--model`) or interactive slash commands (`/provider`, `/model`, `/key`).
   - Auto-discover locally installed Ollama models via `/api/tags` when `/model` is invoked.
2. **Full Agentic Coding Capabilities:**
   - Autonomous ReAct loop capable of exploring codebases, reading files, making surgical multi-file edits, running shell commands, inspecting git diffs/logs, and iterating on test/build errors until the task is solved.
   - Support both **Interactive TUI Mode** (`cortex`) and **Non-Interactive Unix Pipe / Headless Mode** (`git diff | cortex -p "review this"` or `cortex -p "fix failing tests" --yes`).
3. **Human-in-the-Loop Safety:**
   - Auto-approve read-only tools (`read_file`, `glob_files`, `grep_search`, `git_status`).
   - Pause and render a colour-coded unified diff or command preview before executing mutating tools (`write_file`, `edit_file`, `bash_exec`), offering `[y] Allow once / [a] Allow for session / [n] Reject with feedback`.

### Tech Stack
- **Runtime & Language:** Node.js 22+, TypeScript (strict mode, ESM)
- **CLI Argument Parser:** `commander`
- **Terminal UI (TUI):** `ink` (React for CLI), `ink-text-input`, `ink-select-input`, `ink-spinner`, `cli-highlight`
- **LLM Abstraction Layer:** Vercel AI SDK (`ai` v4) + `ollama-ai-provider` + `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`
- **Validation & Diffing:** `zod`, `diff` (for unified diff generation), `fast-glob`
- **Persistence & Config:** Node built-in `node:sqlite` (for session history) + `~/.cortex/config.json` (with 0600 file permissions for stored API keys + environment variable overrides)
- **Extensibility:** `@modelcontextprotocol/sdk` for connecting external MCP servers via `stdio` and `Streamable HTTP`

### Project Architecture & Folder Structure
```
Cortex/
├── package.json              # bin entry point, ESM config, scripts
├── tsconfig.json
├── README.md                 # Setup, local Ollama guide, BYOK setup, slash commands
├── LICENSE                   # MIT
└── src/
    ├── index.ts              # CLI entrypoint (detects TTY vs pipe mode)
    ├── config/
    │   ├── store.ts          # Read/write ~/.cortex/config.json + env fallbacks
    │   └── models.ts         # Provider registry, context limits, Ollama model fetcher
    ├── providers/
    │   └── factory.ts        # Returns unified AI SDK LanguageModel + Ollama num_ctx options
    ├── agent/
    │   ├── loop.ts           # Core ReAct loop, streaming handler, AbortController
    │   ├── prompts.ts        # Dynamic system prompt (OS, cwd, git branch, repo map)
    │   ├── fallbackParser.ts # XML/JSON tool-call parser for smaller local LLMs
    │   └── compaction.ts     # Token estimator & conversation summariser at 75% context
    ├── tools/
    │   ├── registry.ts       # Zod-validated tool definitions & permission metadata
    │   ├── fs.ts             # read_file (line-ranged), write_file, edit_file (SEARCH/REPLACE)
    │   ├── search.ts         # glob_files, grep_search (ripgrep with JS fallback)
    │   └── shell.ts          # bash_exec (timeout, stdout/stderr truncation, process group kill)
    ├── mcp/
    │   └── client.ts         # Loads MCP servers from ~/.cortex/mcp.json & registers tools
    ├── persistence/
    │   └── sessions.ts       # SQLite store for saving and resuming sessions (--resume)
    └── tui/
        ├── App.tsx           # Root Ink component, keyboard shortcuts (Ctrl+C abort)
        ├── MessageList.tsx   # Markdown + syntax-highlighted streaming message renderer
        ├── ApprovalPrompt.tsx# Interactive diff viewer & tool permission selector
        └── ModelSelector.tsx # Interactive provider/model & API key setup modal
```

### Distribution & Installation
- **Single-file bundle:** `scripts/build.mjs` uses esbuild to bundle `src/` (including Ink, React, and the AI SDK) into `dist/cortex.js`, so users do not need to install runtime dependencies.
- **Curl installers:** `install.sh` (macOS/Linux) and `install.ps1` (Windows) download the latest GitHub Release archive, install into `~/.cortex` (`$CORTEX_HOME`), and put a `cortex` launcher on `PATH`.
- **Release automation:** `.github/workflows/release.yml` builds and publishes `cortex.tar.gz` and `cortex.zip` assets on every `v*` tag; the installers resolve `releases/latest/download/...`.
- **Self-update:** `cortex upgrade` re-runs the platform installer.
- **Minimal runtime requirement:** Node.js 22.13+ (for the unflagged `node:sqlite` module). No npm global install is required.

