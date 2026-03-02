# ralph-platform

Standalone orchestration platform for Ralph loops.

## Quickstart
Incident bugfix (generate spec from incident report, then open PR on success):
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/your-repo \
  --task "Prod bug: GitHub connections fail in workspace flow. Reporter: Donovan. Evidence: x,y,z." \
  --preflight \
  --bootstrap-audit \
  --inject-text "Prioritize root-cause, regression tests, and rollback safety." \
  --open-pr \
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2 --audit-axis-min 8.8 --audit-style-axis-min 8.0
```

Feature work (no bootstrap, direct task execution):
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/your-repo \
  --task "Implement workspace GitHub reconnect UX with integration tests." \
  --open-pr \
  -- --max-turns 60 --audit-every 3 --audit-min-score 9.0
```

Spec-driven run:
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/your-repo \
  --spec ~/code/superkabal/specs/apps/faith-christian-scripture.md \
  --open-pr \
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2
```

## What this repo contains
- `packages/loop-cli`
  - portable `ralph-loop` CLI (copied from `superkabal`, including multi-axis audit thresholds).
- `packages/schema`
  - shared event/state types for run, turn, audit, DAG, and repo metadata.
- `packages/event-ingestor`
  - parser/scanner for `.ralph` artifacts (`turn-*.last.txt`, `turn-*.stdout.log`, `turn-*.audit.last.txt`).
- `apps/dashboard`
  - Ralph Forge dashboard (chat-first orchestration UI) with:
    - workspace-aware run chat timeline
    - queue/send run composer with smart defaults
    - run actions (pause/resume/abort/retry/delete/archive)
    - workspace tooling (changed files, diff, open-in target, clone/pick/suggest)
    - optional GitHub OAuth connect/logout for PR-linked workflows
    - responsive layout (workspace side panel on ultra-wide screens)

## Install
```bash
cd ~/code/ralph-platform
npm install
```

## Run dashboard against any repo
```bash
npm run dev:dashboard -- --target ~/code/superkabal --port 4310
```

The dashboard product surface is called **Ralph Forge**.
V3 architecture and execution blueprint:
- `docs/forge-v3-blueprint.md`

Frontend-only dev loop (faster UI iteration):
```bash
npm run -w @ralph/dashboard dev:ui
```

Full dashboard package scripts:
- `npm run -w @ralph/dashboard dev`
- `npm run -w @ralph/dashboard start`
- `npm run -w @ralph/dashboard lint`

Optional token pricing flags (for live/post-run cost estimates):
```bash
npm run dev:dashboard -- --target ~/code/superkabal --port 4310 \
  --main-input-cost-per-1m 3.00 \
  --main-output-cost-per-1m 15.00 \
  --audit-input-cost-per-1m 3.00 \
  --audit-output-cost-per-1m 15.00
```

Open:
- `http://localhost:4310`

Forge orchestration APIs (used by the Run Launcher UI):
- `POST /api/forge/runs`
- `GET /api/forge/runs`
- `GET /api/forge/runs/:runId`
- `POST /api/forge/runs/:runId/pause`
- `POST /api/forge/runs/:runId/resume`
- `POST /api/forge/runs/:runId/abort`
- `POST /api/forge/runs/:runId/retry`
- `DELETE /api/forge/runs/:runId`

Workspace/GitHub APIs:
- `GET /api/workspace`
- `GET /api/workspace/diff`
- `POST /api/workspace/open`
- `GET /api/workspace/suggest`
- `POST /api/workspace/pick` (macOS folder picker)
- `POST /api/workspace/clone`
- `GET /api/auth/github`
- `GET /api/auth/github/start`
- `GET /api/auth/github/callback`
- `POST /api/auth/github/logout`

## Run loop CLI
```bash
# from this repo
./packages/loop-cli/bin/ralph-loop.sh --help
./packages/loop-cli/bin/ralph-dispatch.sh --help
./packages/loop-cli/bin/ralph --help

# after npm linking/installing as bin
ralph --help
ralph-loop --help
ralph-dispatch --help
```

`ralph-loop` supports repeatable `--inject` and repeatable `--inject-text` for direct runs.

## Install CLI (GitHub release)
```bash
curl -fsSL https://raw.githubusercontent.com/drewstone/ralph-platform/main/scripts/install.sh | bash
```

Then use:
```bash
ralph --help
ralph loop --help
ralph dispatch --help
```

Release tags:
- push tag format `loop-cli-vX.Y.Z` to publish release assets.
- installer defaults to `releases/latest`; pin with:
  - `curl -fsSL https://raw.githubusercontent.com/drewstone/ralph-platform/main/scripts/install.sh | bash -s -- --version X.Y.Z`

## Dispatch to another repo and open PR when done
`ralph-dispatch` creates a branch, runs `ralph-loop` in the target repo, and only commits/pushes/opens a PR if the loop exits successfully.

```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/other-project \
  --worktree \
  --task "Prod bug: GitHub connection is failing in workspace flow." \
  --preflight \
  --bootstrap-audit \
  --inject ~/code/superkabal/specs/inject/quality-bar.md \
  --inject-text "Prioritize root-cause, regression tests, and rollback safety." \
  --open-pr \
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2 --audit-axis-min 8.8 --audit-style-axis-min 8.0
```

You can also dispatch from an existing spec:
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/other-project \
  --worktree \
  --spec ~/code/superkabal/specs/apps/faith-christian-scripture.md \
  --branch ralph/faith-christian-scripture \
  --open-pr
```

Worktree mode:
- `--worktree` runs Ralph in an isolated git worktree and avoids switching your primary checkout branch.
- By default the dispatch worktree is removed after a successful run.
- Use `--worktree-keep` to keep it for inspection.

Injection layering order:
1. `~/.ralph/inject/default.md` (or `$RALPH_GLOBAL_INJECT`)
2. `<repo>/.ralph/inject/default.md`
3. `--inject` files
4. `--inject-text` blocks

## Multi-axis audit enforcement
The loop now expects and enforces machine-readable axis scores in audit output:
- `code_quality`
- `succinct_implementation`
- `correctness_logic`
- `performance_optimizations`
- `modularity_abstractions`
- `test_rigor_evidence`
- `security_tenant_isolation`
- `reliability_failure_semantics`
- `spec_product_fidelity`
- `operational_readiness`

Threshold controls:
- `--audit-min-score`
- `--audit-axis-min`
- `--audit-style-axis-min`
- `--audit-critical-axis-min`

Completion is accepted only when:
1. stop token is present
2. `TEST_STATUS: PASS`
3. `UNTESTED_SCOPE: NONE`
4. audit score threshold passes
5. all axis thresholds pass

The loop prompt also explicitly permits high-confidence greenfield refactors in touched subsystems when they improve architecture quality, with a hard requirement to preserve behavior (unless spec-directed) and prove parity via tests.

## Notes
- Dangerous mode remains hardcoded in loop execution (`--dangerously-bypass-approvals-and-sandbox`) by design.
- No per-turn timeout is enforced by design.
