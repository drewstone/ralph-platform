#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${RALPH_REPO:-drewstone/ralph-platform}"
INSTALL_DIR="${RALPH_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${RALPH_VERSION:-latest}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Install Ralph CLI binaries from GitHub Releases.

Usage:
  install.sh [--version <x.y.z|latest>] [--repo <owner/repo>] [--install-dir <dir>]

Environment overrides:
  RALPH_REPO
  RALPH_VERSION
  RALPH_INSTALL_DIR
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ "$VERSION" == "latest" ]]; then
  ARCHIVE_URL="https://github.com/${REPO}/releases/latest/download/ralph-cli.tar.gz"
  CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/ralph-cli.tar.gz.sha256"
else
  TAG="loop-cli-v${VERSION}"
  ARCHIVE_URL="https://github.com/${REPO}/releases/download/${TAG}/ralph-cli-${VERSION}.tar.gz"
  CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/ralph-cli-${VERSION}.tar.gz.sha256"
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

archive_name="$(basename "$ARCHIVE_URL")"
checksum_name="$(basename "$CHECKSUM_URL")"
archive_file="$tmp_dir/$archive_name"
checksum_file="$tmp_dir/$checksum_name"

echo "Downloading: $ARCHIVE_URL"
curl -fLsS "$ARCHIVE_URL" -o "$archive_file"

echo "Downloading checksum: $CHECKSUM_URL"
curl -fLsS "$CHECKSUM_URL" -o "$checksum_file"

if command -v shasum >/dev/null 2>&1; then
  (
    cd "$tmp_dir"
    shasum -a 256 -c "$checksum_name"
  )
elif command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$tmp_dir"
    sha256sum -c "$checksum_name"
  )
else
  echo "Warning: no sha256 tool found; skipping checksum verification."
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$archive_file" -C "$tmp_dir"

cp "$tmp_dir/ralph-cli/bin/ralph" "$INSTALL_DIR/ralph"
cp "$tmp_dir/ralph-cli/bin/ralph-loop" "$INSTALL_DIR/ralph-loop"
cp "$tmp_dir/ralph-cli/bin/ralph-dispatch" "$INSTALL_DIR/ralph-dispatch"
chmod +x "$INSTALL_DIR/ralph" "$INSTALL_DIR/ralph-loop" "$INSTALL_DIR/ralph-dispatch"

echo "Installed to: $INSTALL_DIR"
echo "Run: ralph --help"
if [[ ":${PATH}:" != *":${INSTALL_DIR}:"* ]]; then
  echo "Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\""
fi
