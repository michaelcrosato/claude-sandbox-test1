#!/usr/bin/env bash
# Install dependencies reproducibly from the lockfile.
source "$(dirname -- "$0")/_common.sh"

info "package manager: $PM"
case "$PM" in
  npm)
    if [ -f package-lock.json ]; then npm ci; else npm install; fi ;;
  pnpm) pnpm install --frozen-lockfile ;;
  yarn) yarn install --frozen-lockfile ;;
esac
ok "dependencies installed"
