#!/usr/bin/env bash

set -euo pipefail

found=0

scan() {
  local label="$1"
  local pattern="$2"
  local matches

  matches="$(git grep --no-index --exclude-standard --line-number --full-name --extended-regexp --ignore-case -I -e "$pattern" -- . ':!scripts/security-scan.sh' || true)"
  if [[ -n "$matches" ]]; then
    printf 'Potential %s found:\n%s\n' "$label" "$matches" >&2
    found=1
  fi
}

# This is a dependency-free guard for the working tree. CI should add a managed
# secret scanner when the hosting policy provides one; this check catches the
# common credential formats without requiring network access.
scan 'private key' '-----BEGIN ([A-Z0-9]+ )?PRIVATE KEY-----'
scan 'AWS access key' 'AKIA[0-9A-Z]{16}'
scan 'GitHub token' '(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})'
scan 'Slack token' 'xox[baprs]-[A-Za-z0-9-]{20,}'
scan 'OpenAI-style token' 'sk-[A-Za-z0-9]{20,}'
scan 'hard-coded credential assignment' '(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'][^"'"']{12,}["'"']'

if (( found != 0 )); then
  exit 1
fi

printf '%s\n' 'Secret scan passed: no common credential patterns found in the working tree.'
