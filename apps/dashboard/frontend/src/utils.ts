import type { ForgeRun, ForgeRunStatus } from "./types";

export const lanes = [
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
  { id: "in_review", label: "In Review" },
  { id: "in_progress", label: "In Progress" },
  { id: "backlog", label: "Backlog" },
  { id: "canceled", label: "Canceled" }
] as const;

export type LaneId = (typeof lanes)[number]["id"];

export function repoName(repoPath: string): string {
  const parts = repoPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

export function compactText(value: string | undefined, max = 160): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

export function statusBucket(status: ForgeRunStatus): Exclude<LaneId, "all"> {
  if (status === "completed") return "done";
  if (status === "paused") return "in_review";
  if (status === "running" || status === "aborting") return "in_progress";
  if (status === "queued") return "backlog";
  return "canceled";
}

export function statusOrder(status: ForgeRunStatus): number {
  const bucket = statusBucket(status);
  const rank = { in_progress: 0, in_review: 1, backlog: 2, done: 3, canceled: 4 } as const;
  return rank[bucket];
}

export function runSummary(run: ForgeRun): string {
  return run.taskText || (run.specFile ? `Run spec: ${run.specFile}` : "No run message provided.");
}

export function formatInt(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
}

export function formatUsd(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "-";
}

export function laneCounts(runs: ForgeRun[]): Record<LaneId, number> {
  const counts: Record<LaneId, number> = {
    all: runs.length,
    done: 0,
    in_review: 0,
    in_progress: 0,
    backlog: 0,
    canceled: 0
  };
  for (const run of runs) {
    counts[statusBucket(run.status)] += 1;
  }
  return counts;
}

export function runStatusClass(status: ForgeRunStatus): string {
  return status.replace("_", "-");
}

export function sortRuns(runs: ForgeRun[], mode: "updated_desc" | "created_desc" | "created_asc" | "status"): ForgeRun[] {
  const sorted = [...runs];
  sorted.sort((a, b) => {
    if (mode === "created_desc") return (b.createdAt || "").localeCompare(a.createdAt || "");
    if (mode === "created_asc") return (a.createdAt || "").localeCompare(b.createdAt || "");
    if (mode === "status") {
      const rank = statusOrder(a.status) - statusOrder(b.status);
      if (rank !== 0) return rank;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    }
    return (b.updatedAt || "").localeCompare(a.updatedAt || "");
  });
  return sorted;
}
