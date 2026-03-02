# @ralph/dashboard

Ralph Forge dashboard package (chat-first orchestration UI + API server).

## Scripts

```bash
npm run -w @ralph/dashboard dev
npm run -w @ralph/dashboard dev:ui
npm run -w @ralph/dashboard dev:server
npm run -w @ralph/dashboard build
npm run -w @ralph/dashboard start
npm run -w @ralph/dashboard lint
```

## Runtime Flags

`src/server.ts` supports:

- `--target <repo-path>`
- `--port <port>`
- `--poll-ms <ms>`
- `--db <sqlite-path>`
- `--dispatch-bin <path-to-ralph-dispatch.sh>`
- `--forge-runs-dir <path>`
- `--github-client-id <id>`
- `--github-client-secret <secret>`
- `--github-callback-url <url>`
- `--github-auth-file <path>`
- cost flags:
  - `--main-input-cost-per-1m`
  - `--main-output-cost-per-1m`
  - `--audit-input-cost-per-1m`
  - `--audit-output-cost-per-1m`

## API Surface

- Health/state:
  - `GET /health`
  - `GET /api/state`
  - `GET /api/repos`
  - `GET /api/runs`
  - `GET /api/runs/:runId/snapshots`
- Forge runs:
  - `GET /api/forge/runs`
  - `GET /api/forge/runs/:runId`
  - `POST /api/forge/runs`
  - `POST /api/forge/runs/:runId/pause`
  - `POST /api/forge/runs/:runId/resume`
  - `POST /api/forge/runs/:runId/abort`
  - `POST /api/forge/runs/:runId/retry`
  - `DELETE /api/forge/runs/:runId`
- Workspace:
  - `GET /api/workspace`
  - `GET /api/workspace/diff`
  - `POST /api/workspace/open`
  - `GET /api/workspace/suggest`
  - `POST /api/workspace/pick`
  - `POST /api/workspace/clone`
- GitHub OAuth:
  - `GET /api/auth/github`
  - `GET /api/auth/github/start`
  - `GET /api/auth/github/callback`
  - `POST /api/auth/github/logout`
