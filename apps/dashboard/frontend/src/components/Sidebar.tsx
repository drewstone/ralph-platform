import { BriefcaseBusiness, ChevronLeft, ChevronRight, FolderGit2, Layers, Plus } from "lucide-react";
import { lanes, laneCounts, repoName, statusBucket, type LaneId } from "../utils";
import type { ForgeRun } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface SidebarProps {
  workspaces: string[];
  runs: ForgeRun[];
  repoFilter: string;
  onRepoFilterChange: (value: string) => void;
  selectedScope: string;
  activeLane: LaneId;
  onScopeSelect: (scope: string) => void;
  onLaneSelect: (lane: LaneId) => void;
  onRunSelect: (run: ForgeRun) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onAddWorkspace: () => void;
}

interface LaneWorkspaceCard {
  repo: string;
  branch: string;
  runCount: number;
  latestRun: ForgeRun;
}

function repoGlyph(repo: string): string {
  return repoName(repo).slice(0, 1).toUpperCase() || "?";
}

function laneBadgeVariant(laneId: LaneId): "secondary" | "success" | "warning" | "danger" {
  if (laneId === "done") return "success";
  if (laneId === "in_review") return "warning";
  if (laneId === "canceled") return "danger";
  return "secondary";
}

function groupLaneWorkspaces(runs: ForgeRun[]): LaneWorkspaceCard[] {
  const map = new Map<string, LaneWorkspaceCard>();

  for (const run of runs) {
    const branch = run.branchName || run.baseBranch || "(no branch)";
    const key = `${run.repo}::${branch}`;
    const current = map.get(key);

    if (!current) {
      map.set(key, { repo: run.repo, branch, runCount: 1, latestRun: run });
      continue;
    }

    current.runCount += 1;
    if ((run.updatedAt || "").localeCompare(current.latestRun.updatedAt || "") > 0) {
      current.latestRun = run;
    }
  }

  return [...map.values()].sort((a, b) => (b.latestRun.updatedAt || "").localeCompare(a.latestRun.updatedAt || ""));
}

export function Sidebar({
  workspaces,
  runs,
  repoFilter,
  onRepoFilterChange,
  selectedScope,
  activeLane,
  onScopeSelect,
  onLaneSelect,
  onRunSelect,
  collapsed,
  onToggleCollapsed,
  onAddWorkspace
}: SidebarProps) {
  const counts = laneCounts(runs);

  const filteredWorkspaces = workspaces.filter((repo) => {
    const query = repoFilter.trim().toLowerCase();
    if (!query) return true;
    return repo.toLowerCase().includes(query) || repoName(repo).toLowerCase().includes(query);
  });

  const runCountByRepo = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.repo] = (acc[run.repo] || 0) + 1;
    return acc;
  }, {});

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-border bg-card/80 backdrop-blur",
        collapsed ? "w-[84px]" : "w-full"
      )}
    >
      <div className="border-b border-border p-3">
        <div className={cn("flex items-start", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && (
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <BriefcaseBusiness className="h-4 w-4" />
              </div>
              <div>
                <p className="text-xl font-semibold leading-none tracking-tight">Ralph Forge</p>
                <p className="mt-1 text-[11px] text-muted-foreground">workspaces + chat runs</p>
              </div>
            </div>
          )}

          <Button variant="ghost" size="icon" onClick={onToggleCollapsed}>
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>

        {!collapsed && (
          <div className="mt-3">
            <Input value={repoFilter} onChange={(event) => onRepoFilterChange(event.currentTarget.value)} placeholder="Filter workspaces..." />
          </div>
        )}
      </div>

      <ScrollArea className="h-full">
        <div className="space-y-4 p-3">
          <section>
            <div className={cn("mb-2 flex items-center", collapsed ? "justify-center" : "justify-between")}>
              {!collapsed && <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Workspaces</p>}
              <Button variant="ghost" size="icon" onClick={onAddWorkspace}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => onScopeSelect("__all__")}
                className={cn(
                  "w-full rounded-xl border px-3 py-2 text-left transition",
                  selectedScope === "__all__" ? "border-primary/50 bg-primary/10" : "border-border bg-background hover:bg-muted"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted font-mono text-[11px]">*</span>
                    {!collapsed && <span className="text-sm font-semibold">All repositories</span>}
                  </div>
                  {!collapsed && <Badge variant="secondary">{runs.length}</Badge>}
                </div>
                {!collapsed && <p className="mt-1 text-[11px] text-muted-foreground">Global execution scope</p>}
              </button>

              {filteredWorkspaces.map((repo) => (
                <button
                  key={repo}
                  type="button"
                  onClick={() => onScopeSelect(repo)}
                  className={cn(
                    "w-full rounded-xl border px-3 py-2 text-left transition",
                    selectedScope === repo ? "border-primary/50 bg-primary/10" : "border-border bg-background hover:bg-muted"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[11px]">{repoGlyph(repo)}</span>
                      {!collapsed && <span className="truncate text-sm font-semibold">{repoName(repo)}</span>}
                    </div>
                    {!collapsed && <Badge variant="secondary">{runCountByRepo[repo] || 0}</Badge>}
                  </div>
                  {!collapsed && <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{repo}</p>}
                </button>
              ))}
            </div>
          </section>

          <section>
            {!collapsed && <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Status Lanes</p>}

            <div className="space-y-2">
              {lanes.map((lane) => {
                const laneRuns = lane.id === "all" ? runs : runs.filter((run) => statusBucket(run.status) === lane.id);
                const grouped = lane.id === "all" ? [] : groupLaneWorkspaces(laneRuns);

                return (
                  <div key={lane.id} className="space-y-2">
                    <button
                      type="button"
                      onClick={() => onLaneSelect(lane.id)}
                      className={cn(
                        "w-full rounded-xl border px-3 py-2 text-left transition",
                        activeLane === lane.id ? "border-primary/50 bg-primary/10" : "border-border bg-background hover:bg-muted"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-xs">
                            <Layers className="h-3.5 w-3.5" />
                          </span>
                          {!collapsed && <span className="text-sm font-semibold">{lane.label}</span>}
                        </div>
                        {!collapsed && <Badge variant={laneBadgeVariant(lane.id)}>{counts[lane.id]}</Badge>}
                      </div>
                    </button>

                    {!collapsed && lane.id !== "all" && grouped.length > 0 && (
                      <div className="space-y-1 pl-4">
                        {grouped.slice(0, 6).map((item) => (
                          <button
                            key={`${lane.id}-${item.repo}-${item.branch}`}
                            type="button"
                            onClick={() => {
                              onScopeSelect(item.repo);
                              onLaneSelect(lane.id);
                              onRunSelect(item.latestRun);
                            }}
                            className={cn(
                              "w-full rounded-lg border px-2.5 py-2 text-left transition",
                              selectedScope === item.repo && activeLane === lane.id
                                ? "border-primary/50 bg-accent"
                                : "border-border bg-background hover:bg-muted"
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px]">{repoGlyph(item.repo)}</span>
                                <span className="truncate text-xs font-semibold">{repoName(item.repo)}</span>
                              </div>
                              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                {item.runCount}
                              </Badge>
                            </div>
                            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{item.branch}</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </ScrollArea>

      {!collapsed && (
        <div className="border-t border-border p-3">
          <Button variant="outline" className="w-full justify-start gap-2" onClick={onAddWorkspace}>
            <FolderGit2 className="h-4 w-4" />
            Add workspace
          </Button>
        </div>
      )}
    </aside>
  );
}
