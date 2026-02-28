#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  ralph-loop.sh --spec SPEC_FILE [options]

Required:
  --spec FILE              Spec file to implement.

Options:
  --inject FILE            Extra instructions file to inject every turn (repeatable).
  --inject-text TEXT       Inline instructions to inject every turn (repeatable).
  --workdir DIR            Project directory (default: current directory).
  --max-turns N            Max loop iterations (default: 100).
  --pretty                 Render JSON event stream into labeled human-readable output.
  --stop-token TOKEN       Completion token (default: [[DONE]]).
  --model MODEL            Codex model override.
  --profile PROFILE        Codex profile from config.toml.
  --audit-every N          Run skeptical security/code audit every N turns (0 disables, default: 0).
  --audit-system-prompt FILE
                           Optional file to override the audit system prompt.
  --audit-model MODEL      Codex model override for audit runs.
  --audit-profile PROFILE  Codex profile override for audit runs.
  --audit-min-score N.N    Minimum audit score required for completion (default: 9.0).
  --audit-axis-min N.N     Minimum score required for every audit axis (default: 8.5).
  --audit-style-axis-min N.N
                           Minimum score for style-oriented audit axes (default: 8.0).
  --audit-critical-axis-min N.N
                           Minimum score for critical audit axes (default: same as --audit-min-score).
  --audit-codex-arg ARG    Extra argument for audit `codex exec` (repeatable).
  --movie                  Run the loop in a tmux "movie mode" dashboard.
  --movie-session NAME     tmux session name for movie mode (default: ralph-movie).
  --movie-no-attach        Create tmux session but do not attach.
  --movie-keep-open        Keep tmux movie session open after successful completion.
  --codex-bin BIN          Codex binary (default: codex).
  --codex-arg ARG          Extra argument to pass to `codex exec` (repeatable).
  -h, --help               Show this help.

Behavior:
  - Each iteration runs a brand new ephemeral Codex execution.
  - Uses dangerous mode: --dangerously-bypass-approvals-and-sandbox.
  - Creates/maintains minimal docs: SCRATCHPAD.md, MEMORY.md, PROJECT.md, ARCHITECTURE.md.
  - Optionally runs a periodic skeptical security audit that updates AUDIT.md.
  - Audit emits multi-axis machine-readable scores and enforces axis thresholds.
  - Movie mode shows live loop/audit activity in tmux panes.
  - Stops when the stop token is found in the last message/output.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || die "File not found: $path"
}

resolve_path() {
  local input_path="$1"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$input_path"
    return
  fi

  if [[ "$input_path" = /* ]]; then
    printf "%s\n" "$input_path"
  else
    printf "%s/%s\n" "$PWD" "$input_path"
  fi
}

resolve_input_file() {
  local input_path="$1"
  if [[ "$input_path" = /* ]]; then
    resolve_path "$input_path"
    return
  fi
  if [[ -f "$WORKDIR/$input_path" ]]; then
    resolve_path "$WORKDIR/$input_path"
    return
  fi
  resolve_path "$CALLER_DIR/$input_path"
}

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

ensure_doc() {
  local path="$1"
  local header="$2"
  if [[ ! -f "$path" ]]; then
    cat >"$path" <<EOF
# $header

Last updated: $(timestamp_utc)

EOF
  fi
}

ensure_docs() {
  ensure_doc "$WORKDIR/SCRATCHPAD.md" "SCRATCHPAD"
  ensure_doc "$WORKDIR/MEMORY.md" "MEMORY"
  ensure_doc "$WORKDIR/PROJECT.md" "PROJECT"
  ensure_doc "$WORKDIR/ARCHITECTURE.md" "ARCHITECTURE"
}

ensure_audit_doc() {
  ensure_doc "$WORKDIR/AUDIT.md" "AUDIT"
}

build_prompt() {
  local prompt_file="$1"

  cat >"$prompt_file" <<EOF
You are Ralph, an autonomous implementation agent in a loop.

Working directory: $WORKDIR

Core requirements:
1) Implement the spec in full.
2) Keep code succinct, maintainable, and performant.
3) Run rigorous tests every turn. Prefer real integration tests over mocks whenever practical.
4) Keep documentation minimal but always up to date:
   - SCRATCHPAD.md
   - MEMORY.md
   - PROJECT.md
   - ARCHITECTURE.md
   - Add another doc only if strictly necessary.
5) Fresh-context rule: assume no memory from earlier turns except repository files.
6) Refactor mandate: if you are highly confident a touched subsystem should be redesigned, prefer the cleaner greenfield architecture over incremental patching when it materially improves correctness, clarity, or maintainability.
7) Refactor safety rule: for any substantial refactor, preserve externally observable behavior unless the spec requires change, and prove parity with tests and concrete migration notes.

Process for this turn:
1) Read SPEC file first: $SPEC_FILE
2) Read docs listed above and align them to current reality.
3) Implement the highest-impact remaining work from the spec.
4) Run tests (integration-first when practical) and fix failures.
5) Update docs to reflect what changed, what remains, and test evidence.
6) Continue implementation until all relevant tests pass and there is no untested critical path.

Completion gate:
- Never stop early.
- Never print the stop token if any relevant test is failing, skipped without justification, flaky, or not executed.
- Never print the stop token if any implemented behavior lacks test coverage or verification evidence.
- Only declare completion when the spec is fully implemented, all relevant tests pass, and untested scope is NONE.
- When complete, print the exact token below on its own line:
$STOP_TOKEN

Response format:
- Brief summary of what was changed.
- Exact test commands executed and pass/fail outcomes.
- TEST_STATUS: PASS or TEST_STATUS: FAIL
- UNTESTED_SCOPE: NONE or UNTESTED_SCOPE: <precise remaining gaps>
- If not complete: list the next concrete task.
EOF

  local inject_file inject_text
  local inject_text_index=1
  if [[ ${#INJECT_FILES[@]} -gt 0 ]]; then
    for inject_file in "${INJECT_FILES[@]}"; do
      {
        echo
        echo "Injected instructions from file ($inject_file):"
        cat "$inject_file"
      } >>"$prompt_file"
    done
  fi
  if [[ ${#INJECT_TEXTS[@]} -gt 0 ]]; then
    for inject_text in "${INJECT_TEXTS[@]}"; do
      {
        echo
        echo "Injected inline instructions ($inject_text_index):"
        printf '%s\n' "$inject_text"
      } >>"$prompt_file"
      inject_text_index=$((inject_text_index + 1))
    done
  fi

  if [[ "$AUDIT_BLOCKERS_ACTIVE" == "true" ]] && [[ -n "$LAST_AUDIT_SCORE" ]] && [[ -f "$LAST_AUDIT_FEEDBACK_FILE" ]]; then
    cat >>"$prompt_file" <<EOF

Previous turn audit did not meet threshold and must be addressed before claiming completion:
- Last audit turn: $LAST_AUDIT_SCORE_TURN
- Last audit score: $LAST_AUDIT_SCORE
- Required threshold: $AUDIT_MIN_SCORE
- Audit feedback source: $LAST_AUDIT_FEEDBACK_FILE

Mandatory audit remediation for this turn:
1) Fix or explicitly refute each audit blocker with evidence.
2) Add/adjust tests to cover the raised gaps.
3) In your final response include:
   - AUDIT_RESPONSE:
   - One line per blocker: "<blocker> -> <fix|reason not applicable> -> <evidence command/file>"

Audit handoff summary:
$(cat "$LAST_AUDIT_FEEDBACK_FILE")
EOF
  fi
}

build_audit_prompt() {
  local main_prompt_file="$1"
  local main_stdout_file="$2"
  local main_last_file="$3"
  local audit_prompt_file="$4"
  local audit_system_prompt=""

  if [[ -n "$AUDIT_SYSTEM_PROMPT_FILE" ]]; then
    audit_system_prompt="$(cat "$AUDIT_SYSTEM_PROMPT_FILE")"
  else
    audit_system_prompt="$(cat <<'EOF'
You are the Security and Reliability Audit Boss for this codebase.
You are maximally skeptical and assume the implementation is wrong until verified.
No fluff. No motivational language. No deference.
Your job is to break assumptions, find vulnerabilities, and expose hidden defects.
You prioritize concrete evidence, reproducible commands, and precise file/line references.
EOF
)"
  fi

  cat >"$audit_prompt_file" <<EOF
SYSTEM PROMPT (HIGHEST PRIORITY):
$audit_system_prompt

You are running as an independent, adversarial audit pass for Ralph loop.

Main flow artifacts for correlation:
- Main turn prompt: $main_prompt_file
- Main turn stdout: $main_stdout_file
- Main turn last response: $main_last_file
- Spec file: $SPEC_FILE
- Required docs: $WORKDIR/SCRATCHPAD.md, $WORKDIR/MEMORY.md, $WORKDIR/PROJECT.md, $WORKDIR/ARCHITECTURE.md
- Audit output target: $WORKDIR/AUDIT.md

Audit requirements:
1) Treat the main flow's claims as untrusted until proven.
2) Examine security vulnerabilities, correctness bugs, race/concurrency hazards, data integrity risks, perf regressions, and test quality gaps.
3) Re-run or run independent verification commands when needed.
4) Cross-reference findings to the main turn artifacts above.
5) Update AUDIT.md directly by appending a new section with a UTC timestamp.
6) The report must be in-depth and technical with:
   - Findings by severity: Critical, High, Medium, Low
   - For each finding: impact, evidence, reproduction or verification command, concrete remediation
   - Distilled Top Issues section with at most 20 items, ordered by severity and exploitability.
   - For each distilled top issue include: short title, why score is reduced, proof reference, and specific fix path.
   - Main Flow Correlation section linking findings to specific claims in the main flow output
   - Unverified Claims section listing claims that were not demonstrated
   - Final verdict: PASS / FAIL for this turn
   - Score threshold for completion is: $AUDIT_MIN_SCORE
   - Axis thresholds:
     - global axis floor: $AUDIT_AXIS_MIN
     - style axis floor: $AUDIT_STYLE_AXIS_MIN
     - critical axis floor: $AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE
   - Required axis scores (all must be present):
     - code_quality
     - succinct_implementation
     - correctness_logic
     - performance_optimizations
     - modularity_abstractions
     - test_rigor_evidence
     - security_tenant_isolation
     - reliability_failure_semantics
     - spec_product_fidelity
     - operational_readiness
   - Explicitly justify why the score is what it is (what reduced it, what would raise it).
   - Scoring discipline: prioritize security, correctness, reliability, evidence quality, and operational readiness over stylistic preferences.
   - Style-only concerns (naming/aesthetics/subjective structure without concrete risk or measurable cost) must be marked Low severity and must not drive FAIL unless they create real maintainability/perf/correctness impact.
   - If score is below threshold, include a targeted "Threshold Gap" section:
     - minimum changes required to pass threshold next turn
     - blocked-by dependencies (if any)
   - Numeric weighted audit score from 0.0 to 10.0 in this exact form on a single line:
     AUDIT_SCORE: <<<9.5>>>
7) If no confirmed findings exist, explicitly state that and include residual risks and missing evidence.

Output rules:
- Write the full report into AUDIT.md.
- In stdout, print a comprehensive machine-readable handoff block in exactly this structure:
  AUDIT_VERDICT: PASS|FAIL
  AUDIT_SCORE: <<<N.N>>>
  AUDIT_CONFIDENCE: <<<N.N>>>
  AUDIT_AXIS_SCORES:
  code_quality=<<<N.N>>>
  succinct_implementation=<<<N.N>>>
  correctness_logic=<<<N.N>>>
  performance_optimizations=<<<N.N>>>
  modularity_abstractions=<<<N.N>>>
  test_rigor_evidence=<<<N.N>>>
  security_tenant_isolation=<<<N.N>>>
  reliability_failure_semantics=<<<N.N>>>
  spec_product_fidelity=<<<N.N>>>
  operational_readiness=<<<N.N>>>
  AUDIT_SCORE_REASONING:
  - <reason 1>
  - <reason 2>
  AUDIT_TOP_ISSUES (max 20):
  1. [<severity>] <issue title> | Why score reduced: <short reason> | Evidence: <file:line or command> | Fix: <specific remediation>
  2. [<severity>] ...
  AUDIT_THRESHOLD_GAP:
  - <must-do change to pass threshold>
  - <must-do change to pass threshold>
  AUDIT_ACTIONS (next turn plan):
  1. <highest-priority action>
  2. <next action>
  3. <next action>
- Do not collapse this to one sentence; provide enough detail for direct implementation planning.
EOF
}

can_accept_stop_token() {
  local last_file="$1"
  local stdout_file="$2"

  if ! grep -Fq "$STOP_TOKEN" "$last_file" && ! grep -Fq "$STOP_TOKEN" "$stdout_file"; then
    return 1
  fi

  if grep -Eiq '^TEST_STATUS:[[:space:]]*PASS[[:space:]]*$' "$last_file" &&
     grep -Eiq '^UNTESTED_SCOPE:[[:space:]]*NONE[[:space:]]*$' "$last_file"; then
    return 0
  fi

  return 2
}

extract_audit_score() {
  local audit_file="$1"
  if [[ ! -f "$audit_file" ]]; then
    return 1
  fi
  local score_line
  score_line="$(grep -E '^AUDIT_SCORE:[[:space:]]*<<<[0-9]+([.][0-9]+)?>>>$' "$audit_file" | tail -n1 || true)"
  if [[ -n "$score_line" ]]; then
    echo "$score_line" | grep -Eo '<<<[0-9]+([.][0-9]+)?>>>' | tr -d '<>' || true
    return 0
  fi

  # Backward-compatible fallback for older audit prompts that only emitted a single score token.
  grep -Eo '<<<[0-9]+([.][0-9]+)?>>>' "$audit_file" | tail -n1 | tr -d '<>' || true
}

extract_named_score() {
  local report_file="$1"
  local key="$2"
  if [[ ! -f "$report_file" ]]; then
    return 1
  fi
  grep -E "^[[:space:]]*${key}=<<<[0-9]+([.][0-9]+)?>>>[[:space:]]*$" "$report_file" | tail -n1 | sed -E 's/^[^<]*<<<([0-9]+([.][0-9]+)?)>>>.*$/\1/' || true
}

score_meets_threshold() {
  local score="$1"
  local threshold="$2"
  [[ -n "$score" ]] || return 1
  awk -v s="$score" -v t="$threshold" 'BEGIN { exit !(s+0 >= t+0) }'
}

axis_is_critical() {
  local axis="$1"
  local critical
  for critical in "${AUDIT_CRITICAL_AXES[@]}"; do
    if [[ "$critical" == "$axis" ]]; then
      return 0
    fi
  done
  return 1
}

axis_is_style() {
  local axis="$1"
  local style
  for style in "${AUDIT_STYLE_AXES[@]}"; do
    if [[ "$style" == "$axis" ]]; then
      return 0
    fi
  done
  return 1
}

evaluate_audit_axis_thresholds() {
  local audit_file="$1"
  local axis score threshold
  local issues=()
  local has_failures=0

  for axis in "${AUDIT_AXES[@]}"; do
    score="$(extract_named_score "$audit_file" "$axis")"
    if [[ -z "$score" ]]; then
      issues+=("missing:$axis")
      has_failures=1
      continue
    fi

    threshold="$AUDIT_AXIS_MIN"
    if axis_is_critical "$axis"; then
      threshold="$AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE"
    elif axis_is_style "$axis"; then
      threshold="$AUDIT_STYLE_AXIS_MIN"
    fi

    if ! score_meets_threshold "$score" "$threshold"; then
      issues+=("$axis:$score<$threshold")
      has_failures=1
    fi
  done

  if (( has_failures == 0 )); then
    LAST_AUDIT_AXES_PASS="true"
    LAST_AUDIT_AXES_ISSUES=""
    return 0
  fi

  LAST_AUDIT_AXES_PASS="false"
  LAST_AUDIT_AXES_ISSUES="$(IFS='; '; echo "${issues[*]}")"
  return 1
}

has_codex_json_arg() {
  local arg
  if [[ ${#EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    for arg in "${EXTRA_CODEX_ARGS[@]}"; do
      if [[ "$arg" == "--json" ]]; then
        return 0
      fi
    done
  fi
  return 1
}

has_audit_codex_json_arg() {
  local arg
  if [[ ${#EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    for arg in "${EXTRA_CODEX_ARGS[@]}"; do
      if [[ "$arg" == "--json" ]]; then
        return 0
      fi
    done
  fi
  if [[ ${#AUDIT_EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    for arg in "${AUDIT_EXTRA_CODEX_ARGS[@]}"; do
      if [[ "$arg" == "--json" ]]; then
        return 0
      fi
    done
  fi
  return 1
}

render_json_stream() {
  if ! command -v jq >/dev/null 2>&1; then
    cat
    return 0
  fi

  if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    jq -Rr '
      . as $line
      | (fromjson? // {"type":"raw","line":$line}) as $e
      | if $e.type=="thread.started" then
          "[session] thread " + ($e.thread_id // "unknown" | tostring)
        elif $e.type=="turn.started" then
          "[turn] started"
        elif $e.type=="item.started" then
          if (($e.item.type // "" | tostring) | test("tool|exec|shell|function")) then
            "[tool:start] " + ($e.item.type // "unknown" | tostring)
              + (if $e.item.name then " name=" + ($e.item.name | tostring) else "" end)
          else
            empty
          end
        elif $e.type=="item.completed" then
          if $e.item.type=="reasoning" then
            "[think] " + (($e.item.text // $e.item.summary // "") | tostring)
          elif $e.item.type=="agent_message" or $e.item.type=="message" then
            "[text] " + (($e.item.text // "") | tostring)
          elif (($e.item.type // "" | tostring) | test("tool|exec|shell|function")) then
            "[tool:done] " + ($e.item.type | tostring)
          else
            empty
          end
        elif $e.type=="turn.completed" then
          "[turn] done in=" + (($e.usage.input_tokens // 0) | tostring)
            + " out=" + (($e.usage.output_tokens // 0) | tostring)
        elif $e.type=="turn.failed" then
          "[turn] failed"
        elif $e.type=="raw" then
          "[raw] " + ($e.line | tostring)
        else
          empty
        end
    ' | awk '
      BEGIN {
        reset="\033[0m";
        c_session="\033[1;34m";
        c_turn="\033[1;36m";
        c_tool="\033[1;35m";
        c_think="\033[1;33m";
        c_text="\033[1;32m";
        c_raw="\033[2;37m";
        c_fail="\033[1;31m";
      }
      /^\[session\]/ { print c_session $0 reset; next }
      /^\[turn\] failed/ { print c_fail $0 reset; next }
      /^\[turn\]/ { print c_turn $0 reset; next }
      /^\[tool:/ { print c_tool $0 reset; next }
      /^\[think\]/ { print c_think $0 reset; next }
      /^\[text\]/ { print c_text $0 reset; next }
      /^\[raw\]/ { print c_raw $0 reset; next }
      { print }
    '
  else
    jq -Rr '
    . as $line
    | (fromjson? // {"type":"raw","line":$line}) as $e
    | if $e.type=="thread.started" then
        "[session] thread " + ($e.thread_id // "unknown" | tostring)
      elif $e.type=="turn.started" then
        "[turn] started"
      elif $e.type=="item.started" then
        if (($e.item.type // "" | tostring) | test("tool|exec|shell|function")) then
          "[tool:start] " + ($e.item.type // "unknown" | tostring)
            + (if $e.item.name then " name=" + ($e.item.name | tostring) else "" end)
        else
          empty
        end
      elif $e.type=="item.completed" then
        if $e.item.type=="reasoning" then
          "[think] " + (($e.item.text // $e.item.summary // "") | tostring)
        elif $e.item.type=="agent_message" or $e.item.type=="message" then
          "[text] " + (($e.item.text // "") | tostring)
        elif (($e.item.type // "" | tostring) | test("tool|exec|shell|function")) then
          "[tool:done] " + ($e.item.type | tostring)
        else
          empty
        end
      elif $e.type=="turn.completed" then
        "[turn] done in=" + (($e.usage.input_tokens // 0) | tostring)
          + " out=" + (($e.usage.output_tokens // 0) | tostring)
      elif $e.type=="turn.failed" then
        "[turn] failed"
      elif $e.type=="raw" then
        "[raw] " + ($e.line | tostring)
      else
        empty
      end
    '
  fi
}

start_movie_mode() {
  command -v tmux >/dev/null 2>&1 || die "tmux not found (required for --movie)"

  local script_path
  script_path="$(resolve_path "$0")"

  local movie_dir="$WORKDIR/.ralph"
  local movie_log="$movie_dir/movie.live.log"
  local movie_jq="$movie_dir/movie-render.jq"
  mkdir -p "$movie_dir"
  : >"$movie_log"

  cat >"$movie_jq" <<'EOF'
fromjson? |
if .type=="thread.started" then "=== thread " + .thread_id + " ==="
elif .type=="turn.started" then "\n=== turn started ==="
elif .type=="item.completed" and .item.type=="reasoning" then "[reasoning] " + .item.text
elif .type=="item.completed" and .item.type=="agent_message" then "\n" + .item.text + "\n"
elif .type=="turn.completed" then "[turn done] in=\(.usage.input_tokens) out=\(.usage.output_tokens)"
else empty end
EOF

  local child_args=(
    --spec "$SPEC_FILE"
    --workdir "$WORKDIR"
    --max-turns "$MAX_TURNS"
    --stop-token "$STOP_TOKEN"
    --codex-bin "$CODEX_BIN"
    --audit-every "$AUDIT_EVERY"
    --audit-min-score "$AUDIT_MIN_SCORE"
    --audit-axis-min "$AUDIT_AXIS_MIN"
    --audit-style-axis-min "$AUDIT_STYLE_AXIS_MIN"
  )
  if [[ -n "$AUDIT_CRITICAL_AXIS_MIN" ]]; then
    child_args+=(--audit-critical-axis-min "$AUDIT_CRITICAL_AXIS_MIN")
  fi
  local inject_file inject_text
  if [[ ${#INJECT_FILES[@]} -gt 0 ]]; then
    for inject_file in "${INJECT_FILES[@]}"; do
      child_args+=(--inject "$inject_file")
    done
  fi
  if [[ ${#INJECT_TEXTS[@]} -gt 0 ]]; then
    for inject_text in "${INJECT_TEXTS[@]}"; do
      child_args+=(--inject-text "$inject_text")
    done
  fi
  if [[ -n "$MODEL" ]]; then
    child_args+=(--model "$MODEL")
  fi
  if [[ -n "$PROFILE" ]]; then
    child_args+=(--profile "$PROFILE")
  fi
  if [[ -n "$AUDIT_SYSTEM_PROMPT_FILE" ]]; then
    child_args+=(--audit-system-prompt "$AUDIT_SYSTEM_PROMPT_FILE")
  fi
  if [[ -n "$AUDIT_MODEL" ]]; then
    child_args+=(--audit-model "$AUDIT_MODEL")
  fi
  if [[ -n "$AUDIT_PROFILE" ]]; then
    child_args+=(--audit-profile "$AUDIT_PROFILE")
  fi
  local extra_arg
  if [[ ${#EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    for extra_arg in "${EXTRA_CODEX_ARGS[@]}"; do
      child_args+=(--codex-arg "$extra_arg")
    done
  fi
  if [[ ${#AUDIT_EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    for extra_arg in "${AUDIT_EXTRA_CODEX_ARGS[@]}"; do
      child_args+=(--audit-codex-arg "$extra_arg")
    done
  fi

  if ! has_codex_json_arg; then
    child_args+=(--codex-arg --json)
  fi

  local child_cmd=(env RALPH_MOVIE_CHILD=1 "$script_path" "${child_args[@]}")
  local child_cmd_q
  printf -v child_cmd_q '%q ' "${child_cmd[@]}"
  child_cmd_q="${child_cmd_q% }"

  local q_workdir q_movie_log q_movie_jq q_movie_session
  printf -v q_workdir '%q' "$WORKDIR"
  printf -v q_movie_log '%q' "$movie_log"
  printf -v q_movie_jq '%q' "$movie_jq"
  printf -v q_movie_session '%q' "$MOVIE_SESSION"

  local main_cmd render_cmd audit_cmd status_cmd main_script
  main_script="cd $q_workdir && mkdir -p .ralph && : > $q_movie_log && set -o pipefail && $child_cmd_q 2>&1 | tee -a $q_movie_log; rc=\${PIPESTATUS[0]}; echo \"[movie] child exit: \${rc}\" | tee -a $q_movie_log"
  if [[ "$MOVIE_AUTO_EXIT" == "true" ]]; then
    main_script="$main_script; if [[ \${rc} -eq 0 ]]; then echo \"[movie] completion accepted; closing tmux session\" | tee -a $q_movie_log; tmux kill-session -t $q_movie_session; else echo \"[movie] child failed; session kept open for inspection\" | tee -a $q_movie_log; fi"
  fi
  printf -v main_cmd 'bash -lc %q' "$main_script"

  if command -v jq >/dev/null 2>&1; then
    render_cmd="cd $q_workdir && touch $q_movie_log && tail -n +1 -F $q_movie_log | jq -Rr -f $q_movie_jq"
  else
    render_cmd="cd $q_workdir && echo 'jq not found; showing raw stream' && touch $q_movie_log && tail -n +1 -F $q_movie_log"
  fi

  audit_cmd="cd $q_workdir && touch AUDIT.md && tail -n +1 -F AUDIT.md"
  status_cmd="cd $q_workdir && while true; do clear; echo \"Session: $MOVIE_SESSION\"; echo \"UTC: \$(date -u +%Y-%m-%dT%H:%M:%SZ)\"; echo; echo 'Recent loop events:'; rg -n 'Stop token|Audit score|axis threshold|failed|Reached max turns|Ralph turn' $q_movie_log | tail -n 25 || true; echo; echo 'Recent files in .ralph:'; ls -1 .ralph | tail -n 20 || true; sleep 2; done"

  if tmux has-session -t "$MOVIE_SESSION" 2>/dev/null; then
    die "tmux session already exists: $MOVIE_SESSION (attach with: tmux attach -t $MOVIE_SESSION)"
  fi

  tmux new-session -d -s "$MOVIE_SESSION" -n ralph "$main_cmd"
  tmux set-window-option -t "$MOVIE_SESSION":0 remain-on-exit on >/dev/null
  tmux split-window -h -t "$MOVIE_SESSION":0 "$render_cmd"
  tmux split-window -v -t "$MOVIE_SESSION":0.0 "$audit_cmd"
  tmux split-window -v -t "$MOVIE_SESSION":0.1 "$status_cmd"
  tmux select-layout -t "$MOVIE_SESSION":0 tiled >/dev/null

  echo "Movie mode session started: $MOVIE_SESSION"
  echo "Workdir: $WORKDIR"
  echo "Live log: $movie_log"
  if [[ "$MOVIE_NO_ATTACH" == "true" ]]; then
    echo "Attach with: tmux attach -t $MOVIE_SESSION"
    exit 0
  fi
  exec tmux attach -t "$MOVIE_SESSION"
}

SPEC_FILE=""
INJECT_FILES=()
INJECT_TEXTS=()
WORKDIR="$(pwd)"
MAX_TURNS=100
STOP_TOKEN="[[DONE]]"
MODEL=""
PROFILE=""
AUDIT_EVERY=0
AUDIT_SYSTEM_PROMPT_FILE=""
AUDIT_MODEL=""
AUDIT_PROFILE=""
AUDIT_MIN_SCORE="9.0"
AUDIT_AXIS_MIN="8.5"
AUDIT_STYLE_AXIS_MIN="8.0"
AUDIT_CRITICAL_AXIS_MIN=""
AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE=""
AUDIT_AXES=(
  code_quality
  succinct_implementation
  correctness_logic
  performance_optimizations
  modularity_abstractions
  test_rigor_evidence
  security_tenant_isolation
  reliability_failure_semantics
  spec_product_fidelity
  operational_readiness
)
AUDIT_CRITICAL_AXES=(
  correctness_logic
  test_rigor_evidence
  security_tenant_isolation
  reliability_failure_semantics
)
AUDIT_STYLE_AXES=(
  code_quality
  succinct_implementation
  modularity_abstractions
)
MOVIE_MODE="false"
MOVIE_SESSION="ralph-movie"
MOVIE_NO_ATTACH="false"
MOVIE_AUTO_EXIT="true"
PRETTY_STREAM="false"
CODEX_BIN="${CODEX_BIN:-codex}"
EXTRA_CODEX_ARGS=()
AUDIT_EXTRA_CODEX_ARGS=()
CALLER_DIR="$(pwd)"
LAST_AUDIT_SCORE=""
LAST_AUDIT_SCORE_TURN=0
LAST_AUDIT_FEEDBACK_FILE=""
AUDIT_BLOCKERS_ACTIVE="false"
LAST_AUDIT_AXES_PASS="false"
LAST_AUDIT_AXES_ISSUES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec)
      SPEC_FILE="${2:-}"
      shift 2
      ;;
    --inject)
      INJECT_FILES+=("${2:-}")
      shift 2
      ;;
    --inject-text)
      INJECT_TEXTS+=("${2:-}")
      shift 2
      ;;
    --workdir)
      WORKDIR="${2:-}"
      shift 2
      ;;
    --max-turns)
      MAX_TURNS="${2:-}"
      shift 2
      ;;
    --pretty)
      PRETTY_STREAM="true"
      shift
      ;;
    --stop-token)
      STOP_TOKEN="${2:-}"
      shift 2
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --audit-every)
      AUDIT_EVERY="${2:-}"
      shift 2
      ;;
    --audit-system-prompt)
      AUDIT_SYSTEM_PROMPT_FILE="${2:-}"
      shift 2
      ;;
    --audit-model)
      AUDIT_MODEL="${2:-}"
      shift 2
      ;;
    --audit-profile)
      AUDIT_PROFILE="${2:-}"
      shift 2
      ;;
    --audit-min-score)
      AUDIT_MIN_SCORE="${2:-}"
      shift 2
      ;;
    --audit-axis-min)
      AUDIT_AXIS_MIN="${2:-}"
      shift 2
      ;;
    --audit-style-axis-min)
      AUDIT_STYLE_AXIS_MIN="${2:-}"
      shift 2
      ;;
    --audit-critical-axis-min)
      AUDIT_CRITICAL_AXIS_MIN="${2:-}"
      shift 2
      ;;
    --audit-codex-arg)
      AUDIT_EXTRA_CODEX_ARGS+=("${2:-}")
      shift 2
      ;;
    --movie)
      MOVIE_MODE="true"
      shift
      ;;
    --movie-session)
      MOVIE_SESSION="${2:-}"
      shift 2
      ;;
    --movie-no-attach)
      MOVIE_NO_ATTACH="true"
      shift
      ;;
    --movie-keep-open)
      MOVIE_AUTO_EXIT="false"
      shift
      ;;
    --codex-bin)
      CODEX_BIN="${2:-}"
      shift 2
      ;;
    --codex-arg)
      EXTRA_CODEX_ARGS+=("${2:-}")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$SPEC_FILE" ]] || die "--spec is required"
[[ "$MAX_TURNS" =~ ^[0-9]+$ ]] || die "--max-turns must be a non-negative integer"
[[ "$MAX_TURNS" -gt 0 ]] || die "--max-turns must be > 0"
[[ "$AUDIT_EVERY" =~ ^[0-9]+$ ]] || die "--audit-every must be a non-negative integer"
[[ "$AUDIT_MIN_SCORE" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--audit-min-score must be numeric (e.g. 9.0)"
[[ "$AUDIT_AXIS_MIN" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--audit-axis-min must be numeric (e.g. 8.5)"
[[ "$AUDIT_STYLE_AXIS_MIN" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--audit-style-axis-min must be numeric (e.g. 8.0)"
if [[ -n "$AUDIT_CRITICAL_AXIS_MIN" ]]; then
  [[ "$AUDIT_CRITICAL_AXIS_MIN" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "--audit-critical-axis-min must be numeric (e.g. 9.2)"
fi
[[ -n "$MOVIE_SESSION" ]] || die "--movie-session must not be empty"
command -v "$CODEX_BIN" >/dev/null 2>&1 || die "Codex binary not found: $CODEX_BIN"

if [[ -n "$AUDIT_CRITICAL_AXIS_MIN" ]]; then
  AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE="$AUDIT_CRITICAL_AXIS_MIN"
else
  AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE="$AUDIT_MIN_SCORE"
fi

awk -v v="$AUDIT_MIN_SCORE" 'BEGIN { exit !(v+0 >= 0 && v+0 <= 10) }' || die "--audit-min-score must be between 0 and 10"
awk -v v="$AUDIT_AXIS_MIN" 'BEGIN { exit !(v+0 >= 0 && v+0 <= 10) }' || die "--audit-axis-min must be between 0 and 10"
awk -v v="$AUDIT_STYLE_AXIS_MIN" 'BEGIN { exit !(v+0 >= 0 && v+0 <= 10) }' || die "--audit-style-axis-min must be between 0 and 10"
awk -v v="$AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE" 'BEGIN { exit !(v+0 >= 0 && v+0 <= 10) }' || die "--audit-critical-axis-min must be between 0 and 10"

WORKDIR="$(resolve_path "$WORKDIR")"
[[ -d "$WORKDIR" ]] || die "Workdir does not exist: $WORKDIR"

SPEC_FILE="$(resolve_input_file "$SPEC_FILE")"
require_file "$SPEC_FILE"

if [[ ${#INJECT_FILES[@]} -gt 0 ]]; then
  resolved_inject_files=()
  for inject_file in "${INJECT_FILES[@]}"; do
    inject_file="$(resolve_input_file "$inject_file")"
    require_file "$inject_file"
    resolved_inject_files+=("$inject_file")
  done
  INJECT_FILES=("${resolved_inject_files[@]}")
fi

if [[ -n "$AUDIT_SYSTEM_PROMPT_FILE" ]]; then
  AUDIT_SYSTEM_PROMPT_FILE="$(resolve_input_file "$AUDIT_SYSTEM_PROMPT_FILE")"
  require_file "$AUDIT_SYSTEM_PROMPT_FILE"
fi

if [[ "$MOVIE_MODE" == "true" ]] && [[ "${RALPH_MOVIE_CHILD:-0}" != "1" ]]; then
  start_movie_mode
fi

LOG_DIR="$WORKDIR/.ralph"
mkdir -p "$LOG_DIR"

ensure_docs

echo "Ralph loop starting"
echo "workdir: $WORKDIR"
echo "spec: $SPEC_FILE"
if [[ ${#INJECT_FILES[@]} -gt 0 ]]; then
  for inject_file in "${INJECT_FILES[@]}"; do
    echo "inject: $inject_file"
  done
fi
if [[ ${#INJECT_TEXTS[@]} -gt 0 ]]; then
  echo "inject_text_blocks: ${#INJECT_TEXTS[@]}"
fi
echo "max_turns: $MAX_TURNS"
echo "stop_token: $STOP_TOKEN"
echo "audit_every: $AUDIT_EVERY"
echo "audit_min_score: $AUDIT_MIN_SCORE"
echo "audit_axis_min: $AUDIT_AXIS_MIN"
echo "audit_style_axis_min: $AUDIT_STYLE_AXIS_MIN"
echo "audit_critical_axis_min: $AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE"
echo "pretty_stream: $PRETTY_STREAM"
if [[ -n "$AUDIT_SYSTEM_PROMPT_FILE" ]]; then
  echo "audit_system_prompt: $AUDIT_SYSTEM_PROMPT_FILE"
fi
if [[ -n "$AUDIT_MODEL" ]]; then
  echo "audit_model: $AUDIT_MODEL"
fi
if [[ -n "$AUDIT_PROFILE" ]]; then
  echo "audit_profile: $AUDIT_PROFILE"
fi
echo "logs: $LOG_DIR"

for ((turn=1; turn<=MAX_TURNS; turn++)); do
  ensure_docs

  turn_tag="$(printf "%03d" "$turn")"
  prompt_file="$LOG_DIR/turn-${turn_tag}.prompt.txt"
  stdout_file="$LOG_DIR/turn-${turn_tag}.stdout.log"
  last_file="$LOG_DIR/turn-${turn_tag}.last.txt"

  build_prompt "$prompt_file"

  cmd=(
    "$CODEX_BIN" exec
    --dangerously-bypass-approvals-and-sandbox
    --skip-git-repo-check
    --ephemeral
    --cd "$WORKDIR"
    --output-last-message "$last_file"
  )

  if [[ -n "$MODEL" ]]; then
    cmd+=(--model "$MODEL")
  fi
  if [[ -n "$PROFILE" ]]; then
    cmd+=(--profile "$PROFILE")
  fi
  if [[ ${#EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    cmd+=("${EXTRA_CODEX_ARGS[@]}")
  fi
  if [[ "$PRETTY_STREAM" == "true" ]] && ! has_codex_json_arg; then
    cmd+=(--json)
  fi
  cmd+=(-)

  echo
  echo "========== Ralph turn $turn / $MAX_TURNS =========="
  if [[ "$PRETTY_STREAM" == "true" ]]; then
    if ! "${cmd[@]}" <"$prompt_file" | tee "$stdout_file" | render_json_stream; then
      echo "Turn $turn failed. See: $stdout_file" >&2
      exit 1
    fi
  else
    if ! "${cmd[@]}" <"$prompt_file" | tee "$stdout_file"; then
      echo "Turn $turn failed. See: $stdout_file" >&2
      exit 1
    fi
  fi

  if [[ ! -s "$last_file" ]]; then
    cp "$stdout_file" "$last_file"
  fi

  run_audit=false
  if (( AUDIT_EVERY > 0 )) && (( turn % AUDIT_EVERY == 0 )); then
    run_audit=true
  fi
  if can_accept_stop_token "$last_file" "$stdout_file"; then
    if (( AUDIT_EVERY > 0 )); then
      run_audit=true
    fi
  fi

  if [[ "$run_audit" == "true" ]]; then
    ensure_audit_doc

    audit_prompt_file="$LOG_DIR/turn-${turn_tag}.audit.prompt.txt"
    audit_stdout_file="$LOG_DIR/turn-${turn_tag}.audit.stdout.log"
    audit_last_file="$LOG_DIR/turn-${turn_tag}.audit.last.txt"

    build_audit_prompt "$prompt_file" "$stdout_file" "$last_file" "$audit_prompt_file"

    audit_cmd=(
      "$CODEX_BIN" exec
      --dangerously-bypass-approvals-and-sandbox
      --skip-git-repo-check
      --ephemeral
      --cd "$WORKDIR"
      --output-last-message "$audit_last_file"
    )

    if [[ -n "$AUDIT_MODEL" ]]; then
      audit_cmd+=(--model "$AUDIT_MODEL")
    elif [[ -n "$MODEL" ]]; then
      audit_cmd+=(--model "$MODEL")
    fi
    if [[ -n "$AUDIT_PROFILE" ]]; then
      audit_cmd+=(--profile "$AUDIT_PROFILE")
    elif [[ -n "$PROFILE" ]]; then
      audit_cmd+=(--profile "$PROFILE")
    fi
    if [[ ${#EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
      audit_cmd+=("${EXTRA_CODEX_ARGS[@]}")
    fi
    if [[ ${#AUDIT_EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
      audit_cmd+=("${AUDIT_EXTRA_CODEX_ARGS[@]}")
    fi
    if [[ "$PRETTY_STREAM" == "true" ]] && ! has_audit_codex_json_arg; then
      audit_cmd+=(--json)
    fi
    audit_cmd+=(-)

    echo
    echo "----- Audit turn $turn / $MAX_TURNS (every $AUDIT_EVERY) -----"
    if [[ "$PRETTY_STREAM" == "true" ]]; then
      if ! "${audit_cmd[@]}" <"$audit_prompt_file" | tee "$audit_stdout_file" | render_json_stream; then
        echo "Audit on turn $turn failed. See: $audit_stdout_file" >&2
        exit 1
      fi
    else
      if ! "${audit_cmd[@]}" <"$audit_prompt_file" | tee "$audit_stdout_file"; then
        echo "Audit on turn $turn failed. See: $audit_stdout_file" >&2
        exit 1
      fi
    fi

    if [[ ! -s "$audit_last_file" ]]; then
      cp "$audit_stdout_file" "$audit_last_file"
    fi

    LAST_AUDIT_SCORE="$(extract_audit_score "$audit_last_file")"
    LAST_AUDIT_SCORE_TURN="$turn"
    evaluate_audit_axis_thresholds "$audit_last_file" || true

    if [[ -z "$LAST_AUDIT_SCORE" ]]; then
      echo "Audit score (turn $turn): not found"
      AUDIT_BLOCKERS_ACTIVE="true"
      LAST_AUDIT_FEEDBACK_FILE="$audit_last_file"
      echo "Audit score missing. Next turn prompt will include blocker handoff from: $LAST_AUDIT_FEEDBACK_FILE"
      if [[ "$LAST_AUDIT_AXES_PASS" != "true" ]]; then
        echo "Audit axis threshold status (turn $turn): FAIL ($LAST_AUDIT_AXES_ISSUES)"
      fi
    else
      echo "Audit score (turn $turn): $LAST_AUDIT_SCORE"
      if [[ "$LAST_AUDIT_AXES_PASS" == "true" ]]; then
        echo "Audit axis threshold status (turn $turn): PASS"
      else
        echo "Audit axis threshold status (turn $turn): FAIL ($LAST_AUDIT_AXES_ISSUES)"
      fi

      if ! score_meets_threshold "$LAST_AUDIT_SCORE" "$AUDIT_MIN_SCORE"; then
        AUDIT_BLOCKERS_ACTIVE="true"
        LAST_AUDIT_FEEDBACK_FILE="$audit_last_file"
        echo "Audit below threshold. Next turn prompt will include blocker handoff from: $LAST_AUDIT_FEEDBACK_FILE"
      elif [[ "$LAST_AUDIT_AXES_PASS" != "true" ]]; then
        AUDIT_BLOCKERS_ACTIVE="true"
        LAST_AUDIT_FEEDBACK_FILE="$audit_last_file"
        echo "Audit axis thresholds not met. Next turn prompt will include blocker handoff from: $LAST_AUDIT_FEEDBACK_FILE"
      else
        AUDIT_BLOCKERS_ACTIVE="false"
        LAST_AUDIT_FEEDBACK_FILE=""
      fi
    fi
  fi

  if can_accept_stop_token "$last_file" "$stdout_file"; then
    if (( AUDIT_EVERY > 0 )); then
      if [[ "$LAST_AUDIT_SCORE_TURN" -ne "$turn" ]]; then
        echo
        echo "Stop token ignored on turn $turn: no same-turn audit score available."
        continue
      fi
      if ! score_meets_threshold "$LAST_AUDIT_SCORE" "$AUDIT_MIN_SCORE"; then
        echo
        echo "Stop token ignored on turn $turn: audit score $LAST_AUDIT_SCORE is below $AUDIT_MIN_SCORE."
        continue
      fi
      if [[ "$LAST_AUDIT_AXES_PASS" != "true" ]]; then
        echo
        echo "Stop token ignored on turn $turn: audit axis thresholds failed ($LAST_AUDIT_AXES_ISSUES)."
        continue
      fi
    fi

    echo
    echo "Stop token detected on turn $turn."
    if (( AUDIT_EVERY > 0 )); then
      echo "Audit score accepted: $LAST_AUDIT_SCORE (threshold: $AUDIT_MIN_SCORE)"
      echo "Audit axis thresholds accepted: min=$AUDIT_AXIS_MIN style_min=$AUDIT_STYLE_AXIS_MIN critical_min=$AUDIT_CRITICAL_AXIS_MIN_EFFECTIVE"
    fi
    echo "Last message: $last_file"
    exit 0
  elif [[ $? -eq 2 ]]; then
    echo
    echo "Stop token ignored on turn $turn: missing TEST_STATUS: PASS or UNTESTED_SCOPE: NONE."
  fi
done

echo
echo "Reached max turns ($MAX_TURNS) without stop token: $STOP_TOKEN"
echo "Review logs in: $LOG_DIR"
exit 2
