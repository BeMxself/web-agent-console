#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

print_help() {
  cat <<'EOF'
Usage: ./scripts/start-local-4533.sh [options]

Options:
  --sandbox <mode>      Override the Codex sandbox mode for the managed app-server
  --approval <policy>   Override when Codex routes command approvals through the frontend
  -h, --help            Show this help message and exit

Sandbox modes:
  read-only             No filesystem writes allowed
  workspace-write       Allow writes in the workspace but keep sandboxing
  danger-full-access    Disable sandbox restrictions entirely

Approval policies:
  untrusted             Auto-run only trusted commands; ask for approval for the rest
  on-failure            Auto-run commands first; ask only after a sandboxed execution failure
  on-request            Let Codex decide when to route approval to the frontend
  never                 Never ask for approval; execution failures return directly to Codex

Defaults:
  sandbox  = danger-full-access
  approval = on-request
  auth     = disabled unless WEB_AGENT_AUTH_PASSWORD is set

Environment overrides still work:
  CODEX_SANDBOX_MODE, CODEX_APPROVAL_POLICY, RELAY_HOST, RELAY_PORT, CODEX_APP_SERVER_PORT,
  WEB_AGENT_PROVIDER, WEB_AGENT_AUTH_PASSWORD
EOF
}

validate_sandbox_mode() {
  case "$1" in
    read-only|workspace-write|danger-full-access) ;;
    *)
      printf 'Unsupported sandbox mode: %s\n\n' "$1" >&2
      print_help >&2
      exit 1
      ;;
  esac
}

validate_approval_policy() {
  case "$1" in
    untrusted|on-failure|on-request|never) ;;
    *)
      printf 'Unsupported approval policy: %s\n\n' "$1" >&2
      print_help >&2
      exit 1
      ;;
  esac
}

RELAY_HOST="${RELAY_HOST:-0.0.0.0}"
RELAY_PORT="${RELAY_PORT:-4533}"
CODEX_APP_SERVER_PORT="${CODEX_APP_SERVER_PORT:-4534}"
WEB_AGENT_PROVIDER="${WEB_AGENT_PROVIDER:-codex}"
CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-danger-full-access}"
CODEX_APPROVAL_POLICY="${CODEX_APPROVAL_POLICY:-on-request}"
WEB_AGENT_AUTH_PASSWORD="${WEB_AGENT_AUTH_PASSWORD:-}"

while (($# > 0)); do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    --sandbox)
      if (($# < 2)); then
        printf 'Missing value for --sandbox\n\n' >&2
        print_help >&2
        exit 1
      fi
      CODEX_SANDBOX_MODE="$2"
      shift 2
      ;;
    --sandbox=*)
      CODEX_SANDBOX_MODE="${1#*=}"
      shift
      ;;
    --approval)
      if (($# < 2)); then
        printf 'Missing value for --approval\n\n' >&2
        print_help >&2
        exit 1
      fi
      CODEX_APPROVAL_POLICY="$2"
      shift 2
      ;;
    --approval=*)
      CODEX_APPROVAL_POLICY="${1#*=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

validate_sandbox_mode "${CODEX_SANDBOX_MODE}"
validate_approval_policy "${CODEX_APPROVAL_POLICY}"

cd "${APP_DIR}"

export RELAY_HOST
export RELAY_PORT
export CODEX_APP_SERVER_PORT
export WEB_AGENT_PROVIDER
export CODEX_SANDBOX_MODE
export CODEX_APPROVAL_POLICY
export WEB_AGENT_AUTH_PASSWORD

printf 'Starting web-agent-console-codex on %s:%s\n' "${RELAY_HOST}" "${RELAY_PORT}"
printf 'Managed codex app-server port: %s\n' "${CODEX_APP_SERVER_PORT}"
printf 'Codex sandbox mode: %s\n' "${CODEX_SANDBOX_MODE}"
printf 'Codex approval policy: %s\n' "${CODEX_APPROVAL_POLICY}"
if [[ -n "${WEB_AGENT_AUTH_PASSWORD}" ]]; then
  printf 'Shared password auth: enabled via WEB_AGENT_AUTH_PASSWORD\n'
else
  printf 'Shared password auth: disabled\n'
fi

exec node ./src/server.js
