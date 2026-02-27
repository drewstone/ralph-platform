import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AuditAxisScores, DagEdge, DagNode, RepoState, RunSnapshot, TurnAudit, TurnSummary } from "@ralph/schema";

const execFileAsync = promisify(execFile);
const STOP_TOKEN = "[[DONE]]";

function toTurnNumber(fileName: string): number | null {
  const match = fileName.match(/^turn-(\d{3})\.last\.txt$/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function parseNumberToken(text: string, label: string): number | undefined {
  const strictMatch = text.match(new RegExp(`^${label}:\\s*<<<([0-9]+(?:\\.[0-9]+)?)>>>\\s*$`, "m"));
  if (strictMatch) return Number.parseFloat(strictMatch[1]);
  const looseMatch = text.match(new RegExp(`${label}[^\n]*<<<([0-9]+(?:\\.[0-9]+)?)>>>`, "m"));
  return looseMatch ? Number.parseFloat(looseMatch[1]) : undefined;
}

function parseAxisScores(auditText: string): AuditAxisScores {
  const axes: AuditAxisScores = {};
  const matches = [...auditText.matchAll(/^([a-z_]+)=<<<([0-9]+(?:\.[0-9]+)?)>>>\s*$/gm)];
  for (const [, axis, score] of matches) {
    (axes as Record<string, number>)[axis] = Number.parseFloat(score);
  }
  return axes;
}

function parseChangedFiles(lastMessage: string): string[] {
  const files = new Set<string>();

  for (const match of lastMessage.matchAll(/\((\/[^)]+)\)/g)) {
    files.add(match[1]);
  }

  for (const match of lastMessage.matchAll(/`([^`]+)`/g)) {
    const candidate = match[1];
    if (candidate.includes("/") && !candidate.includes(" ") && !candidate.startsWith("http")) {
      files.add(candidate);
    }
  }

  return [...files].slice(0, 50);
}

async function parseTurn(ralphDir: string, turn: number): Promise<TurnSummary> {
  const turnTag = `${turn}`.padStart(3, "0");
  const lastMessagePath = path.join(ralphDir, `turn-${turnTag}.last.txt`);
  const outputPath = path.join(ralphDir, `turn-${turnTag}.stdout.log`);

  const [lastRaw, outRaw, lastStat, outStat] = await Promise.all([
    fs.readFile(lastMessagePath, "utf8"),
    fs.readFile(outputPath, "utf8").catch(() => ""),
    fs.stat(lastMessagePath),
    fs.stat(outputPath).catch(() => null)
  ]);

  const testStatusMatch = lastRaw.match(/^TEST_STATUS:\s*(PASS|FAIL)\s*$/m);
  const untestedMatch = lastRaw.match(/^UNTESTED_SCOPE:\s*(.+)\s*$/m);

  return {
    turn,
    testStatus: (testStatusMatch?.[1] as "PASS" | "FAIL" | undefined) ?? undefined,
    untestedScope: untestedMatch?.[1],
    stopTokenSeen: lastRaw.includes(STOP_TOKEN) || outRaw.includes(STOP_TOKEN),
    changedFiles: parseChangedFiles(lastRaw),
    outputPath,
    lastMessagePath,
    startedAt: outStat?.birthtime.toISOString(),
    finishedAt: lastStat.mtime.toISOString()
  };
}

async function parseAudit(ralphDir: string, turn: number): Promise<TurnAudit | null> {
  const turnTag = `${turn}`.padStart(3, "0");
  const auditPath = path.join(ralphDir, `turn-${turnTag}.audit.last.txt`);

  try {
    const text = await fs.readFile(auditPath, "utf8");
    const score = parseNumberToken(text, "AUDIT_SCORE");
    const confidence = parseNumberToken(text, "AUDIT_CONFIDENCE");
    const verdictMatch = text.match(/^AUDIT_VERDICT:\s*(PASS|FAIL)\s*$/m);
    const axisIssuesMatch = text.match(/Audit axis threshold status[^\n]*FAIL\s*\(([^)]+)\)/m);

    return {
      turn,
      score,
      confidence,
      verdict: (verdictMatch?.[1] as "PASS" | "FAIL" | undefined) ?? undefined,
      axisScores: parseAxisScores(text),
      thresholdIssues: axisIssuesMatch?.[1]
    };
  } catch {
    return null;
  }
}

function buildDag(turns: TurnSummary[], audits: TurnAudit[]): { nodes: DagNode[]; edges: DagEdge[] } {
  const nodes: DagNode[] = [{ id: "repo", label: "repo", kind: "repo", status: "active" }];
  const edges: DagEdge[] = [];
  const auditByTurn = new Map<number, TurnAudit>(audits.map((audit) => [audit.turn, audit]));

  for (const [index, turn] of turns.entries()) {
    const turnNodeId = `turn-${turn.turn}`;
    nodes.push({
      id: turnNodeId,
      label: `turn ${turn.turn}`,
      kind: "turn",
      status: turn.stopTokenSeen ? "done" : turn.testStatus ?? "running"
    });

    if (index === 0) {
      edges.push({ from: "repo", to: turnNodeId, label: "start" });
    }

    const audit = auditByTurn.get(turn.turn);
    if (audit) {
      const auditNodeId = `audit-${turn.turn}`;
      nodes.push({
        id: auditNodeId,
        label: `audit ${turn.turn} (${audit.score ?? "n/a"})`,
        kind: "audit",
        status: audit.verdict
      });
      edges.push({ from: turnNodeId, to: auditNodeId, label: "evaluate" });

      const next = turns[index + 1];
      if (next) {
        edges.push({ from: auditNodeId, to: `turn-${next.turn}`, label: "next" });
      }
    } else {
      const next = turns[index + 1];
      if (next) {
        edges.push({ from: turnNodeId, to: `turn-${next.turn}`, label: "next" });
      }
    }
  }

  return { nodes, edges };
}

async function readRepoState(targetRepo: string): Promise<RepoState> {
  const hasGit = await fs
    .access(path.join(targetRepo, ".git"))
    .then(() => true)
    .catch(() => false);

  if (!hasGit) {
    return { path: targetRepo, hasGit };
  }

  try {
    const [branchResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", targetRepo, "rev-parse", "--abbrev-ref", "HEAD"]),
      execFileAsync("git", ["-C", targetRepo, "status", "--porcelain"])
    ]);

    return {
      path: targetRepo,
      hasGit,
      gitBranch: branchResult.stdout.trim(),
      dirty: statusResult.stdout.trim().length > 0
    };
  } catch {
    return { path: targetRepo, hasGit };
  }
}

async function listTurnNumbers(ralphDir: string): Promise<number[]> {
  const entries = await fs.readdir(ralphDir).catch(() => [] as string[]);
  return entries
    .map(toTurnNumber)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
}

async function computeRunId(targetRepo: string, ralphDir: string, turnNumbers: number[]): Promise<string> {
  const repoName = path.basename(targetRepo);
  const firstTurn = turnNumbers[0];

  if (firstTurn !== undefined) {
    const firstTag = `${firstTurn}`.padStart(3, "0");
    const candidates = [
      path.join(ralphDir, `turn-${firstTag}.last.txt`),
      path.join(ralphDir, `turn-${firstTag}.stdout.log`)
    ];

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        return `${repoName}-${Math.floor(stat.mtimeMs / 1000)}-${firstTag}`;
      } catch {
        // try next candidate
      }
    }
  }

  const ralphStat = await fs.stat(ralphDir).catch(() => null);
  return `${repoName}-${Math.floor((ralphStat?.mtimeMs ?? Date.now()) / 1000)}-empty`;
}

export async function scanRepo(targetRepo: string): Promise<RunSnapshot> {
  const ralphDir = path.join(targetRepo, ".ralph");
  const turnNumbers = await listTurnNumbers(ralphDir);
  const [turns, audits, repoState] = await Promise.all([
    Promise.all(turnNumbers.map((turn) => parseTurn(ralphDir, turn))),
    Promise.all(turnNumbers.map((turn) => parseAudit(ralphDir, turn))).then((items) => items.filter((item): item is TurnAudit => item !== null)),
    readRepoState(targetRepo)
  ]);

  const { nodes, edges } = buildDag(turns, audits);
  const latestAudit = audits
    .filter((audit) => typeof audit.score === "number")
    .sort((a, b) => b.turn - a.turn)[0];

  const runId = await computeRunId(targetRepo, ralphDir, turnNumbers);

  return {
    runId,
    generatedAt: new Date().toISOString(),
    targetRepo,
    turns,
    audits,
    nodes,
    edges,
    repo: repoState,
    metrics: {
      turnCount: turns.length,
      auditCount: audits.length,
      latestTurn: turns.at(-1)?.turn,
      latestAuditScore: latestAudit?.score,
      doneDetected: turns.some((turn) => turn.stopTokenSeen)
    }
  };
}
