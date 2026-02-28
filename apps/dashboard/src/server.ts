import { mkdirSync } from "node:fs";
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

interface DashboardState {
  snapshot: RunSnapshot;
  history: RunCard[];
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
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

mkdirSync(path.dirname(dbPath), { recursive: true });
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
`);

try {
  db.exec("ALTER TABLE run_cards ADD COLUMN total_tokens INTEGER");
} catch {
  // Column already exists in upgraded databases.
}
try {
  db.exec("ALTER TABLE run_cards ADD COLUMN estimated_cost_usd REAL");
} catch {
  // Column already exists in upgraded databases.
}

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
  const now = new Date().toISOString();
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
      // skip malformed rows
    }
  }
  return parsed;
}

let history: RunCard[] = loadHistory(targetRepo, 50);
let snapshot: RunSnapshot = {
  runId: `${path.basename(targetRepo)}-bootstrap`,
  generatedAt: new Date().toISOString(),
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
    history
  };
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

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    targetRepo,
    pollMs,
    dbPath,
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

await tick();
setInterval(() => {
  void tick();
}, pollMs);

server.listen(port, () => {
  console.log(`[dashboard] listening on http://localhost:${port}`);
  console.log(`[dashboard] target repo: ${targetRepo}`);
  console.log(`[dashboard] sqlite db: ${dbPath}`);
  if (Number.isFinite(mainInputCostPer1M) && Number.isFinite(mainOutputCostPer1M)) {
    console.log(`[dashboard] pricing main: in=${mainInputCostPer1M}/1M out=${mainOutputCostPer1M}/1M`);
  }
  if (Number.isFinite(auditInputCostPer1M) && Number.isFinite(auditOutputCostPer1M)) {
    console.log(`[dashboard] pricing audit: in=${auditInputCostPer1M}/1M out=${auditOutputCostPer1M}/1M`);
  }
});
