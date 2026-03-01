export type ForgeRunStatus = "queued" | "running" | "paused" | "aborting" | "aborted" | "failed" | "completed";

export interface ForgeRun {
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
}

export interface ForgeEvent {
  id: number;
  runId: string;
  createdAt: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ForgeState {
  activeRunId: string | null;
  queue: string[];
  runs: ForgeRun[];
}

export interface SnapshotMetrics {
  latestTurn?: number;
  turnCount?: number;
  latestAuditScore?: number;
  auditCount?: number;
  totalTokens?: number;
  totalInputTokens?: number;
  estimatedCostUsd?: number;
  estimatedMainCostUsd?: number;
  doneDetected?: boolean;
}

export interface RunSnapshot {
  repo: string;
  gitBranch?: string;
  metrics?: SnapshotMetrics;
}

export interface DashboardState {
  selectedRepo: string;
  defaultRepo: string;
  knownRepos: string[];
  snapshot: RunSnapshot;
  history: Array<unknown>;
  forge: ForgeState;
  stateError?: string;
}

export interface RunDetails {
  run: ForgeRun;
  events: ForgeEvent[];
  logTail: string[];
}

export interface CreateRunPayload {
  repo: string;
  specFile?: string;
  taskText?: string;
  branchName?: string;
  baseBranch?: string;
  worktree?: boolean;
  openPr?: boolean;
  noPush?: boolean;
  loopArgs?: string[];
}

export interface WorkspaceFileEntry {
  path: string;
  status: string;
}

export interface WorkspaceSnapshot {
  repo: string;
  branch: string;
  changedFiles: WorkspaceFileEntry[];
  remoteUrl?: string;
  remoteSlug?: string;
  gitUser?: string;
}

export type WorkspaceOpenTarget = "finder" | "cursor" | "vscode" | "xcode" | "warp" | "terminal" | "copy_path";
