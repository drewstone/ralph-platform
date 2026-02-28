import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import type { RunSnapshot } from "@ralph/schema";
import { scanRepo } from "@ralph/event-ingestor";

interface RunCard {
  id: string;
  startedAt: string;
  updatedAt: string;
  latestTurn?: number;
  latestAuditScore?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  doneDetected: boolean;
  status: "running" | "done" | "idle";
}

type ForgeRunStatus = "queued" | "running" | "paused" | "aborting" | "aborted" | "failed" | "completed";
type ForgeEventLevel = "info" | "warn" | "error";

interface ForgeRun {
  runId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: ForgeRunStatus;
  repo: string;
  baseBranch?: string;
  branchName?: string;
  specFile?: string;
  taskText?: string;
  worktree: boolean;
  openPr: boolean;
  draftPr: boolean;
  remoteName?: string;
  runDir: string;
  pid?: number;
  exitCode?: number;
  errorText?: string;
  retryOf?: string;
  request: CreateForgeRunRequest;
  commandArgs: string[];
}

interface ForgeRunEvent {
  id: number;
  runId: string;
  createdAt: string;
  level: ForgeEventLevel;
  message: string;
}

interface ForgeState {
  activeRunId: string | null;
  queue: string[];
  runs: ForgeRun[];
}

interface DashboardState {
  snapshot: RunSnapshot;
  history: RunCard[];
  forge: ForgeState;
}

interface CreateForgeRunRequest {
  repo: string;
  specFile?: string;
  taskText?: string;
  branchName?: string;
  baseBranch?: string;
  remoteName?: string;
  worktree?: boolean;
  worktreeKeep?: boolean;
  openPr?: boolean;
  draftPr?: boolean;
  allowDirty?: boolean;
  noFetch?: boolean;
  noPush?: boolean;
  injectTexts?: string[];
  injectFiles?: string[];
  loopArgs?: string[];
  commitMessage?: string;
  prTitle?: string;
}

interface ForgeRunPatch {
  status?: ForgeRunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  pid?: number | null;
  exit_code?: number | null;
  error_text?: string | null;
  branch_name?: string | null;
  request_json?: string;
  command_json?: string;
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCreateRunRequest(body: unknown): CreateForgeRunRequest {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

  const repo = normalizeOptionalString(input.repo);
  if (!repo) {
    throw new Error("repo is required");
  }

  const request: CreateForgeRunRequest = {
    repo: path.resolve(repo),
    specFile: normalizeOptionalString(input.specFile),
    taskText: normalizeOptionalString(input.taskText),
    branchName: normalizeOptionalString(input.branchName),
    baseBranch: normalizeOptionalString(input.baseBranch),
    remoteName: normalizeOptionalString(input.remoteName),
    worktree: typeof input.worktree === "boolean" ? input.worktree : true,
    worktreeKeep: typeof input.worktreeKeep === "boolean" ? input.worktreeKeep : false,
    openPr: typeof input.openPr === "boolean" ? input.openPr : false,
    draftPr: typeof input.draftPr === "boolean" ? input.draftPr : false,
    allowDirty: typeof input.allowDirty === "boolean" ? input.allowDirty : false,
    noFetch: typeof input.noFetch === "boolean" ? input.noFetch : false,
    noPush: typeof input.noPush === "boolean" ? input.noPush : false,
    injectTexts: normalizeStringArray(input.injectTexts),
    injectFiles: normalizeStringArray(input.injectFiles),
    loopArgs: normalizeStringArray(input.loopArgs),
    commitMessage: normalizeOptionalString(input.commitMessage),
    prTitle: normalizeOptionalString(input.prTitle)
  };

  if (!request.specFile && !request.taskText) {
    throw new Error("either specFile or taskText is required");
  }
  if (request.draftPr && !request.openPr) {
    throw new Error("draftPr requires openPr=true");
  }

  if (request.specFile && !path.isAbsolute(request.specFile)) {
    request.specFile = path.resolve(request.repo, request.specFile);
  }
  if (request.injectFiles && request.injectFiles.length > 0) {
    request.injectFiles = request.injectFiles.map((file) => (path.isAbsolute(file) ? file : path.resolve(request.repo, file)));
  }

  return request;
}

const targetRepo = getArg("--target") ?? process.env.TARGET_REPO ?? process.cwd();
const port = Number.parseInt(getArg("--port") ?? process.env.PORT ?? "4310", 10);
const pollMs = Number.parseInt(getArg("--poll-ms") ?? process.env.POLL_MS ?? "2000", 10);
const mainInputCostPer1M = Number.parseFloat(getArg("--main-input-cost-per-1m") ?? process.env.MAIN_INPUT_COST_PER_1M ?? "");
const mainOutputCostPer1M = Number.parseFloat(getArg("--main-output-cost-per-1m") ?? process.env.MAIN_OUTPUT_COST_PER_1M ?? "");
const auditInputCostPer1M = Number.parseFloat(getArg("--audit-input-cost-per-1m") ?? process.env.AUDIT_INPUT_COST_PER_1M ?? "");
const auditOutputCostPer1M = Number.parseFloat(getArg("--audit-output-cost-per-1m") ?? process.env.AUDIT_OUTPUT_COST_PER_1M ?? "");
const dbPath =
  getArg("--db") ??
  process.env.RALPH_DASHBOARD_DB ??
  path.join(homedir(), ".ralph-platform", "dashboard.sqlite");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const dispatchBin =
  getArg("--dispatch-bin") ??
  process.env.RALPH_DISPATCH_BIN ??
  path.resolve(repoRoot, "packages/loop-cli/bin/ralph-dispatch.sh");
const forgeRunsRoot =
  getArg("--forge-runs-dir") ??
  process.env.RALPH_FORGE_RUNS_DIR ??
  path.join(homedir(), ".ralph-platform", "forge-runs");

mkdirSync(path.dirname(dbPath), { recursive: true });
mkdirSync(forgeRunsRoot, { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS run_cards (
    run_id TEXT PRIMARY KEY,
    target_repo TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    latest_turn INTEGER,
    latest_audit_score REAL,
    total_tokens INTEGER,
    estimated_cost_usd REAL,
    done_detected INTEGER NOT NULL,
    status TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_run_cards_target_repo_updated
  ON run_cards(target_repo, updated_at DESC);

  CREATE TABLE IF NOT EXISTS run_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    target_repo TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(run_id, generated_at)
  );

  CREATE INDEX IF NOT EXISTS idx_run_snapshots_target_repo_id
  ON run_snapshots(target_repo, id DESC);

  CREATE INDEX IF NOT EXISTS idx_run_snapshots_run_id_generated
  ON run_snapshots(run_id, generated_at DESC);

  CREATE TABLE IF NOT EXISTS forge_runs (
    run_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    status TEXT NOT NULL,
    repo TEXT NOT NULL,
    base_branch TEXT,
    branch_name TEXT,
    spec_file TEXT,
    task_text TEXT,
    worktree INTEGER NOT NULL,
    open_pr INTEGER NOT NULL,
    draft_pr INTEGER NOT NULL,
    remote_name TEXT,
    command_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    run_dir TEXT NOT NULL,
    pid INTEGER,
    exit_code INTEGER,
    error_text TEXT,
    retry_of TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_forge_runs_created
  ON forge_runs(created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_forge_runs_status
  ON forge_runs(status, created_at ASC);

  CREATE TABLE IF NOT EXISTS forge_run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_forge_run_events_run_id
  ON forge_run_events(run_id, id DESC);
`);

try {
  db.exec("ALTER TABLE run_cards ADD COLUMN total_tokens INTEGER");
} catch {
  // Column exists.
}
try {
  db.exec("ALTER TABLE run_cards ADD COLUMN estimated_cost_usd REAL");
} catch {
  // Column exists.
}

// If the dashboard restarts while a run process is active, mark those runs as failed recovery.
const recoveryTs = nowIso();
db.prepare(
  `
  UPDATE forge_runs
  SET status = 'failed',
      finished_at = ?,
      updated_at = ?,
      error_text = COALESCE(error_text, 'dashboard restarted while run was active')
  WHERE status IN ('running', 'paused', 'aborting')
`
).run(recoveryTs, recoveryTs);

function fromDbRow(row: {
  run_id: string;
  started_at: string;
  updated_at: string;
  latest_turn: number | null;
  latest_audit_score: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
  done_detected: number;
  status: string;
}): RunCard {
  return {
    id: row.run_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(typeof row.latest_turn === "number" ? { latestTurn: row.latest_turn } : {}),
    ...(typeof row.latest_audit_score === "number" ? { latestAuditScore: row.latest_audit_score } : {}),
    ...(typeof row.total_tokens === "number" ? { totalTokens: row.total_tokens } : {}),
    ...(typeof row.estimated_cost_usd === "number" ? { estimatedCostUsd: row.estimated_cost_usd } : {}),
    doneDetected: row.done_detected === 1,
    status: row.status === "done" || row.status === "running" ? row.status : "idle"
  };
}

function loadHistory(repoPath: string, limit = 50): RunCard[] {
  const rows = db
    .prepare(
      `
      SELECT run_id, started_at, updated_at, latest_turn, latest_audit_score, total_tokens, estimated_cost_usd, done_detected, status
      FROM run_cards
      WHERE target_repo = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `
    )
    .all(repoPath, limit) as Array<{
    run_id: string;
    started_at: string;
    updated_at: string;
    latest_turn: number | null;
    latest_audit_score: number | null;
    total_tokens: number | null;
    estimated_cost_usd: number | null;
    done_detected: number;
    status: string;
  }>;

  return rows.map(fromDbRow);
}

function statusFromSnapshot(data: RunSnapshot): "running" | "done" | "idle" {
  if (!data.metrics.latestTurn) {
    return "idle";
  }
  return data.metrics.doneDetected ? "done" : "running";
}

function upsertRunCard(data: RunSnapshot): void {
  const now = nowIso();
  const existing = db
    .prepare("SELECT started_at FROM run_cards WHERE run_id = ?")
    .get(data.runId) as { started_at: string } | undefined;

  const startedAt = existing?.started_at ?? now;
  db.prepare(
    `
    INSERT INTO run_cards (
      run_id, target_repo, started_at, updated_at, latest_turn, latest_audit_score, total_tokens, estimated_cost_usd, done_detected, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      target_repo = excluded.target_repo,
      updated_at = excluded.updated_at,
      latest_turn = excluded.latest_turn,
      latest_audit_score = excluded.latest_audit_score,
      total_tokens = excluded.total_tokens,
      estimated_cost_usd = excluded.estimated_cost_usd,
      done_detected = excluded.done_detected,
      status = excluded.status
  `
  ).run(
    data.runId,
    data.targetRepo,
    startedAt,
    now,
    data.metrics.latestTurn ?? null,
    data.metrics.latestAuditScore ?? null,
    data.metrics.totalTokens,
    data.metrics.estimatedCostUsd ?? null,
    data.metrics.doneDetected ? 1 : 0,
    statusFromSnapshot(data)
  );
}

function appendSnapshot(data: RunSnapshot): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO run_snapshots (run_id, target_repo, generated_at, payload)
    VALUES (?, ?, ?, ?)
  `
  ).run(data.runId, data.targetRepo, data.generatedAt, JSON.stringify(data));

  db.prepare(
    `
    DELETE FROM run_snapshots
    WHERE target_repo = ?
      AND id NOT IN (
        SELECT id FROM run_snapshots
        WHERE target_repo = ?
        ORDER BY id DESC
        LIMIT 1000
      )
  `
  ).run(data.targetRepo, data.targetRepo);
}

function loadRunSnapshots(runId: string, limit = 100): RunSnapshot[] {
  const rows = db
    .prepare(
      `
      SELECT payload
      FROM run_snapshots
      WHERE run_id = ?
      ORDER BY generated_at DESC
      LIMIT ?
    `
    )
    .all(runId, limit) as Array<{ payload: string }>;

  const parsed: RunSnapshot[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row.payload) as RunSnapshot);
    } catch {
      // ignore malformed payloads
    }
  }
  return parsed;
}

function toForgeRun(row: {
  run_id: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: string;
  repo: string;
  base_branch: string | null;
  branch_name: string | null;
  spec_file: string | null;
  task_text: string | null;
  worktree: number;
  open_pr: number;
  draft_pr: number;
  remote_name: string | null;
  command_json: string;
  request_json: string;
  run_dir: string;
  pid: number | null;
  exit_code: number | null;
  error_text: string | null;
  retry_of: string | null;
}): ForgeRun {
  let request: CreateForgeRunRequest = { repo: row.repo };
  let commandArgs: string[] = [];
  try {
    request = JSON.parse(row.request_json) as CreateForgeRunRequest;
  } catch {
    // fallback default above
  }
  try {
    commandArgs = JSON.parse(row.command_json) as string[];
  } catch {
    // fallback empty above
  }

  return {
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    status: (row.status as ForgeRunStatus) ?? "failed",
    repo: row.repo,
    ...(row.base_branch ? { baseBranch: row.base_branch } : {}),
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    ...(row.spec_file ? { specFile: row.spec_file } : {}),
    ...(row.task_text ? { taskText: row.task_text } : {}),
    worktree: row.worktree === 1,
    openPr: row.open_pr === 1,
    draftPr: row.draft_pr === 1,
    ...(row.remote_name ? { remoteName: row.remote_name } : {}),
    runDir: row.run_dir,
    ...(typeof row.pid === "number" ? { pid: row.pid } : {}),
    ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
    ...(row.error_text ? { errorText: row.error_text } : {}),
    ...(row.retry_of ? { retryOf: row.retry_of } : {}),
    request,
    commandArgs
  };
}

function loadForgeRuns(limit = 40): ForgeRun[] {
  const rows = db
    .prepare(
      `
      SELECT run_id, created_at, updated_at, started_at, finished_at, status, repo, base_branch, branch_name, spec_file, task_text,
             worktree, open_pr, draft_pr, remote_name, command_json, request_json, run_dir, pid, exit_code, error_text, retry_of
      FROM forge_runs
      ORDER BY created_at DESC
      LIMIT ?
    `
    )
    .all(limit) as Array<{
    run_id: string;
    created_at: string;
    updated_at: string;
    started_at: string | null;
    finished_at: string | null;
    status: string;
    repo: string;
    base_branch: string | null;
    branch_name: string | null;
    spec_file: string | null;
    task_text: string | null;
    worktree: number;
    open_pr: number;
    draft_pr: number;
    remote_name: string | null;
    command_json: string;
    request_json: string;
    run_dir: string;
    pid: number | null;
    exit_code: number | null;
    error_text: string | null;
    retry_of: string | null;
  }>;

  return rows.map(toForgeRun);
}

function loadForgeRun(runId: string): ForgeRun | null {
  const row = db
    .prepare(
      `
      SELECT run_id, created_at, updated_at, started_at, finished_at, status, repo, base_branch, branch_name, spec_file, task_text,
             worktree, open_pr, draft_pr, remote_name, command_json, request_json, run_dir, pid, exit_code, error_text, retry_of
      FROM forge_runs
      WHERE run_id = ?
    `
    )
    .get(runId) as
    | {
        run_id: string;
        created_at: string;
        updated_at: string;
        started_at: string | null;
        finished_at: string | null;
        status: string;
        repo: string;
        base_branch: string | null;
        branch_name: string | null;
        spec_file: string | null;
        task_text: string | null;
        worktree: number;
        open_pr: number;
        draft_pr: number;
        remote_name: string | null;
        command_json: string;
        request_json: string;
        run_dir: string;
        pid: number | null;
        exit_code: number | null;
        error_text: string | null;
        retry_of: string | null;
      }
    | undefined;

  return row ? toForgeRun(row) : null;
}

function loadForgeRunEvents(runId: string, limit = 200): ForgeRunEvent[] {
  const rows = db
    .prepare(
      `
      SELECT id, run_id, created_at, level, message
      FROM forge_run_events
      WHERE run_id = ?
      ORDER BY id DESC
      LIMIT ?
    `
    )
    .all(runId, limit) as Array<{
    id: number;
    run_id: string;
    created_at: string;
    level: string;
    message: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    createdAt: row.created_at,
    level: row.level as ForgeEventLevel,
    message: row.message
  }));
}

function appendForgeEvent(runId: string, level: ForgeEventLevel, message: string): void {
  db.prepare(
    `
    INSERT INTO forge_run_events (run_id, created_at, level, message)
    VALUES (?, ?, ?, ?)
  `
  ).run(runId, nowIso(), level, message);
}

function patchForgeRun(runId: string, patch: ForgeRunPatch): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;

  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  db.prepare(`UPDATE forge_runs SET ${sets}, updated_at = ? WHERE run_id = ?`).run(...values, nowIso(), runId);
}

function removeQueuedRun(runId: string): void {
  const idx = queuedRunIds.indexOf(runId);
  if (idx >= 0) {
    queuedRunIds.splice(idx, 1);
  }
}

function createDefaultBranchName(runId: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  return `ralph/forge-${stamp}-${runId.slice(0, 8)}`;
}

function buildDispatchArgs(request: CreateForgeRunRequest, runId: string, branchName: string): string[] {
  const args: string[] = ["--repo", request.repo];

  if (request.specFile) {
    args.push("--spec", request.specFile);
  }
  if (request.taskText) {
    args.push("--task", request.taskText);
  }

  args.push("--branch", branchName);

  if (request.baseBranch) {
    args.push("--base", request.baseBranch);
  }
  if (request.remoteName) {
    args.push("--remote", request.remoteName);
  }
  if (request.worktree !== false) {
    args.push("--worktree");
  }
  if (request.worktreeKeep) {
    args.push("--worktree-keep");
  }
  if (request.openPr) {
    args.push("--open-pr");
  }
  if (request.draftPr) {
    args.push("--draft-pr");
  }
  if (request.allowDirty) {
    args.push("--allow-dirty");
  }
  if (request.noFetch) {
    args.push("--no-fetch");
  }
  if (request.noPush) {
    args.push("--no-push");
  }
  if (request.commitMessage) {
    args.push("--commit-message", request.commitMessage);
  }
  if (request.prTitle) {
    args.push("--pr-title", request.prTitle);
  }

  for (const injectFile of request.injectFiles ?? []) {
    args.push("--inject", injectFile);
  }
  for (const injectText of request.injectTexts ?? []) {
    args.push("--inject-text", injectText);
  }

  if ((request.loopArgs ?? []).length > 0) {
    args.push("--", ...(request.loopArgs ?? []));
  }

  return args;
}

function insertForgeRun(
  runId: string,
  request: CreateForgeRunRequest,
  commandArgs: string[],
  branchName: string,
  retryOf?: string
): ForgeRun {
  const createdAt = nowIso();
  const runDir = path.join(forgeRunsRoot, runId);
  mkdirSync(runDir, { recursive: true });

  db.prepare(
    `
    INSERT INTO forge_runs (
      run_id, created_at, updated_at, status, repo, base_branch, branch_name, spec_file, task_text,
      worktree, open_pr, draft_pr, remote_name, command_json, request_json, run_dir, retry_of
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    runId,
    createdAt,
    createdAt,
    "queued",
    request.repo,
    request.baseBranch ?? null,
    branchName,
    request.specFile ?? null,
    request.taskText ?? null,
    request.worktree === false ? 0 : 1,
    request.openPr ? 1 : 0,
    request.draftPr ? 1 : 0,
    request.remoteName ?? null,
    JSON.stringify(commandArgs),
    JSON.stringify(request),
    runDir,
    retryOf ?? null
  );

  appendForgeEvent(runId, "info", `queued run for repo ${request.repo}`);
  const run = loadForgeRun(runId);
  if (!run) {
    throw new Error("failed to create run record");
  }
  return run;
}

const queuedRunIds: string[] = [];
const activeProcesses = new Map<string, ChildProcess>();
let activeRunId: string | null = null;

function enqueueRun(runId: string): void {
  if (!queuedRunIds.includes(runId)) {
    queuedRunIds.push(runId);
  }
}

function loadQueuedRunsFromDb(): void {
  const rows = db
    .prepare("SELECT run_id FROM forge_runs WHERE status = 'queued' ORDER BY created_at ASC")
    .all() as Array<{ run_id: string }>;

  queuedRunIds.splice(0, queuedRunIds.length, ...rows.map((row) => row.run_id));
}

function forgeState(): ForgeState {
  return {
    activeRunId,
    queue: [...queuedRunIds],
    runs: loadForgeRuns(50)
  };
}

let history: RunCard[] = loadHistory(targetRepo, 50);
let snapshot: RunSnapshot = {
  runId: `${path.basename(targetRepo)}-bootstrap`,
  generatedAt: nowIso(),
  targetRepo,
  turns: [],
  audits: [],
  nodes: [],
  edges: [],
  repo: { path: targetRepo, hasGit: false },
  metrics: {
    turnCount: 0,
    auditCount: 0,
    doneDetected: false,
    mainInputTokens: 0,
    mainOutputTokens: 0,
    mainCacheReadTokens: 0,
    mainCacheWriteTokens: 0,
    auditInputTokens: 0,
    auditOutputTokens: 0,
    auditCacheReadTokens: 0,
    auditCacheWriteTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalTokens: 0
  }
};

function statePayload(): DashboardState {
  return {
    snapshot,
    history,
    forge: forgeState()
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcastState(): void {
  const payload = JSON.stringify({ type: "state", data: statePayload() });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

async function refreshSnapshot(): Promise<void> {
  const next = await scanRepo(targetRepo, {
    ...(Number.isFinite(mainInputCostPer1M) ? { mainInputCostPer1M } : {}),
    ...(Number.isFinite(mainOutputCostPer1M) ? { mainOutputCostPer1M } : {}),
    ...(Number.isFinite(auditInputCostPer1M) ? { auditInputCostPer1M } : {}),
    ...(Number.isFinite(auditOutputCostPer1M) ? { auditOutputCostPer1M } : {})
  });
  snapshot = next;
  upsertRunCard(next);
  appendSnapshot(next);
  history = loadHistory(targetRepo, 50);
}

function beginRunProcess(run: ForgeRun): void {
  const child = spawn(dispatchBin, run.commandArgs, {
    cwd: run.repo,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  activeRunId = run.runId;
  activeProcesses.set(run.runId, child);
  patchForgeRun(run.runId, {
    status: "running",
    started_at: nowIso(),
    pid: typeof child.pid === "number" ? child.pid : null,
    error_text: null,
    exit_code: null,
    finished_at: null
  });
  appendForgeEvent(run.runId, "info", `started: ${dispatchBin} ${run.commandArgs.join(" ")}`);
  broadcastState();

  const logPath = path.join(run.runDir, "runner.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const writeLog = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    logStream.write(`[${nowIso()}] [${stream}] ${chunk.toString()}`);
  };

  child.stdout.on("data", (chunk: Buffer) => writeLog("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => writeLog("stderr", chunk));

  child.once("error", (error: Error) => {
    appendForgeEvent(run.runId, "error", `spawn error: ${error.message}`);
    patchForgeRun(run.runId, { error_text: error.message });
  });

  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    logStream.end();

    const latest = loadForgeRun(run.runId);
    const wasAborting = latest?.status === "aborting";
    const status: ForgeRunStatus = wasAborting ? "aborted" : code === 0 ? "completed" : "failed";
    const errorText =
      status === "failed"
        ? `dispatch exited with code=${code ?? "null"} signal=${signal ?? "null"}`
        : latest?.errorText ?? null;

    patchForgeRun(run.runId, {
      status,
      finished_at: nowIso(),
      pid: null,
      exit_code: code,
      error_text: errorText
    });

    appendForgeEvent(
      run.runId,
      status === "completed" ? "info" : status === "aborted" ? "warn" : "error",
      `finished with status=${status} code=${code ?? "null"} signal=${signal ?? "null"}`
    );

    activeProcesses.delete(run.runId);
    if (activeRunId === run.runId) {
      activeRunId = null;
    }

    broadcastState();
    void maybeStartNextRun();
  });
}

async function maybeStartNextRun(): Promise<void> {
  if (activeRunId) return;

  const nextRunId = queuedRunIds.shift();
  if (!nextRunId) return;

  const run = loadForgeRun(nextRunId);
  if (!run) {
    void maybeStartNextRun();
    return;
  }

  if (run.status !== "queued") {
    void maybeStartNextRun();
    return;
  }

  beginRunProcess(run);
}

function createForgeRun(request: CreateForgeRunRequest, retryOf?: string): ForgeRun {
  const runId = randomUUID();
  const branchName = request.branchName ?? createDefaultBranchName(runId);
  const commandArgs = buildDispatchArgs(request, runId, branchName);
  const run = insertForgeRun(runId, request, commandArgs, branchName, retryOf);
  enqueueRun(run.runId);
  broadcastState();
  void maybeStartNextRun();
  return run;
}

function createRetryRequest(base: ForgeRun): CreateForgeRunRequest {
  const request = base.request;
  const retryStamp = Date.now().toString().slice(-6);
  const nextBranch = `${request.branchName ?? base.branchName ?? createDefaultBranchName(base.runId)}-retry-${retryStamp}`;

  return {
    ...request,
    branchName: nextBranch,
    draftPr: false
  };
}

function pauseRun(run: ForgeRun): void {
  if (run.status !== "running") {
    throw new Error("run is not running");
  }
  const child = activeProcesses.get(run.runId);
  if (!child || typeof child.pid !== "number") {
    throw new Error("run process not found");
  }

  process.kill(child.pid, "SIGSTOP");
  patchForgeRun(run.runId, { status: "paused" });
  appendForgeEvent(run.runId, "warn", "paused by operator");
  broadcastState();
}

function resumeRun(run: ForgeRun): void {
  if (run.status !== "paused") {
    throw new Error("run is not paused");
  }
  const child = activeProcesses.get(run.runId);
  if (!child || typeof child.pid !== "number") {
    throw new Error("run process not found");
  }

  process.kill(child.pid, "SIGCONT");
  patchForgeRun(run.runId, { status: "running" });
  appendForgeEvent(run.runId, "info", "resumed by operator");
  broadcastState();
}

function abortRun(run: ForgeRun): void {
  if (run.status === "queued") {
    removeQueuedRun(run.runId);
    patchForgeRun(run.runId, {
      status: "aborted",
      finished_at: nowIso(),
      error_text: "aborted while queued"
    });
    appendForgeEvent(run.runId, "warn", "aborted while queued");
    broadcastState();
    return;
  }

  if (run.status !== "running" && run.status !== "paused") {
    throw new Error("run is not active");
  }

  const child = activeProcesses.get(run.runId);
  if (!child || typeof child.pid !== "number") {
    patchForgeRun(run.runId, {
      status: "aborted",
      finished_at: nowIso(),
      error_text: "process not found during abort"
    });
    appendForgeEvent(run.runId, "warn", "process missing, marked aborted");
    broadcastState();
    return;
  }

  patchForgeRun(run.runId, { status: "aborting" });
  appendForgeEvent(run.runId, "warn", "abort requested; sending SIGTERM");
  process.kill(child.pid, "SIGTERM");
  broadcastState();
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    targetRepo,
    pollMs,
    dbPath,
    dispatchBin,
    forgeRunsRoot,
    pricing: {
      mainInputCostPer1M: Number.isFinite(mainInputCostPer1M) ? mainInputCostPer1M : null,
      mainOutputCostPer1M: Number.isFinite(mainOutputCostPer1M) ? mainOutputCostPer1M : null,
      auditInputCostPer1M: Number.isFinite(auditInputCostPer1M) ? auditInputCostPer1M : null,
      auditOutputCostPer1M: Number.isFinite(auditOutputCostPer1M) ? auditOutputCostPer1M : null
    }
  });
});

app.get("/api/state", (_req, res) => {
  res.json(statePayload());
});

app.get("/api/runs", (_req, res) => {
  res.json({ runs: history });
});

app.get("/api/runs/:runId/snapshots", (req, res) => {
  const limitRaw = typeof req.query.limit === "string" ? req.query.limit : "100";
  const limit = Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || 100));
  res.json({ runId: req.params.runId, snapshots: loadRunSnapshots(req.params.runId, limit) });
});

app.get("/api/forge/runs", (_req, res) => {
  res.json({ forge: forgeState() });
});

app.get("/api/forge/runs/:runId", (req, res) => {
  const run = loadForgeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  const events = loadForgeRunEvents(req.params.runId, 300);
  res.json({ run, events });
});

app.post("/api/forge/runs", (req, res) => {
  try {
    const request = parseCreateRunRequest(req.body);
    const run = createForgeRun(request);
    res.status(201).json({ run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid request";
    res.status(400).json({ error: message });
  }
});

app.post("/api/forge/runs/:runId/pause", (req, res) => {
  const run = loadForgeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  try {
    pauseRun(run);
    res.json({ run: loadForgeRun(run.runId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to pause run";
    res.status(409).json({ error: message });
  }
});

app.post("/api/forge/runs/:runId/resume", (req, res) => {
  const run = loadForgeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  try {
    resumeRun(run);
    res.json({ run: loadForgeRun(run.runId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to resume run";
    res.status(409).json({ error: message });
  }
});

app.post("/api/forge/runs/:runId/abort", (req, res) => {
  const run = loadForgeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  try {
    abortRun(run);
    res.json({ run: loadForgeRun(run.runId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to abort run";
    res.status(409).json({ error: message });
  }
});

app.post("/api/forge/runs/:runId/retry", (req, res) => {
  const run = loadForgeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  if (run.status !== "failed" && run.status !== "aborted" && run.status !== "completed") {
    res.status(409).json({ error: "run is not retryable" });
    return;
  }

  const retryRequest = createRetryRequest(run);
  try {
    const retryRun = createForgeRun(retryRequest, run.runId);
    appendForgeEvent(run.runId, "info", `retry scheduled as ${retryRun.runId}`);
    res.status(201).json({ run: retryRun });
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to retry run";
    res.status(400).json({ error: message });
  }
});

wss.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "state", data: statePayload() }));
});

async function tick(): Promise<void> {
  try {
    await refreshSnapshot();
    broadcastState();
  } catch (error) {
    console.error("[dashboard] refresh failed", error);
  }
}

loadQueuedRunsFromDb();
void maybeStartNextRun();

await tick();
setInterval(() => {
  void tick();
}, pollMs);

server.listen(port, () => {
  console.log(`[dashboard] listening on http://localhost:${port}`);
  console.log(`[dashboard] target repo: ${targetRepo}`);
  console.log(`[dashboard] sqlite db: ${dbPath}`);
  console.log(`[dashboard] dispatch bin: ${dispatchBin}`);
  if (Number.isFinite(mainInputCostPer1M) && Number.isFinite(mainOutputCostPer1M)) {
    console.log(`[dashboard] pricing main: in=${mainInputCostPer1M}/1M out=${mainOutputCostPer1M}/1M`);
  }
  if (Number.isFinite(auditInputCostPer1M) && Number.isFinite(auditOutputCostPer1M)) {
    console.log(`[dashboard] pricing audit: in=${auditInputCostPer1M}/1M out=${auditOutputCostPer1M}/1M`);
  }
});
