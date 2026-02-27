# @ralph/loop-cli

Standalone loop runner CLI.

Usage:
```bash
ralph-loop --help
```

Or from workspace root:
```bash
npm run -w @ralph/loop-cli lint
./packages/loop-cli/bin/ralph-loop.sh --help
./packages/loop-cli/bin/ralph-dispatch.sh --help
```

Dispatch workflow (run in another repo, open PR only on success):
```bash
./packages/loop-cli/bin/ralph-dispatch.sh \
  --repo ~/code/target-repo \
  --task "Implement feature X with tests" \
  --preflight \
  --bootstrap-audit \
  --inject ~/code/superkabal/specs/inject/quality-bar.md \
  --inject-text "Keep implementation concise and benchmark critical paths." \
  --open-pr \
  -- --max-turns 80 --audit-every 3 --audit-min-score 9.2
```

Defaults:
- Auto-load global inject from `~/.ralph/inject/default.md` (or `$RALPH_GLOBAL_INJECT`) if present.
- Auto-load repo inject from `<repo>/.ralph/inject/default.md` if present.
- Use `--no-default-injects` to disable defaults.
