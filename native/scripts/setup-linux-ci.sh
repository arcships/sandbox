#!/usr/bin/env bash
set -euo pipefail

PNPM_VERSION="${PNPM_VERSION:-10.33.4}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"

install_linux_packages() {
  if command -v apk >/dev/null 2>&1; then
    local packages=(
      bash
      bubblewrap
      build-base
      ca-certificates
      curl
      git
      openssl-dev
      perl
      pkgconf
      xz
    )
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      packages+=(nodejs-current npm)
    fi
    apk add --no-cache "${packages[@]}"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    local packages=(
      bubblewrap
      build-essential
      ca-certificates
      curl
      git
      libssl-dev
      perl
      pkg-config
      xz-utils
    )
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      packages+=(nodejs npm)
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
    return
  fi

  echo "[ci] no supported package manager found; expected apk or apt-get" >&2
  return 1
}

if ! command -v node >/dev/null 2>&1 \
  || ! command -v npm >/dev/null 2>&1 \
  || ! command -v cargo >/dev/null 2>&1 \
  || ! command -v bwrap >/dev/null 2>&1; then
  install_linux_packages
fi

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo 0
    return
  fi
  node -p "Number(process.versions.node.split('.')[0])"
}

install_node_tarball() {
  local machine node_arch archive root
  machine="$(uname -m)"
  case "${machine}" in
    x86_64) node_arch="x64" ;;
    aarch64 | arm64) node_arch="arm64" ;;
    *) echo "[ci] unsupported Linux node arch: ${machine}" >&2; return 1 ;;
  esac

  archive="/tmp/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  root="/tmp/node-v${NODE_VERSION}-linux-${node_arch}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o "${archive}"
  rm -rf "${root}"
  tar -xJf "${archive}" -C /tmp
  cp -R "${root}/"* /usr/local/
  hash -r
}

if [[ "$(node_major_version)" -lt 18 ]]; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs-current npm
    hash -r
  else
    install_node_tarball
  fi
fi

linux_rust_target() {
  local machine rust_target
  machine="$(uname -m)"
  case "${machine}" in
    x86_64) rust_target="x86_64-unknown-linux-gnu" ;;
    aarch64 | arm64) rust_target="aarch64-unknown-linux-gnu" ;;
    *) echo "[ci] unsupported Linux rust arch: ${machine}" >&2; return 1 ;;
  esac
  echo "${rust_target}"
}

install_rustup_toolchain() {
  local rust_target
  rust_target="$(linux_rust_target)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --target "${rust_target}"

  ln -sf "${HOME}/.cargo/bin/cargo" /usr/local/bin/cargo
  ln -sf "${HOME}/.cargo/bin/rustc" /usr/local/bin/rustc
  ln -sf "${HOME}/.cargo/bin/rustup" /usr/local/bin/rustup
  hash -r
}

if ! command -v rustup >/dev/null 2>&1; then
  install_rustup_toolchain
else
  rustup target add "$(linux_rust_target)"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable || npm install -g "pnpm@${PNPM_VERSION}"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g "pnpm@${PNPM_VERSION}"
fi

node -v
pnpm --version
cargo --version
bwrap --version
