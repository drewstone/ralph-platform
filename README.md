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
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2 --audit-axis-min 8.8
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
  - realtime dashboard with:
    - run summary cards
    - turn/audit tables
    - latest audit axis score grid
    - DAG visualization (`repo -> turn -> audit -> next turn`)

## Install
```bash
cd ~/code/ralph-platform
npm install
```

## Run dashboard against any repo
```bash
npm run dev:dashboard -- --target ~/code/superkabal --port 4310
```

Open:
- `http://localhost:4310`

## Run loop CLI
```bash
# from this repo
./packages/loop-cli/bin/ralph-loop.sh --help
./packages/loop-cli/bin/ralph-dispatch.sh --help

# after npm linking/installing as bin
ralph-loop --help
ralph-dispatch --help
```

## Dispatch to another repo and open PR when done
`ralph-dispatch` creates a branch, runs `ralph-loop` in the target repo, and only commits/pushes/opens a PR if the loop exits successfully.

```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/other-project \
  --task "Prod bug: GitHub connection is failing in workspace flow." \
  --preflight \
  --bootstrap-audit \
  --inject ~/code/superkabal/specs/inject/quality-bar.md \
  --inject-text "Prioritize root-cause, regression tests, and rollback safety." \
  --open-pr \
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2 --audit-axis-min 8.8
```

You can also dispatch from an existing spec:
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/other-project \
  --spec ~/code/superkabal/specs/apps/faith-christian-scripture.md \
  --branch ralph/faith-christian-scripture \
  --open-pr
```

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
- `--audit-critical-axis-min`

Completion is accepted only when:
1. stop token is present
2. `TEST_STATUS: PASS`
3. `UNTESTED_SCOPE: NONE`
4. audit score threshold passes
5. all axis thresholds pass

## Notes
- Dangerous mode remains hardcoded in loop execution (`--dangerously-bypass-approvals-and-sandbox`) by design.
- No per-turn timeout is enforced by design.
