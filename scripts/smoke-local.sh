#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

WEB_AGENT_PROVIDER="${WEB_AGENT_PROVIDER:-codex}"
SMOKE_KEEPALIVE="${SMOKE_KEEPALIVE:-0}"

print_manual_verification_guidance() {
  cat <<'EOF'

Manual verification checklist (UI):
  - Create session: use the + / New Session affordance; confirm a new session appears in the list.
  - task/todo progress: send a prompt that causes a multi-step plan; confirm todos update as turns stream.
  - Approval: trigger an action that requires approval; approve/deny and confirm the run continues accordingly.
  - AskUserQuestion: trigger a question tool; answer it in the UI and confirm the agent resumes.
  - Refresh recovery: refresh the page mid-stream; confirm the UI reconnects and state recovers.
  - Interrupt: click Interrupt (or stop the backend) and confirm the run transitions to an interrupted state.

Tips:
  - Keep the server running for manual checks: set SMOKE_KEEPALIVE=1
  - Use the Claude SDK provider via: WEB_AGENT_PROVIDER=claude-sdk
  - Claude auth is resolved through your existing Claude Code / Agent SDK auth setup
EOF
}

print_claude_hook_guidance() {
  cat <<EOF

Claude hook bridge setup:
  - Protect the local hook endpoint:
      export CLAUDE_HOOK_SECRET="\${CLAUDE_HOOK_SECRET:-change-me}"
      export WEB_AGENT_HOOK_SECRET="\${WEB_AGENT_HOOK_SECRET:-\$CLAUDE_HOOK_SECRET}"
  - Relay hook events back into the web console:
      export WEB_AGENT_RELAY_URL="http://127.0.0.1:${RELAY_PORT}"
  - Point Claude Code hooks at:
      node "${ROOT_DIR}/scripts/claude-hook-relay.mjs"
EOF
}

RELAY_PORT="${RELAY_PORT:-4318}"

case "${WEB_AGENT_PROVIDER}" in
  claude-sdk)
    printf 'Preparing Claude SDK Web Console PoC smoke run (WEB_AGENT_PROVIDER=claude-sdk)...\n'
    printf 'Using existing Claude Code / Agent SDK auth (for example env vars or Claude settings).\n'
    ;;
  codex)
    command -v codex >/dev/null 2>&1 || {
      printf 'codex is required for smoke runs when WEB_AGENT_PROVIDER=codex\n' >&2
      exit 1
    }

    printf 'Preparing Codex Web Console PoC smoke run using codex app-server...\n'
    ;;
  *)
    printf 'Unsupported WEB_AGENT_PROVIDER=%s (supported: codex, claude-sdk)\n' "${WEB_AGENT_PROVIDER}" >&2
    exit 1
    ;;
esac

cd "$ROOT_DIR"
npm install

if [[ "${RELAY_PORT}" == "4318" ]]; then
  RELAY_PORT="$(node -e "const net=require('node:net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });")"
fi

if [[ "${WEB_AGENT_PROVIDER}" == "codex" ]]; then
  CODEX_APP_SERVER_PORT="${CODEX_APP_SERVER_PORT:-4321}"
  if [[ "${CODEX_APP_SERVER_PORT}" == "4321" ]]; then
    CODEX_APP_SERVER_PORT="$(node -e "const net=require('node:net'); const server=net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });")"
  fi
  export RELAY_PORT WEB_AGENT_PROVIDER CODEX_APP_SERVER_PORT
else
  export RELAY_PORT WEB_AGENT_PROVIDER
fi

node ./src/server.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
trap 'kill "$SERVER_PID" 2>/dev/null || true; exit 130' INT TERM

for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${RELAY_PORT}/api/sessions" >/dev/null 2>&1; then
    printf 'Smoke run passed. Relay is ready at http://127.0.0.1:%s\n' "$RELAY_PORT"
    print_manual_verification_guidance
    if [[ "${WEB_AGENT_PROVIDER}" == "claude-sdk" ]]; then
      print_claude_hook_guidance
    fi
    if [[ "${SMOKE_KEEPALIVE}" == "1" ]]; then
      printf '\nKeeping relay running (SMOKE_KEEPALIVE=1). Press Ctrl-C to stop.\n'
      wait "${SERVER_PID}"
    fi
    exit 0
  fi
  sleep 0.25
done

printf 'Smoke run failed: relay did not become ready in time\n' >&2
exit 1
