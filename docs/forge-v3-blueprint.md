# Ralph Forge V3 Blueprint

## Goal
Build a production-grade Forge app for Ralph loops that feels as simple as Codex-grade UX, while supporting enterprise-scale reliability, governance, and economics visibility.

## Product Principles
1. Works-by-default: safe branch/worktree isolation, deterministic run setup, predictable recovery.
2. Observable by default: every run has live state, token/cost telemetry, and audit provenance.
3. Agentic but governed: high autonomy with explicit policy controls, approvals, and rollback paths.
4. Fast operator loop: create run -> monitor -> intervene -> ship PR, with minimal context switching.

## V3 Scope
1. Run orchestration UI and API with multi-repo, multi-run queueing.
2. Stateful run engine with resumability and immutable event log.
3. Policy + approval layer for risky tool calls and branch protections.
4. Deep audit intelligence (trend analysis, drift alerts, quality score decomposition).
5. Cost controls: live spend meter, budget thresholds, per-repo cost attribution.
6. PROps workflow: draft/ready transitions, reviewer routing, release metadata bundling.

## System Architecture
1. `forge-web` (React/Next UI)
   - Run composer, live console, audit workspace, PR handoff.
   - Realtime via WebSocket channel keyed by run id.
2. `forge-api` (Node service)
   - AuthN/Z, run lifecycle API, policy evaluation, run query API.
   - Emits domain events and persists canonical run state.
3. `forge-worker`
   - Executes `ralph-dispatch`/`ralph-loop` jobs in isolated worktrees.
   - Streams event envelopes and artifacts to the event bus.
4. `event-store`
   - Append-only run events (Postgres + partitioned tables or Kafka + sink).
   - Replay support to rebuild read models.
5. `read-models`
   - Materialized views for UI (runs, turn table, audit trends, cost rollups).
6. `artifact-store`
   - `.ralph` snapshots, prompts, last messages, audit reports, PR metadata.

## Core Domain Model
1. Run
   - identity, repo/base/head refs, execution policy, model profile, budget policy, status.
2. Turn
   - turn number, prompt digest, test result, changed files, completion marker.
3. Audit
   - verdict, global score, axis scores, threshold gaps, remediation links.
4. Usage
   - input/output/cache token metrics per turn and per audit turn.
5. Cost Ledger
   - pricing snapshot used, estimated/actual cost, attribution dimensions (repo/branch/model/run).
6. Action
   - operator interventions (pause/resume/retry/abort), approvals, comments.

## Run Lifecycle State Machine
1. `draft` -> `queued` -> `running`
2. `running` -> `needs_approval` (policy gate)
3. `running` -> `failed` | `completed`
4. `failed` -> `retrying` (fork from checkpoint)
5. `completed` -> `pr_opened` -> `merged` (external event)

## Cost + Token Design
1. Ingestion
   - Parse structured usage events from turn and audit stdout.
   - Persist per-turn usage + rollups.
2. Pricing
   - Versioned pricing table by provider/model/effective date.
   - Run-level override supported for experiments.
3. Live Meter
   - UI shows current run burn rate and projected completion cost.
4. Post-Run Reports
   - Cost by phase (main vs audit), by turn, by model.
5. Policy Hooks
   - Budget cutoff and soft/hard caps with escalation.

## UX Surfaces
1. Run Composer
   - repo selector, base branch, worktree mode default on, task/spec input, model/profile, thresholds.
2. Active Run Console
   - streaming timeline, turn/audit tabs, cost + token header, controls (pause/retry/abort).
3. Audit Workspace
   - issue list with severity/axis mappings and fix recommendations.
4. Review & Ship
   - unified diff + test evidence + audit delta + PR controls.
5. Run History
   - searchable runs with cost, score trend, and success rate.

## Reliability + Security
1. Sandboxed workers with least-privilege credentials.
2. Signed artifact manifests for traceability.
3. Idempotent command envelope execution with retry backoff.
4. Dead-letter queue for failed event processing.
5. Audit trail for approvals and policy decisions.

## Team Plan (10 Engineers)
1. Pod A: Runtime & Worker (3)
   - run state machine, worktree execution, resumability, checkpoints.
2. Pod B: Data & Economics (2)
   - event model, usage/cost ledger, trend analytics.
3. Pod C: Web Product (3)
   - composer, live run UI, history/reporting, PR handoff UX.
4. Pod D: Platform & Governance (2)
   - auth, policy engine, GitHub integration, observability/SLO.

## Milestones
1. M1 (2 weeks): Foundation
   - stable API contracts, event schema, worker skeleton, live run UI shell.
2. M2 (2 weeks): Reliable Runs
   - full lifecycle state machine, retry/resume, robust artifact ingestion.
3. M3 (2 weeks): Economics + Audit Intelligence
   - token/cost ledger, budget policies, score-trend insights.
4. M4 (2 weeks): PROps + Hardening
   - PR workflow integration, governance controls, operational SLO validation.
5. M5 (2 weeks): V3 polish
   - performance tuning, UX polish, docs, rollout playbook.

## Immediate Execution Backlog (Next 7 Days)
1. Promote current dashboard into API + worker split (minimal scaffold).
2. Persist usage/cost metrics in run cards and snapshots (in progress in current codebase).
3. Add run-creation endpoint wrapping `ralph-dispatch --worktree`.
4. Add run action endpoints: pause, abort, retry-from-turn.
5. Add UI run composer and run detail route with live token/cost header.
6. Add integration tests for dispatch lifecycle and cost aggregation correctness.
