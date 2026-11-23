#!/usr/bin/env bash
#
# Cortex installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Ashish-Karmakar-coding/cortex/main/install.sh | bash
#
# Environment variables:
#   CORTEX_HOME          Install directory           (default: ~/.cortex)
#   CORTEX_BIN_DIR       Where to link `cortex`      (default: ~/.local/bin)
#   CORTEX_VERSION       Release tag to install      (default: latest)
#   CORTEX_REPO          GitHub owner/repo           (default: Ashish-Karmakar-coding/cortex)
#   CORTEX_DOWNLOAD_URL  Override the archive URL    (useful for mirrors/testing)
#
set -euo pipefail

REPO="${CORTEX_REPO:-Ashish-Karmakar-coding/cortex}"
CORTEX_HOME="${CORTEX_HOME:-$HOME/.cortex}"
VERSION="${CORTEX_VERSION:-latest}"

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }

cyan "Cortex installer"

# --- Requirements -----------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  red "Node.js 22.13 or newer is required, but \`node\` was not found."
  echo "Install Node.js from https://nodejs.org, then re-run this script."
  exit 1
fi

NODE_MAJOR_MINOR="$(node -p 'process.versions.node.split(".").slice(0,2).join(".")')"
NODE_OK="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); a>22||(a===22&&b>=13)?"1":"0"')"
if [ "$NODE_OK" != "1" ]; then
  red "Node.js $NODE_MAJOR_MINOR found, but Cortex needs 22.13+."
  echo "Upgrade Node.js from https://nodejs.org and try again."
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  red "curl or wget is required to download Cortex."
  exit 1
fi

# --- Download ---------------------------------------------------------------

if [ -n "${CORTEX_DOWNLOAD_URL:-}" ]; then
  URL="$CORTEX_DOWNLOAD_URL"
elif [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/cortex.tar.gz"
else
  VERSION="${VERSION#v}"
  URL="https://github.com/$REPO/releases/download/v$VERSION/cortex.tar.gz"
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t cortex)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

cyan "Downloading $URL"
if ! download "$URL" "$TMP_DIR/cortex.tar.gz"; then
  red "Download failed."
  echo "Check https://github.com/$REPO/releases for an available release."
  exit 1
fi

mkdir -p "$CORTEX_HOME"
if ! tar -xzf "$TMP_DIR/cortex.tar.gz" -C "$CORTEX_HOME"; then
  red "Could not extract the Cortex archive."
  exit 1
fi

if [ ! -f "$CORTEX_HOME/bin/cortex.js" ]; then
  red "The archive did not contain bin/cortex.js."
  exit 1
fi

# --- Launcher ---------------------------------------------------------------

LAUNCHER="$CORTEX_HOME/bin/cortex"
cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node --disable-warning=ExperimentalWarning "$DIR/cortex.js" "$@"
EOF

chmod 755 "$LAUNCHER" "$CORTEX_HOME/bin/cortex.js"

# --- PATH -------------------------------------------------------------------

if [ -n "${CORTEX_NO_MODIFY_PATH:-}" ]; then
  BIN_DIR="$CORTEX_HOME/bin"
  PATH_UPDATED=0
else
  if [ -n "${CORTEX_BIN_DIR:-}" ]; then
    BIN_DIR="$CORTEX_BIN_DIR"
  elif [ "$(id -u)" -eq 0 ] && [ -w /usr/local/bin ]; then
    BIN_DIR="/usr/local/bin"
  else
    BIN_DIR="$HOME/.local/bin"
  fi

  mkdir -p "$BIN_DIR"
  ln -sf "$LAUNCHER" "$BIN_DIR/cortex"

  PATH_UPDATED=0
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      case "${SHELL:-}" in
        *zsh) PROFILE="$HOME/.zshrc" ;;
        *bash) PROFILE="$HOME/.bashrc" ;;
        *) PROFILE="$HOME/.profile" ;;
      esac
      touch "$PROFILE"
      if ! grep -q '# Added by Cortex installer' "$PROFILE" 2>/dev/null; then
        {
          printf '\n# Added by Cortex installer\n'
          printf 'export PATH="%s:$PATH"\n' "$BIN_DIR"
        } >> "$PROFILE"
        PATH_UPDATED=1
      fi
      ;;
  esac
fi

# --- Done -------------------------------------------------------------------

INSTALLED_VERSION="$(node "$CORTEX_HOME/bin/cortex.js" --version 2>/dev/null || echo "unknown")"
green "Cortex $INSTALLED_VERSION installed."
echo "  Binary : $BIN_DIR/cortex"
echo "  Data   : $CORTEX_HOME"
echo

case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "Run: cortex"
    ;;
  *)
    if [ "$PATH_UPDATED" = "1" ]; then
      echo "Restart your terminal (or run \`source $PROFILE\`), then run: cortex"
    else
      echo "Add $BIN_DIR to your PATH, then run: cortex"
    fi
    ;;
esac
