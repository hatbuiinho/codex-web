# Reconnect and large-context recovery

The web bridge and the model connection are separate transports. A working
browser WebSocket does not imply the CLI's Responses connection is healthy.

## Model transport

`docker/codex-cli` selects `openai-http` (Responses HTTP/SSE, existing OpenAI
authentication). CLI 0.153.2 rejects overrides of the reserved `openai` provider;
the custom provider is intentional. No authentication files are rewritten.
The local Desktop `thread/resume` request explicitly selects this provider too:
otherwise existing threads keep their persisted `openai` provider and still
use WebSocket. Remote hosts keep their own provider settings.

## Browser recovery

- Each page has a random bridge ID, scoped server-side to its authenticated
  login session. Reload creates a new ID.
- Server MessagePorts survive up to 120 seconds offline. Server-to-client
  events carry increasing sequence numbers. At most 8 MiB is retained per page.
- Reconnect replays only the missed event suffix (including invoke results and
  `turn/completed`). Client commands and accepted prompts are never replayed.
- Once the bridge is restored, the upstream Desktop hook marks conversations
  as needing resume and resumes the active thread. Recovery failures/timeouts
  require reload; no fake `completed` state is synthesized.
- Backend restart, expired sessions, or a gap beyond the replay buffer require
  reload. Expired authentication offers sign-in instead of endless retries.
- Focus/visibility resume probes the socket with a fresh heartbeat deadline.

## Image-heavy context

Before a user turn starts, an authenticated, read-only endpoint estimates inline
image bytes in the local rollout's working history. Above 8 MiB, an idle thread
is compacted through Desktop's official `compactThread` path. The next prompt
waits for the matching compaction turn's terminal event, not the immediate RPC
acknowledgement. Failure or a 10-minute timeout does not send the prompt.

This bounds accumulated images between turns; it does **not** resize tool images
or prevent a single running turn from returning a large batch. Compaction may
summarize visual detail. Rollout/SQLite files are never edited by this guard.

## Verification

```sh
node --test tests/recovery.test.cjs
npx tsc --noEmit -p src/server/tsconfig.json
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --jsx react-jsx --lib es2022,dom --skipLibCheck src/browser/shim.ts
docker compose build
docker compose up -d --no-build
```

Also smoke-test an idle thread after reload, a socket disconnect while a turn
is running, visibility resume, and a server restart. An upstream Desktop upgrade
must pass `patch_upstream_recovery.mjs`'s exact-anchor checks before deployment.

Protocol reference: [official App Server documentation](https://learn.chatgpt.com/docs/app-server).
