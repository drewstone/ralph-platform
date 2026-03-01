import type { CreateRunPayload, DashboardState, RunDetails, WorkspaceOpenTarget, WorkspaceSnapshot } from "./types";

async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || `request failed: ${response.status}`);
  }
  return data;
}

export async function fetchDashboardState(repo?: string): Promise<DashboardState> {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  return request<DashboardState>(params.size ? `/api/state?${params.toString()}` : "/api/state");
}

export async function fetchWorkspaceSnapshot(repo?: string): Promise<WorkspaceSnapshot> {
  const params = new URLSearchParams();
  if (repo) params.set("repo", repo);
  return request<WorkspaceSnapshot>(params.size ? `/api/workspace?${params.toString()}` : "/api/workspace");
}

export async function fetchWorkspaceDiff(repo: string, file: string): Promise<{ repo: string; file: string; diff: string }> {
  const params = new URLSearchParams();
  params.set("repo", repo);
  params.set("file", file);
  return request<{ repo: string; file: string; diff: string }>(`/api/workspace/diff?${params.toString()}`);
}

export async function openWorkspaceTarget(repo: string, target: WorkspaceOpenTarget): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/workspace/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, target })
  });
}

export async function fetchRunDetails(runId: string): Promise<RunDetails> {
  return request<RunDetails>(`/api/forge/runs/${encodeURIComponent(runId)}?limit=320&logLines=420`);
}

export async function queueRun(payload: CreateRunPayload): Promise<{ run: { runId: string; repo: string } }> {
  return request<{ run: { runId: string; repo: string } }>("/api/forge/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function runAction(runId: string, action: "pause" | "resume" | "abort" | "retry" | "refresh"): Promise<void> {
  if (action === "refresh") return;
  await request(`/api/forge/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST"
  });
}

export async function deleteRun(runId: string): Promise<void> {
  await request(`/api/forge/runs/${encodeURIComponent(runId)}`, {
    method: "DELETE"
  });
}

export function openSignalSocket(onSignal: () => void): () => void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.onmessage = () => onSignal();
  return () => socket.close();
}
