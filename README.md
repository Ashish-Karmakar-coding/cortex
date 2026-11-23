# CodyCLI 🤖

An open-source, production-grade agentic coding CLI tool (similar to Claude Code and Codex CLI) built in TypeScript on Node.js 22+ with full ESM support.

CodyCLI gives LLMs controlled hands inside your local filesystem, shell, and git environment using an autonomous ReAct loop, human-in-the-loop safety gating with unified diffs, local-first inference via Ollama / LM Studio, and multi-provider Bring-Your-Own-Key (BYOK) cloud support.

---

## ✨ Key Features

1. **Local-First + Bring-Your-Own-Key (BYOK) Multi-Provider Support:**
   - **Local LLMs:** Works out-of-the-box with **Ollama** (`http://localhost:11434`) and any OpenAI-compatible local server (**LM Studio**, llama.cpp, vLLM).
   - **Cloud Providers:** Plug in API keys for **Anthropic, OpenAI, Google Gemini, Groq, and OpenRouter**.
   - **Dynamic Switching:** Switch providers and models on the fly via CLI flags (`--provider`, `--model`) or interactive slash commands (`/provider`, `/model`, `/key`).
   - **Local Model Auto-Discovery:** Fetches installed Ollama models via `/api/tags` directly in the `/model` selector.
   - **Context Window Hygiene:** Sets explicit `num_ctx` (default `16384` or `32768`) to eliminate Ollama's silent 2048/4096-token truncation.

2. **Full Agentic Coding Capabilities (ReAct Loop):**
   - Autonomous ReAct loop exploring codebases, reading files, performing surgical edits, executing shell commands, and iterating on compiler/test errors.
   - **Interactive Ink TUI Mode:** Rich terminal user interface built with React for CLI (`ink`, `ink-spinner`, `ink-text-input`, `cli-highlight`).
   - **Non-Interactive Unix Pipe / Headless Mode:** Pipe input directly for CI/CD or git hooks (e.g. `git diff | cody -p "write a commit message"` or `cody -p "fix failing tests" --yes`).
   - **Surgical `edit_file` Tool:** Uses targeted `search_block` and `replace_block` matching (with whitespace-normalized fallback) and unified diff previews rather than full file rewrites.
   - **XML Fallback Parser:** Allows smaller quantized models (7B/14B) without reliable JSON schema calling to call tools via `<tool_call>` XML blocks.
   - **Auto-Compaction:** Automatically summarizes conversation history when token count reaches 75% of context window limits, preserving critical technical facts.

3. **Human-in-the-Loop Safety:**
   - **Tier 1 (Auto-Approved):** Read-only tools (`read_file`, `glob_files`, `grep_search`, `git_status`) execute immediately without prompting.
   - **Tier 2 (Interactive Confirmation):** Mutating tools (`write_file`, `edit_file`, `bash_exec`) pause execution and display colour-coded unified diffs or command previews, offering `[y] Allow once`, `[a] Allow for session`, or `[n] Reject with feedback`.
   - **Tier 3 (Dangerous Pattern Block):** Commands matching destructive shell patterns (`rm -rf /`, `mkfs`, `dd if=`, pipe-to-shell, etc.) are blocked before execution.

4. **Persistence & Extensibility:**
   - **Session Storage:** Fast session persistence using Node.js 22's built-in `node:sqlite` database. Resume previous sessions with `--resume <id>`.
   - **Secure Config:** Stored at `~/.config/codycli/config.json` with strict `0600` permissions.
   - **Model Context Protocol (MCP):** Connects to external tool servers via standard stdio or Streamable HTTP transports configured in `~/.config/codycli/mcp.json`.

---

## 🏗️ Architecture

```
[User Prompt / Pipe Input]
         │
         ▼
[Context Builder] ──► Injects OS, CWD, Git branch & status, Directory tree skeleton
         │
         ▼
[LLM Provider Stream] ──► Streams tokens to Ink TUI / stdout in real time
         │
         ├──► (Model outputs plain text) ──► Renders response & waits for next prompt
         │
         └──► (Model emits Tool Call - Native or XML fallback)
                    │
                    ▼
            [Permission Gate]
              ├── Read-only tool? ──► Execute immediately
              └── Mutating/Shell? ──► Pause loop, render Unified Diff, await [y/a/n]
                    │
                    ▼
            [Tool Execution] ──► Runs locally, truncates huge outputs (e.g. >300 lines)
                    │
                    ▼
            [Append Result to Context] ──► Loops back to [LLM Provider Stream]
```

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 22.0.0+**
- **npm** or **pnpm** / **yarn**

### 1. Installation & Build

```bash
# Clone the repository
git clone https://github.com/your-username/codycli.git
cd codycli

# Install dependencies
npm install

# Build TypeScript to dist/
npm run build

# Link globally for terminal access
npm link
```

Now `cody` is available from anywhere in your shell.

---

## 🦙 Local LLM Setup (Ollama & LM Studio)

### Using with Ollama (Default)

1. Install and start [Ollama](https://ollama.com/):
   ```bash
   ollama serve
   ```
2. Pull a recommended coding model:
   ```bash
   ollama pull qwen2.5-coder:14b
   # or
   ollama pull llama3.2
   ```
3. Run CodyCLI:
   ```bash
   cody --provider ollama --model qwen2.5-coder:14b
   ```
   Or set it interactively inside the CLI using `/model`.

### Using with LM Studio / vLLM / llama.cpp

Start LM Studio's local server (default: `http://localhost:1234/v1`), then run:
```bash
cody --provider lmstudio --model local-model
```

---

## 🔑 Cloud BYOK (Bring Your Own Key)

Set keys via environment variables:

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI
export OPENAI_API_KEY="sk-proj-..."

# Google Gemini
export GOOGLE_API_KEY="AIzaSy..."

# Groq
export GROQ_API_KEY="gsk_..."

# OpenRouter
export OPENROUTER_API_KEY="sk-or-..."
```

Or set keys persistently inside CodyCLI using the slash command:
```text
cody> /key anthropic sk-ant-...
cody> /key openai sk-proj-...
cody> /key google AIzaSy...
```
Keys are saved to `~/.config/codycli/config.json` with `chmod 0600` file permissions.

---

## 💻 Usage Modes

### 1. Interactive TUI Mode

Launch the interactive interface in your project directory:

```bash
cody
```

You can pass initial flags:
```bash
cody --provider anthropic --model claude-sonnet-4-20250514
```

### 2. Non-Interactive Unix Pipe / Headless Mode

Combine CodyCLI with git, tests, and standard Unix pipelines:

```bash
# Code review a git diff
git diff | cody -p "Review this diff for bugs and performance issues"

# Generate a commit message
git diff --cached | cody -p "Generate a concise conventional commit message"

# Run tests and fix failing files automatically
cody -p "Run npm test and fix any failing test cases" --yes

# Check git status and explain untracked files
git status | cody -p "Summarize what changed"
```

The `--yes` flag auto-approves all tool executions, making it suitable for automated CI/CD scripts.

---

## ⌨️ Interactive Slash Commands

Inside the interactive mode, use these commands at the prompt:

| Command | Description |
|---------|-------------|
| `/provider` | Switch between `ollama`, `lmstudio`, `openai`, `anthropic`, `google`, `groq`, `openrouter` |
| `/model` | Open interactive model selector (auto-fetches live Ollama models or shows curated list) |
| `/key <provider> <key>` | Securely store an API key in `config.json` with 0600 permissions |
| `/compact` | Compress conversation history into a dense technical summary to free up tokens |
| `/sessions` | List saved SQLite sessions with their IDs and timestamps |
| `/clear` | Clear the current conversation history |
| `/help` | Display command help and keyboard shortcuts |

### Keyboard Shortcuts
- **Ctrl+C (while streaming / running command):** Aborts the active process tree cleanly and preserves conversation state.
- **Ctrl+C (twice on empty prompt):** Exits the CLI cleanly.
- **Esc:** Closes modals or cancels rejection prompts.
- **y / a / n:** In approval dialog, triggers *Allow once*, *Allow for session*, or *Reject with feedback*.

---

## 🔌 Model Context Protocol (MCP) Integration

CodyCLI supports connecting to external MCP tool servers. Create `~/.config/codycli/mcp.json`:

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    },
    {
      "name": "postgres",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    }
  ]
}
```

Tools exposed by these servers are automatically discovered and registered with the agent loop.

---

## 📂 Project Structure

```
codycli/
├── package.json              # bin entry point, dependencies, build scripts
├── tsconfig.json             # TypeScript 5.7+ strict ESM configuration
├── README.md                 # Documentation
├── LICENSE                   # MIT License
└── src/
    ├── index.ts              # CLI entrypoint (TTY detection, pipe handler, CLI flags)
    ├── config/
    │   ├── store.ts          # Read/write ~/.config/codycli/config.json with 0600 permissions
    │   └── models.ts         # Provider registry, context limits, Ollama model discovery
    ├── providers/
    │   └── factory.ts        # Unified AI SDK model creator with num_ctx options
    ├── agent/
    │   ├── loop.ts           # Core ReAct loop, streaming, diff previews, approval gate
    │   ├── prompts.ts        # Dynamic system prompt (OS, cwd, git branch, repo map)
    │   ├── fallbackParser.ts # XML/JSON tool-call parser for local LLMs
    │   └── compaction.ts     # Token estimator & conversation summarizer (75% limit)
    ├── tools/
    │   ├── registry.ts       # Zod tool definitions, permissions, dangerous patterns
    │   ├── fs.ts             # read_file (line-ranged), write_file, edit_file (SEARCH/REPLACE)
    │   ├── search.ts         # glob_files, grep_search (ripgrep with JS fallback)
    │   └── shell.ts          # bash_exec (timeout, output truncation, process kill)
    ├── mcp/
    │   └── client.ts         # MCP client loader (stdio and streamable HTTP)
    ├── persistence/
    │   └── sessions.ts       # SQLite session history store using node:sqlite
    └── tui/
        ├── App.tsx           # Root Ink component with keyboard listeners
        ├── MessageList.tsx   # Markdown + syntax-highlighted streaming renderer
        ├── ApprovalPrompt.tsx# Interactive diff viewer & tool permission selector
        └── ModelSelector.tsx # Interactive provider/model & API key modal
```

---

## 🛡️ License

MIT License. See [LICENSE](LICENSE) for details.
