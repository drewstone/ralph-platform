import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AuditAxisScores, DagEdge, DagNode, RepoState, RunSnapshot, ScanPricing, TokenUsage, TurnAudit, TurnSummary } from "@ralph/schema";

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

function normalizeUsage(candidate: unknown): TokenUsage | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;

  const usage = candidate as Record<string, unknown>;
  const inputTokensRaw = usage.input_tokens ?? usage.inputTokens;
  const outputTokensRaw = usage.output_tokens ?? usage.outputTokens;
  const cacheReadRaw = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens;
  const cacheWriteRaw = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens;

  const inputTokens = Number(inputTokensRaw ?? 0);
  const outputTokens = Number(outputTokensRaw ?? 0);
  const cacheReadTokens = Number(cacheReadRaw ?? 0);
  const cacheWriteTokens = Number(cacheWriteRaw ?? 0);

  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(Number.isFinite)) {
    return undefined;
  }

  const totalTokensRaw = usage.total_tokens ?? usage.totalTokens;
  const totalTokens = Number.isFinite(Number(totalTokensRaw)) ? Number(totalTokensRaw) : inputTokens + outputTokens;

  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0 && totalTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens
  };
}

function parseUsageFromLog(logText: string): TokenUsage | undefined {
  const lines = logText.split(/\r?\n/);
  let latest: TokenUsage | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "turn.completed" && event.usage) {
        latest = normalizeUsage(event.usage) ?? latest;
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  if (latest) return latest;

  const prettyMatch = logText.match(/\[turn\]\s+done\s+in=(\d+)\s+out=(\d+)/);
  if (prettyMatch) {
    const inputTokens = Number.parseInt(prettyMatch[1], 10);
    const outputTokens = Number.parseInt(prettyMatch[2], 10);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: inputTokens + outputTokens
    };
  }

  return undefined;
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
  const usage = parseUsageFromLog(outRaw);

  return {
    turn,
    testStatus: (testStatusMatch?.[1] as "PASS" | "FAIL" | undefined) ?? undefined,
    untestedScope: untestedMatch?.[1],
    stopTokenSeen: lastRaw.includes(STOP_TOKEN) || outRaw.includes(STOP_TOKEN),
    changedFiles: parseChangedFiles(lastRaw),
    outputPath,
    lastMessagePath,
    startedAt: outStat?.birthtime.toISOString(),
    finishedAt: lastStat.mtime.toISOString(),
    usage
  };
}

async function parseAudit(ralphDir: string, turn: number): Promise<TurnAudit | null> {
  const turnTag = `${turn}`.padStart(3, "0");
  const auditPath = path.join(ralphDir, `turn-${turnTag}.audit.last.txt`);
  const auditStdoutPath = path.join(ralphDir, `turn-${turnTag}.audit.stdout.log`);

  try {
    const [text, auditStdout] = await Promise.all([
      fs.readFile(auditPath, "utf8"),
      fs.readFile(auditStdoutPath, "utf8").catch(() => "")
    ]);
    const score = parseNumberToken(text, "AUDIT_SCORE");
    const confidence = parseNumberToken(text, "AUDIT_CONFIDENCE");
    const verdictMatch = text.match(/^AUDIT_VERDICT:\s*(PASS|FAIL)\s*$/m);
    const axisIssuesMatch = text.match(/Audit axis threshold status[^\n]*FAIL\s*\(([^)]+)\)/m);
    const usage = parseUsageFromLog(auditStdout);

    return {
      turn,
      score,
      confidence,
      verdict: (verdictMatch?.[1] as "PASS" | "FAIL" | undefined) ?? undefined,
      axisScores: parseAxisScores(text),
      thresholdIssues: axisIssuesMatch?.[1],
      usage
    };
  } catch {
    return null;
  }
}

function sumUsage(items: Array<{ usage?: TokenUsage }>): TokenUsage {
  return items.reduce<TokenUsage>(
    (acc, item) => {
      const usage = item.usage;
      if (!usage) return acc;
      acc.inputTokens += usage.inputTokens;
      acc.outputTokens += usage.outputTokens;
      acc.cacheReadTokens += usage.cacheReadTokens;
      acc.cacheWriteTokens += usage.cacheWriteTokens;
      acc.totalTokens += usage.totalTokens;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0
    }
  );
}

function estimateCostUsd(
  usage: TokenUsage,
  inputCostPer1M?: number,
  outputCostPer1M?: number
): number | undefined {
  if (typeof inputCostPer1M !== "number" || typeof outputCostPer1M !== "number") {
    return undefined;
  }
  const inputCost = (usage.inputTokens / 1_000_000) * inputCostPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * outputCostPer1M;
  return Number((inputCost + outputCost).toFixed(6));
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

export async function scanRepo(targetRepo: string, pricing: ScanPricing = {}): Promise<RunSnapshot> {
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
  const mainUsage = sumUsage(turns);
  const auditUsage = sumUsage(audits);
  const combinedUsage: TokenUsage = {
    inputTokens: mainUsage.inputTokens + auditUsage.inputTokens,
    outputTokens: mainUsage.outputTokens + auditUsage.outputTokens,
    cacheReadTokens: mainUsage.cacheReadTokens + auditUsage.cacheReadTokens,
    cacheWriteTokens: mainUsage.cacheWriteTokens + auditUsage.cacheWriteTokens,
    totalTokens: mainUsage.totalTokens + auditUsage.totalTokens
  };
  const mainCost = estimateCostUsd(mainUsage, pricing.mainInputCostPer1M, pricing.mainOutputCostPer1M);
  const auditCost = estimateCostUsd(
    auditUsage,
    pricing.auditInputCostPer1M ?? pricing.mainInputCostPer1M,
    pricing.auditOutputCostPer1M ?? pricing.mainOutputCostPer1M
  );
  const totalCost = typeof mainCost === "number" && typeof auditCost === "number" ? Number((mainCost + auditCost).toFixed(6)) : undefined;

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
      doneDetected: turns.some((turn) => turn.stopTokenSeen),
      mainInputTokens: mainUsage.inputTokens,
      mainOutputTokens: mainUsage.outputTokens,
      mainCacheReadTokens: mainUsage.cacheReadTokens,
      mainCacheWriteTokens: mainUsage.cacheWriteTokens,
      auditInputTokens: auditUsage.inputTokens,
      auditOutputTokens: auditUsage.outputTokens,
      auditCacheReadTokens: auditUsage.cacheReadTokens,
      auditCacheWriteTokens: auditUsage.cacheWriteTokens,
      totalInputTokens: combinedUsage.inputTokens,
      totalOutputTokens: combinedUsage.outputTokens,
      totalCacheReadTokens: combinedUsage.cacheReadTokens,
      totalCacheWriteTokens: combinedUsage.cacheWriteTokens,
      totalTokens: combinedUsage.totalTokens,
      ...(typeof totalCost === "number" ? { estimatedCostUsd: totalCost } : {}),
      ...(typeof mainCost === "number" ? { estimatedMainCostUsd: mainCost } : {}),
      ...(typeof auditCost === "number" ? { estimatedAuditCostUsd: auditCost } : {})
    }
  };
}
