export interface AuditAxisScores {
  code_quality?: number;
  succinct_implementation?: number;
  correctness_logic?: number;
  performance_optimizations?: number;
  modularity_abstractions?: number;
  test_rigor_evidence?: number;
  security_tenant_isolation?: number;
  reliability_failure_semantics?: number;
  spec_product_fidelity?: number;
  operational_readiness?: number;
}

export interface TurnAudit {
  turn: number;
  score?: number;
  confidence?: number;
  verdict?: "PASS" | "FAIL";
  axisScores: AuditAxisScores;
  thresholdIssues?: string;
}

export interface TurnSummary {
  turn: number;
  testStatus?: "PASS" | "FAIL";
  untestedScope?: string;
  stopTokenSeen: boolean;
  changedFiles: string[];
  outputPath: string;
  lastMessagePath: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DagNode {
  id: string;
  label: string;
  kind: "turn" | "audit" | "repo";
  status?: string;
}

export interface DagEdge {
  from: string;
  to: string;
  label?: string;
}

export interface RepoState {
  path: string;
  hasGit: boolean;
  gitBranch?: string;
  dirty?: boolean;
}

export interface RunSnapshot {
  runId: string;
  generatedAt: string;
  targetRepo: string;
  turns: TurnSummary[];
  audits: TurnAudit[];
  nodes: DagNode[];
  edges: DagEdge[];
  repo: RepoState;
  metrics: {
    turnCount: number;
    auditCount: number;
    latestTurn?: number;
    latestAuditScore?: number;
    doneDetected: boolean;
  };
}
