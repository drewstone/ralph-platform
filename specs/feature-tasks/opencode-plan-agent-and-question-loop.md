# Feature Task Spec: OpenCode Plan-Agent Selection + Bidirectional Question Answering

## Purpose
Close the highest-value integration gaps between `agent-dev-container` (ADC) and `blueprint-agent` so we can reliably use OpenCode for production chat workflows that require:
1. selecting OpenCode agents (for plan/build-style behavior), and
2. pausing for interactive questions, submitting answers, and continuing.

This spec is intentionally concrete and split into two implementation PRs (one per repo) to keep scope deterministic.

## Repos and Execution Order
1. PR-A in `~/webb/agent-dev-container` (contract/runtime fixes)
2. PR-B in `~/webb/blueprint-agent` (consumer wiring)

Run Ralph separately in each repo, using this same spec and applying only the section for that repo.

## Verified Current State (do not re-debate in implementation)
1. ADC sidecar already exposes `POST /agents/sessions/{id}/answers` and forwards to backend `submitQuestionAnswer(...)`.
2. ADC OpenCode adapter emits `question` events and has `submitQuestionAnswer(...)`.
3. ADC OpenCode adapter currently sends prompt requests with hardcoded `tools: DEFAULT_TOOLS` each turn.
4. ADC message route currently uses `body.agent` as sidecar internal identifier (`default`/`batch`) rather than OpenCode prompt-agent selection.
5. Blueprint has interactive question UI (`QuestionToolPreview`) but no submit callback is wired in `ExpandedToolDetail`.
6. Blueprint route/proxy architecture is sidecar-first (`/api/sidecar/:containerId/...`), not orchestrator `/agents/*` first.

## PR-A (agent-dev-container): Required Changes

### A1) Separate sidecar internal identifier from OpenCode prompt-agent
Goal: allow selecting OpenCode `agent` (e.g., `plan`) without breaking internal sidecar agent registry behavior.

Required behavior:
1. Keep sidecar internal agent identifier behavior (`default`, `batch`) for backward compatibility.
2. Add explicit OpenCode prompt-agent field that is forwarded to OpenCode prompt body.
3. If legacy clients send `agent: "default"` or `agent: "batch"` with no explicit identifier, preserve old behavior.

Mandatory touchpoints:
1. `apps/sidecar/src/schemas/agent-api.ts`
2. `apps/sidecar/src/routes/agents-sessions.ts`
3. `apps/sidecar/src/agents/types.ts`
4. `apps/sidecar/src/agents/base-agent.ts`
5. `apps/sidecar/src/backends/interface.ts`
6. `packages/agent-interface/src/index.ts`
7. `apps/sidecar/src/backends/sdk-backend.ts`
8. `packages/sdk-provider-opencode/src/adapter.ts`

Implementation contract:
1. Add optional execution-level OpenCode agent field (recommended name: `opencodeAgent`), propagate end-to-end to adapter execute input.
2. In adapter prompt body, include `agent` only when provided.
3. Preserve default behavior when no OpenCode agent is provided.

### A2) Remove per-turn tool-clobbering behavior
Goal: avoid overriding profile/session tool config every turn.

Required behavior:
1. Do not force `tools: DEFAULT_TOOLS` in prompt call body.
2. Respect server/session/profile tool configuration as source of truth.
3. If explicit per-turn tool override is needed later, it must be intentional and additive, not hardcoded.

Mandatory touchpoint:
1. `packages/sdk-provider-opencode/src/adapter.ts`

### A3) Add explicit regression tests
Required tests:
1. OpenCode prompt-agent pass-through test.
2. Backward-compat test for legacy `agent` usage (`default`/`batch`).
3. Tool-clobber regression test proving prompt body no longer hardcodes full default tool map.

Suggested locations:
1. `packages/sdk-provider-opencode/src/adapter.*.test.ts`
2. `apps/sidecar/tests/routes/agents-sessions-*.test.ts`

### A4) Feature audit artifact (short, actionable)
Add/refresh one audit doc listing OpenCode features parity status in ADC.

Required output file:
1. `docs/opencode-feature-parity-audit.md`

Required sections:
1. Implemented now
2. Partially implemented
3. Deferred with reason
4. Next 3 recommended parity tasks

Must include these rows explicitly:
1. prompt-agent selection
2. interactive question reply
3. permission reply handling
4. per-turn tool override behavior
5. variant selection support
6. noReply support

## PR-B (blueprint-agent): Required Changes

### B1) Wire question answer submission path
Goal: make current interactive `QuestionToolPreview` actually submit answers and continue run.

Mandatory touchpoints:
1. `apps/web/src/components/chat/run/ExpandedToolDetail.tsx`
2. `apps/web/src/components/chat/toolExtras/QuestionToolPreview.tsx`
3. `apps/web/src/ui-provider/devcontainer-events/types.ts`
4. `apps/web/src/ui-provider/DevContainerEventsProvider.tsx`
5. `apps/web/src/routes/` (new answer submission route)
6. `apps/web/src/lib/.server/orchestrator/client.ts` (reuse `fetchSidecar`)

Implementation contract:
1. Add a server route (recommended: `api.chat.answer.ts`) that:
- authenticates user,
- validates ownership via `agentSessionId` lookup,
- resolves `containerId` + `sidecarSessionId`,
- posts to `POST /agents/sessions/{sidecarSessionId}/answers` via `fetchSidecar`.
2. Add provider method (e.g., `submitQuestionAnswers`) exposed from `useDevContainerEvents`.
3. In `ExpandedToolDetail`, pass `onSubmitAnswers` into `QuestionToolPreview` for question tools.
4. While submitting, disable duplicate submission and show pending UI state.

Answer payload normalization rule:
1. UI produces `string[][]`.
2. Convert to `Record<string, string[]>` before sidecar call.
3. Key precedence per question: `header` -> `question` -> `q_<index>`.

### B2) Keep sidecar-first architecture
Non-goal for this PR:
1. Do not add new orchestrator `/agents/*` APIs just to support answers.
2. Do not bypass ownership checks.

### B3) Add tests for new wiring
Required tests:
1. Route unit test for answer submission happy path + unauthorized/ownership mismatch.
2. Component/unit test that question submit callback is invoked with normalized payload.

Suggested locations:
1. `apps/web/tests/unit/routes/api.chat.answer.test.ts`
2. `apps/web/tests/unit/components/chat/run/ExpandedToolDetail.question.test.tsx`

## Acceptance Criteria

### ADC acceptance
1. Sending message with explicit OpenCode agent selection results in adapter prompt body containing `agent: <value>`.
2. Legacy `agent: "default"|"batch"` behavior still works.
3. Adapter prompt requests no longer hardcode `tools: DEFAULT_TOOLS`.
4. All newly added tests pass.
5. `docs/opencode-feature-parity-audit.md` exists and is accurate.

### Blueprint acceptance
1. Question UI submit button performs authenticated backend submission and receives success/failure state.
2. Submitted answers reach ADC endpoint `POST /agents/sessions/{id}/answers`.
3. Duplicate submit is prevented while request is in flight.
4. All newly added tests pass.

## Out of Scope
1. Full permission UX redesign in Blueprint.
2. Multi-agent class architecture in sidecar (`default`/`batch` remains).
3. Broad orchestrator API refactor.

## Validation Commands

### In `~/webb/agent-dev-container`
1. `pnpm --filter @tangle-network/sdk-provider-opencode test`
2. `pnpm --filter @tangle-network/sidecar test -- tests/routes`
3. `pnpm --filter @tangle-network/sidecar test -- tests/unit`

### In `~/webb/blueprint-agent`
1. `pnpm --filter web test:unit`

## Notes for Ralph
1. Prefer surgical refactor over broad rewrites.
2. Preserve existing APIs unless explicitly replaced with backward compatibility.
3. Keep telemetry/logging additions minimal and structured.
4. If any required contract is unclear, infer from this priority order:
- explicit acceptance criteria,
- mandatory touchpoints,
- verified current state.
