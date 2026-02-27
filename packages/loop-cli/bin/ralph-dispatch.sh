#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  ralph-dispatch.sh --repo REPO_DIR [--task TEXT | --spec FILE] [dispatch options] [-- <ralph-loop args>]

Required:
  --repo DIR              Target git repository to modify.
  --task TEXT             Task prompt or incident report (for generated spec).
  --spec FILE             Existing spec file to include.

Dispatch options:
  --inject FILE           Inject file layer (repeatable).
  --inject-text TEXT      Inline inject text layer (repeatable; highest precedence).
  --no-default-injects    Disable default global/repo inject layers.
  --preflight             Generate repo preflight context artifact before loop.
  --bootstrap-audit       Run a Codex planning pass to generate final execution spec.
  --codex-bin BIN         Codex binary for bootstrap pass (default: codex).
  --bootstrap-model MODEL Codex model override for bootstrap pass.
  --bootstrap-profile P   Codex profile override for bootstrap pass.
  --bootstrap-codex-arg A Extra argument for bootstrap `codex exec` (repeatable).
  --branch NAME           Working branch name (default: ralph/<timestamp>).
  --base BRANCH           Base branch for PR/branch point (default: origin/HEAD or main).
  --remote NAME           Git remote name (default: origin).
  --open-pr               Open a GitHub PR after successful push.
  --draft-pr              Create PR as draft (requires --open-pr).
  --pr-title TEXT         PR title override.
  --pr-body-file FILE     PR body markdown file.
  --commit-message TEXT   Commit message override.
  --allow-dirty           Allow running with local uncommitted changes.
  --no-fetch              Skip `git fetch` before branching.
  --no-push               Skip git push.
  -h, --help              Show this help.

Pass-through loop args:
  Any arguments after `--` are passed directly to `ralph-loop.sh`.

Default inject layering order:
  1) ~/.ralph/inject/default.md (or $RALPH_GLOBAL_INJECT)
  2) <repo>/.ralph/inject/default.md
  3) each --inject FILE (in provided order)
  4) each --inject-text TEXT (in provided order)

Examples:
  ralph-dispatch.sh \
    --repo ~/code/workspace-app \
    --task "Prod bug: GitHub connections fail in workspace. Donovan reported in #incident-123." \
    --preflight \
    --bootstrap-audit \
    --inject-text "Prioritize root cause and reproducible test coverage." \
    --open-pr \
    -- --max-turns 80 --audit-every 3 --audit-min-score 9.2

  ralph-dispatch.sh \
    --repo ~/code/workspace-app \
    --spec ./specs/fix-github-connection.md \
    --inject ./specs/inject/quality-bar.md \
    --open-pr
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
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
  local repo_dir="$2"

  if [[ "$input_path" = /* ]]; then
    resolve_path "$input_path"
    return
  fi
  if [[ -f "$repo_dir/$input_path" ]]; then
    resolve_path "$repo_dir/$input_path"
    return
  fi
  resolve_path "$CALLER_DIR/$input_path"
}

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

default_branch_name() {
  date -u +"ralph/%Y%m%d-%H%M%S"
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

detect_base_branch() {
  local repo_dir="$1"
  local remote_name="$2"
  local base_ref
  base_ref="$(git -C "$repo_dir" symbolic-ref --quiet --short "refs/remotes/${remote_name}/HEAD" 2>/dev/null || true)"
  if [[ -n "$base_ref" ]]; then
    echo "${base_ref#${remote_name}/}"
    return
  fi
  echo "main"
}

detect_stack() {
  local repo_dir="$1"
  local stacks=()
  [[ -f "$repo_dir/package.json" ]] && stacks+=("node")
  [[ -f "$repo_dir/pyproject.toml" || -f "$repo_dir/requirements.txt" ]] && stacks+=("python")
  [[ -f "$repo_dir/go.mod" ]] && stacks+=("go")
  [[ -f "$repo_dir/Cargo.toml" ]] && stacks+=("rust")
  [[ -f "$repo_dir/Gemfile" ]] && stacks+=("ruby")
  [[ -f "$repo_dir/Podfile" || -f "$repo_dir/ios/Podfile" ]] && stacks+=("ios")
  [[ -f "$repo_dir/android/build.gradle" || -f "$repo_dir/android/build.gradle.kts" ]] && stacks+=("android")
  if [[ ${#stacks[@]} -eq 0 ]]; then
    echo "unknown"
  else
    printf "%s\n" "${stacks[*]}"
  fi
}

append_command_output() {
  local output_file="$1"
  local heading="$2"
  shift 2

  {
    echo "### ${heading}"
    echo '```text'
    if "$@" 2>&1; then
      :
    else
      echo
      echo "[command failed] $*"
    fi
    echo '```'
    echo
  } >>"$output_file"
}

generate_preflight_context() {
  local output_file="$1"
  local repo_dir="$2"

  {
    echo "# Ralph Preflight Context"
    echo
    echo "- generated_at: $(timestamp_utc)"
    echo "- repo: $repo_dir"
    echo "- stack_guess: $(detect_stack "$repo_dir")"
    echo
    echo "This artifact is read-only context for planning and execution."
    echo
  } >"$output_file"

  append_command_output "$output_file" "Git Branch" git -C "$repo_dir" rev-parse --abbrev-ref HEAD
  append_command_output "$output_file" "Git Status (Porcelain)" git -C "$repo_dir" status --porcelain
  append_command_output "$output_file" "Recent Commits (15)" git -C "$repo_dir" log --oneline -n 15

  if command -v rg >/dev/null 2>&1; then
    append_command_output "$output_file" "Top Files (rg --files | head -n 250)" bash -lc "cd '$repo_dir' && rg --files | head -n 250"
    append_command_output "$output_file" "TODO/FIXME Scan (top 200 hits)" bash -lc "cd '$repo_dir' && rg -n 'TODO|FIXME|BUG|HACK' | head -n 200"
  else
    append_command_output "$output_file" "Top Files (find | head -n 250)" bash -lc "cd '$repo_dir' && find . -type f | head -n 250"
  fi

  if [[ -f "$repo_dir/package.json" ]] && command -v node >/dev/null 2>&1; then
    append_command_output "$output_file" "Node Package Scripts" node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const s=p.scripts||{}; console.log(Object.keys(s).sort().map(k=>`${k}: ${s[k]}`).join("\n"));' "$repo_dir/package.json"
  fi
}

build_commit_message() {
  local explicit="$1"
  local task_text="$2"
  local spec_path="$3"

  if [[ -n "$explicit" ]]; then
    echo "$explicit"
    return
  fi
  if [[ -n "$task_text" ]]; then
    local first_line
    first_line="$(echo "$task_text" | head -n1 | cut -c1-64)"
    local slug
    slug="$(slugify "$first_line")"
    if [[ -z "$slug" ]]; then
      slug="update-generated-changes"
    fi
    echo "feat: $slug"
    return
  fi
  local base_name
  base_name="$(basename "$spec_path" .md)"
  echo "feat: apply spec ${base_name}"
}

build_pr_title() {
  local explicit="$1"
  local commit_message="$2"
  if [[ -n "$explicit" ]]; then
    echo "$explicit"
  else
    echo "$commit_message"
  fi
}

build_temp_spec() {
  local output_file="$1"
  local repo_dir="$2"
  local task_text="$3"
  local base_spec="$4"
  local preflight_file="$5"

  {
    echo "# Ralph Dispatch Task"
    echo
    echo "Timestamp: $(timestamp_utc)"
    echo "Target repo: $repo_dir"
    echo
    if [[ -n "$task_text" ]]; then
      echo "## Incident / Task Input"
      echo "$task_text"
      echo
    fi
    if [[ -n "$base_spec" ]]; then
      echo "## Base Spec Source"
      echo "$base_spec"
      echo
      cat "$base_spec"
      echo
    fi
    if [[ -n "$preflight_file" ]]; then
      echo "## Project Context Artifact"
      echo "Read this file before implementation:"
      echo "- $preflight_file"
      echo
    fi
    echo "## Completion Requirements"
    echo "- Implement the requested behavior fully."
    echo "- Add or update tests for changed behavior."
    echo "- Keep changes concise and production-ready."
    echo "- Only print [[DONE]] when tests pass and untested scope is NONE."
  } >"$output_file"
}

run_bootstrap_audit() {
  local codex_bin="$1"
  local repo_dir="$2"
  local input_spec="$3"
  local preflight_file="$4"
  local output_spec="$5"
  local prompt_file="$6"
  local stdout_file="$7"
  local last_file="$8"

  {
    echo "You are generating an implementation-ready spec for an autonomous coding loop."
    echo "Output only markdown for the final spec. No preamble, no extra commentary."
    echo
    echo "Constraints:"
    echo "- Prefer concrete, testable requirements over vague goals."
    echo "- Keep platform scaffolding general; keep product behavior specific."
    echo "- Include explicit acceptance criteria and failure-mode tests."
    echo "- Include a rollback/risk section for production issues."
    echo
    echo "Required sections in output:"
    echo "1) Problem Statement"
    echo "2) Scope and Non-Goals"
    echo "3) User and System Flows"
    echo "4) Root-Cause Investigation Plan"
    echo "5) Implementation Plan (ordered tasks)"
    echo "6) Test Plan (unit/integration/e2e as applicable)"
    echo "7) Observability and Metrics"
    echo "8) Risks and Rollback"
    echo "9) Acceptance Criteria"
    echo
    echo "Input spec follows:"
    echo
    cat "$input_spec"
    echo
    if [[ -n "$preflight_file" && -f "$preflight_file" ]]; then
      echo "Preflight context follows:"
      echo
      cat "$preflight_file"
      echo
    fi
  } >"$prompt_file"

  bootstrap_cmd=(
    "$codex_bin" exec
    --dangerously-bypass-approvals-and-sandbox
    --skip-git-repo-check
    --ephemeral
    --cd "$repo_dir"
    --output-last-message "$last_file"
  )

  if [[ -n "$BOOTSTRAP_MODEL" ]]; then
    bootstrap_cmd+=(--model "$BOOTSTRAP_MODEL")
  fi
  if [[ -n "$BOOTSTRAP_PROFILE" ]]; then
    bootstrap_cmd+=(--profile "$BOOTSTRAP_PROFILE")
  fi
  if [[ ${#BOOTSTRAP_EXTRA_CODEX_ARGS[@]} -gt 0 ]]; then
    bootstrap_cmd+=("${BOOTSTRAP_EXTRA_CODEX_ARGS[@]}")
  fi
  bootstrap_cmd+=(-)

  if ! "${bootstrap_cmd[@]}" <"$prompt_file" | tee "$stdout_file"; then
    return 1
  fi
  if [[ ! -s "$last_file" ]]; then
    cp "$stdout_file" "$last_file"
  fi
  if [[ ! -s "$last_file" ]]; then
    return 1
  fi

  cat >"$output_spec" <<EOF
# Ralph Bootstrap Spec

Generated at: $(timestamp_utc)
Source: bootstrap audit synthesis

$(cat "$last_file")
EOF
}

build_merged_inject() {
  local output_file="$1"
  local repo_dir="$2"
  shift 2
  local explicit_files=("$@")
  local layer_files=()

  local global_default="${RALPH_GLOBAL_INJECT:-$HOME/.ralph/inject/default.md}"
  local repo_default="$repo_dir/.ralph/inject/default.md"

  if [[ "$USE_DEFAULT_INJECTS" == "true" ]]; then
    [[ -f "$global_default" ]] && layer_files+=("$global_default")
    [[ -f "$repo_default" ]] && layer_files+=("$repo_default")
  fi

  if [[ ${#explicit_files[@]} -gt 0 ]]; then
    layer_files+=("${explicit_files[@]}")
  fi

  if [[ ${#layer_files[@]} -eq 0 && ${#INJECT_TEXTS[@]} -eq 0 ]]; then
    return 1
  fi

  {
    echo "# Merged Ralph Injection"
    echo
    echo "Generated: $(timestamp_utc)"
    echo
    local layer_file
    for layer_file in "${layer_files[@]}"; do
      echo "## Inject File: $layer_file"
      echo
      cat "$layer_file"
      echo
    done

    if [[ ${#INJECT_TEXTS[@]} -gt 0 ]]; then
      local idx=1
      local inline_text
      for inline_text in "${INJECT_TEXTS[@]}"; do
        echo "## Inline Inject $idx"
        echo
        echo "$inline_text"
        echo
        idx=$((idx + 1))
      done
    fi
  } >"$output_file"

  return 0
}

REPO_DIR=""
SPEC_FILE=""
TASK_TEXT=""
INJECT_FILES=()
INJECT_TEXTS=()
USE_DEFAULT_INJECTS="true"
PRE_FLIGHT="false"
BOOTSTRAP_AUDIT="false"
CODEX_BIN="${CODEX_BIN:-codex}"
BOOTSTRAP_MODEL=""
BOOTSTRAP_PROFILE=""
BOOTSTRAP_EXTRA_CODEX_ARGS=()
BRANCH_NAME=""
BASE_BRANCH=""
REMOTE_NAME="origin"
OPEN_PR="false"
DRAFT_PR="false"
PR_TITLE=""
PR_BODY_FILE=""
COMMIT_MESSAGE=""
ALLOW_DIRTY="false"
DO_FETCH="true"
DO_PUSH="true"
LOOP_FORWARD_ARGS=()
CALLER_DIR="$(pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --spec)
      SPEC_FILE="${2:-}"
      shift 2
      ;;
    --task)
      TASK_TEXT="${2:-}"
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
    --no-default-injects)
      USE_DEFAULT_INJECTS="false"
      shift
      ;;
    --preflight)
      PRE_FLIGHT="true"
      shift
      ;;
    --bootstrap-audit)
      BOOTSTRAP_AUDIT="true"
      shift
      ;;
    --codex-bin)
      CODEX_BIN="${2:-}"
      shift 2
      ;;
    --bootstrap-model)
      BOOTSTRAP_MODEL="${2:-}"
      shift 2
      ;;
    --bootstrap-profile)
      BOOTSTRAP_PROFILE="${2:-}"
      shift 2
      ;;
    --bootstrap-codex-arg)
      BOOTSTRAP_EXTRA_CODEX_ARGS+=("${2:-}")
      shift 2
      ;;
    --branch)
      BRANCH_NAME="${2:-}"
      shift 2
      ;;
    --base)
      BASE_BRANCH="${2:-}"
      shift 2
      ;;
    --remote)
      REMOTE_NAME="${2:-}"
      shift 2
      ;;
    --open-pr)
      OPEN_PR="true"
      shift
      ;;
    --draft-pr)
      DRAFT_PR="true"
      shift
      ;;
    --pr-title)
      PR_TITLE="${2:-}"
      shift 2
      ;;
    --pr-body-file)
      PR_BODY_FILE="${2:-}"
      shift 2
      ;;
    --commit-message)
      COMMIT_MESSAGE="${2:-}"
      shift 2
      ;;
    --allow-dirty)
      ALLOW_DIRTY="true"
      shift
      ;;
    --no-fetch)
      DO_FETCH="false"
      shift
      ;;
    --no-push)
      DO_PUSH="false"
      shift
      ;;
    --)
      shift
      LOOP_FORWARD_ARGS+=("$@")
      break
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

[[ -n "$REPO_DIR" ]] || die "--repo is required"
if [[ -z "$SPEC_FILE" && -z "$TASK_TEXT" ]]; then
  die "Provide at least one of --task or --spec"
fi
if [[ "$OPEN_PR" != "true" && "$DRAFT_PR" == "true" ]]; then
  die "--draft-pr requires --open-pr"
fi
if [[ "$OPEN_PR" == "true" && "$DO_PUSH" != "true" ]]; then
  die "--open-pr requires push (remove --no-push)"
fi
if [[ -n "$PR_BODY_FILE" && ! -f "$PR_BODY_FILE" ]]; then
  die "PR body file not found: $PR_BODY_FILE"
fi
if [[ "$BOOTSTRAP_AUDIT" == "true" ]]; then
  command -v "$CODEX_BIN" >/dev/null 2>&1 || die "Codex binary not found: $CODEX_BIN"
fi

REPO_DIR="$(resolve_path "$REPO_DIR")"
[[ -d "$REPO_DIR" ]] || die "Repo directory not found: $REPO_DIR"
git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not a git repository: $REPO_DIR"

if [[ -n "$SPEC_FILE" ]]; then
  SPEC_FILE="$(resolve_input_file "$SPEC_FILE" "$REPO_DIR")"
  [[ -f "$SPEC_FILE" ]] || die "Spec file not found: $SPEC_FILE"
fi

if [[ ${#INJECT_FILES[@]} -gt 0 ]]; then
  resolved_injects=()
  for inject_file in "${INJECT_FILES[@]}"; do
    resolved_path="$(resolve_input_file "$inject_file" "$REPO_DIR")"
    [[ -f "$resolved_path" ]] || die "Inject file not found: $resolved_path"
    resolved_injects+=("$resolved_path")
  done
  INJECT_FILES=("${resolved_injects[@]}")
fi

if [[ -n "$PR_BODY_FILE" ]]; then
  PR_BODY_FILE="$(resolve_input_file "$PR_BODY_FILE" "$REPO_DIR")"
  [[ -f "$PR_BODY_FILE" ]] || die "PR body file not found: $PR_BODY_FILE"
fi

if [[ "$ALLOW_DIRTY" != "true" ]]; then
  if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
    die "Repository has uncommitted changes. Commit/stash or pass --allow-dirty."
  fi
fi

if [[ -z "$BASE_BRANCH" ]]; then
  BASE_BRANCH="$(detect_base_branch "$REPO_DIR" "$REMOTE_NAME")"
fi
if [[ -z "$BRANCH_NAME" ]]; then
  BRANCH_NAME="$(default_branch_name)"
fi
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  die "Local branch already exists: $BRANCH_NAME"
fi

if [[ "$DO_FETCH" == "true" ]]; then
  git -C "$REPO_DIR" fetch "$REMOTE_NAME" "$BASE_BRANCH"
fi

start_ref="$BASE_BRANCH"
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/remotes/${REMOTE_NAME}/${BASE_BRANCH}"; then
  start_ref="${REMOTE_NAME}/${BASE_BRANCH}"
elif ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
  die "Base branch not found locally or on ${REMOTE_NAME}: ${BASE_BRANCH}"
fi

git -C "$REPO_DIR" switch -c "$BRANCH_NAME" "$start_ref"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_BIN="$SCRIPT_DIR/ralph-loop.sh"
[[ -x "$LOOP_BIN" ]] || die "ralph-loop.sh not executable at $LOOP_BIN"

DISPATCH_DIR="$REPO_DIR/.ralph/dispatch"
mkdir -p "$DISPATCH_DIR"
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_SPEC_FILE="$DISPATCH_DIR/spec.base.${RUN_STAMP}.md"
FINAL_SPEC_FILE="$DISPATCH_DIR/spec.final.${RUN_STAMP}.md"
PRE_FLIGHT_FILE="$DISPATCH_DIR/preflight.${RUN_STAMP}.md"
MERGED_INJECT_FILE="$DISPATCH_DIR/inject.${RUN_STAMP}.md"
BOOTSTRAP_PROMPT_FILE="$DISPATCH_DIR/bootstrap.prompt.${RUN_STAMP}.txt"
BOOTSTRAP_STDOUT_FILE="$DISPATCH_DIR/bootstrap.stdout.${RUN_STAMP}.log"
BOOTSTRAP_LAST_FILE="$DISPATCH_DIR/bootstrap.last.${RUN_STAMP}.txt"
TMP_PR_BODY_FILE="$DISPATCH_DIR/pr-body.${RUN_STAMP}.md"

cleanup() {
  if [[ -f "$TMP_PR_BODY_FILE" && -z "$PR_BODY_FILE" ]]; then
    rm -f "$TMP_PR_BODY_FILE"
  fi
}
trap cleanup EXIT

if [[ "$PRE_FLIGHT" == "true" ]]; then
  generate_preflight_context "$PRE_FLIGHT_FILE" "$REPO_DIR"
else
  PRE_FLIGHT_FILE=""
fi

build_temp_spec "$BASE_SPEC_FILE" "$REPO_DIR" "$TASK_TEXT" "$SPEC_FILE" "$PRE_FLIGHT_FILE"

if [[ "$BOOTSTRAP_AUDIT" == "true" ]]; then
  echo "Bootstrap audit: generating execution spec..."
  if ! run_bootstrap_audit \
    "$CODEX_BIN" \
    "$REPO_DIR" \
    "$BASE_SPEC_FILE" \
    "$PRE_FLIGHT_FILE" \
    "$FINAL_SPEC_FILE" \
    "$BOOTSTRAP_PROMPT_FILE" \
    "$BOOTSTRAP_STDOUT_FILE" \
    "$BOOTSTRAP_LAST_FILE"; then
    die "Bootstrap audit failed. See $BOOTSTRAP_STDOUT_FILE"
  fi
else
  cp "$BASE_SPEC_FILE" "$FINAL_SPEC_FILE"
fi

USE_INJECT_FILE=""
if build_merged_inject "$MERGED_INJECT_FILE" "$REPO_DIR" "${INJECT_FILES[@]}"; then
  USE_INJECT_FILE="$MERGED_INJECT_FILE"
fi

loop_cmd=(
  "$LOOP_BIN"
  --spec "$FINAL_SPEC_FILE"
  --workdir "$REPO_DIR"
)
if [[ -n "$USE_INJECT_FILE" ]]; then
  loop_cmd+=(--inject "$USE_INJECT_FILE")
fi
if [[ ${#LOOP_FORWARD_ARGS[@]} -gt 0 ]]; then
  loop_cmd+=("${LOOP_FORWARD_ARGS[@]}")
fi

echo "Dispatch starting"
echo "repo: $REPO_DIR"
echo "base: $BASE_BRANCH"
echo "branch: $BRANCH_NAME"
echo "spec: $FINAL_SPEC_FILE"
if [[ -n "$PRE_FLIGHT_FILE" ]]; then
  echo "preflight: $PRE_FLIGHT_FILE"
fi
if [[ "$BOOTSTRAP_AUDIT" == "true" ]]; then
  echo "bootstrap: $BOOTSTRAP_LAST_FILE"
fi
if [[ -n "$USE_INJECT_FILE" ]]; then
  echo "inject: $USE_INJECT_FILE"
fi

if "${loop_cmd[@]}"; then
  :
else
  loop_rc=$?
  echo "Loop failed with exit code $loop_rc. No commit/push/PR created."
  exit "$loop_rc"
fi

if [[ -z "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "Loop finished successfully but produced no working-tree changes."
  exit 0
fi

COMMIT_MESSAGE_FINAL="$(build_commit_message "$COMMIT_MESSAGE" "$TASK_TEXT" "$FINAL_SPEC_FILE")"
git -C "$REPO_DIR" add -A
git -C "$REPO_DIR" commit -m "$COMMIT_MESSAGE_FINAL"

if [[ "$DO_PUSH" == "true" ]]; then
  git -C "$REPO_DIR" push -u "$REMOTE_NAME" "$BRANCH_NAME"
fi

if [[ "$OPEN_PR" == "true" ]]; then
  command -v gh >/dev/null 2>&1 || die "`gh` CLI is required for --open-pr"
  PR_TITLE_FINAL="$(build_pr_title "$PR_TITLE" "$COMMIT_MESSAGE_FINAL")"

  if [[ -z "$PR_BODY_FILE" ]]; then
    {
      echo "## Summary"
      if [[ -n "$TASK_TEXT" ]]; then
        echo "$TASK_TEXT"
      else
        echo "Applied spec: \`$SPEC_FILE\`"
      fi
      echo
      echo "## Dispatch Metadata"
      echo "- Generated at: $(timestamp_utc)"
      echo "- Branch: \`$BRANCH_NAME\`"
      echo "- Base: \`$BASE_BRANCH\`"
      echo "- Final spec: \`$FINAL_SPEC_FILE\`"
      if [[ -n "$PRE_FLIGHT_FILE" ]]; then
        echo "- Preflight: \`$PRE_FLIGHT_FILE\`"
      fi
      if [[ "$BOOTSTRAP_AUDIT" == "true" ]]; then
        echo "- Bootstrap audit output: \`$BOOTSTRAP_LAST_FILE\`"
      fi
      if [[ -n "$USE_INJECT_FILE" ]]; then
        echo "- Merged inject: \`$USE_INJECT_FILE\`"
      fi
      echo "- Logs: \`$REPO_DIR/.ralph\`"
    } >"$TMP_PR_BODY_FILE"
    PR_BODY_FILE="$TMP_PR_BODY_FILE"
  fi

  pr_cmd=(gh pr create --base "$BASE_BRANCH" --head "$BRANCH_NAME" --title "$PR_TITLE_FINAL" --body-file "$PR_BODY_FILE")
  if [[ "$DRAFT_PR" == "true" ]]; then
    pr_cmd+=(--draft)
  fi
  (cd "$REPO_DIR" && "${pr_cmd[@]}")
fi

echo "Dispatch complete"
echo "repo: $REPO_DIR"
echo "branch: $BRANCH_NAME"
if [[ "$OPEN_PR" == "true" ]]; then
  echo "pr: created"
fi
