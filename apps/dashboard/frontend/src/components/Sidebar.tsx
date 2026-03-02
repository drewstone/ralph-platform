import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import {
  Archive,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleSlash2,
  ClipboardList,
  Clock3,
  FolderGit2,
  Layers,
  Plus,
  SearchCheck
} from "lucide-react";
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
  archivedChats: Record<string, boolean>;
  repoFilter: string;
  onRepoFilterChange: (value: string) => void;
  selectedScope: string;
  activeLane: LaneId;
  onScopeSelect: (scope: string) => void;
  onLaneSelect: (lane: LaneId) => void;
  onRunSelect: (run: ForgeRun) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleChatArchive: (scope: string) => void;
  onAddWorkspace: () => void;
}

interface LaneWorkspaceCard {
  repo: string;
  branch: string;
  runCount: number;
  latestRun: ForgeRun;
}

const laneMeta: Record<
  LaneId,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; iconClass: string; badgeVariant: "secondary" | "success" | "warning" | "danger" }
> = {
  all: {
    icon: Layers,
    iconClass: "text-slate-500 dark:text-slate-300",
    badgeVariant: "secondary"
  },
  done: {
    icon: CheckCircle2,
    iconClass: "text-emerald-600 dark:text-emerald-400",
    badgeVariant: "success"
  },
  in_review: {
    icon: SearchCheck,
    iconClass: "text-amber-600 dark:text-amber-400",
    badgeVariant: "warning"
  },
  in_progress: {
    icon: ClipboardList,
    iconClass: "text-sky-600 dark:text-sky-400",
    badgeVariant: "secondary"
  },
  backlog: {
    icon: Clock3,
    iconClass: "text-indigo-600 dark:text-indigo-400",
    badgeVariant: "secondary"
  },
  canceled: {
    icon: CircleSlash2,
    iconClass: "text-rose-600 dark:text-rose-400",
    badgeVariant: "danger"
  }
};

function repoGlyph(repo: string): string {
  return repoName(repo).slice(0, 1).toUpperCase() || "?";
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
  archivedChats,
  repoFilter,
  onRepoFilterChange,
  selectedScope,
  activeLane,
  onScopeSelect,
  onLaneSelect,
  onRunSelect,
  collapsed,
  onToggleCollapsed,
  onToggleChatArchive,
  onAddWorkspace
}: SidebarProps) {
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState(true);
  const [lanesSectionOpen, setLanesSectionOpen] = useState(true);
  const [showAllWorkspaces, setShowAllWorkspaces] = useState(false);

  const counts = laneCounts(runs);

  const filteredWorkspaces = useMemo(
    () =>
      workspaces.filter((repo) => {
        const query = repoFilter.trim().toLowerCase();
        if (!query) return true;
        return repo.toLowerCase().includes(query) || repoName(repo).toLowerCase().includes(query);
      }),
    [repoFilter, workspaces]
  );

  const runCountByRepo = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.repo] = (acc[run.repo] || 0) + 1;
    return acc;
  }, {});

  const activeRepos = new Set(runs.map((run) => run.repo));
  const visibleWorkspaces = showAllWorkspaces
    ? filteredWorkspaces
    : filteredWorkspaces.filter((repo) => activeRepos.has(repo) || selectedScope === repo);

  const archiveFilteredWorkspaces = showAllWorkspaces
    ? visibleWorkspaces
    : visibleWorkspaces.filter((repo) => !archivedChats[repo] || selectedScope === repo);

  const compactWorkspaces = archiveFilteredWorkspaces.slice(0, 8);

  if (collapsed) {
    return (
      <aside className="flex h-full w-[84px] flex-col border-r border-border/70 bg-card/85">
        <div className="border-b border-border/70 p-2.5">
          <div className="flex flex-col items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <BriefcaseBusiness className="h-5 w-5" />
            </div>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={onToggleCollapsed} title="Expand sidebar">
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl" onClick={onAddWorkspace} title="Add workspace">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <ScrollArea className="h-full">
          <div className="flex flex-col items-center gap-3 py-3">
            <button
              type="button"
              title="All repositories"
              onClick={() => onScopeSelect("__all__")}
              className={cn(
                "flex h-10 w-10 items-center justify-center rounded-xl border border-transparent bg-muted/40 font-mono text-xs transition",
                selectedScope === "__all__" && "border-primary/40 bg-primary/15 text-primary"
              )}
            >
              *
            </button>

            {compactWorkspaces.map((repo) => (
              <button
                key={repo}
                type="button"
                title={repoName(repo)}
                onClick={() => onScopeSelect(repo)}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl border border-transparent bg-muted/40 font-mono text-xs transition",
                  selectedScope === repo && "border-primary/40 bg-primary/15 text-primary"
                )}
              >
                {repoGlyph(repo)}
              </button>
            ))}

            <div className="my-1 h-px w-8 bg-border/70" />

            {lanes.map((lane) => {
              const meta = laneMeta[lane.id];
              const Icon = meta.icon;
              return (
                <button
                  key={lane.id}
                  type="button"
                  title={lane.label}
                  onClick={() => onLaneSelect(lane.id)}
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl border border-transparent bg-muted/40 transition",
                    activeLane === lane.id && "border-primary/40 bg-primary/15"
                  )}
                >
                  <Icon className={cn("h-4.5 w-4.5", meta.iconClass)} />
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col border-r border-border/70 bg-card/85">
      <div className="border-b border-border/70 p-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <BriefcaseBusiness className="h-4 w-4" />
            </div>
            <p className="text-[1.7rem] font-bold leading-none tracking-tight">Ralph Forge</p>
          </div>

          <Button variant="ghost" size="icon" onClick={onToggleCollapsed}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-3">
          <Input value={repoFilter} onChange={(event) => onRepoFilterChange(event.currentTarget.value)} placeholder="Filter workspaces..." />
        </div>
      </div>

      <ScrollArea className="h-full">
        <div className="space-y-4 p-3">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground"
                onClick={() => setWorkspaceSectionOpen((open) => !open)}
              >
                Workspaces
                {workspaceSectionOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              <Button variant="ghost" size="icon" onClick={onAddWorkspace}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {workspaceSectionOpen && (
              <div className="space-y-2">
                <div className="flex items-start gap-1">
                  <button
                    type="button"
                    onClick={() => onScopeSelect("__all__")}
                    className={cn(
                      "flex-1 rounded-lg px-3 py-2 text-left transition",
                      selectedScope === "__all__" ? "bg-primary/10 text-foreground" : "hover:bg-muted"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs">*</span>
                        <span className="truncate text-[0.98rem] font-semibold">All repositories</span>
                      </div>
                      <Badge variant="secondary" className="h-5 min-w-[1.65rem] shrink-0 justify-center px-1.5">
                        {runs.length}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">Global execution scope</p>
                  </button>
                  {runs.length > 0 && (
                    <Button
                      type="button"
                      size="icon"
                      variant={archivedChats.__all__ ? "secondary" : "ghost"}
                      className="mt-1 h-8 w-8 shrink-0"
                      onClick={() => onToggleChatArchive("__all__")}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                {archiveFilteredWorkspaces.map((repo) => {
                  const runCount = runCountByRepo[repo] || 0;
                  const isArchived = archivedChats[repo] === true;
                  return (
                    <div key={repo} className="flex items-start gap-1">
                      <button
                        type="button"
                        onClick={() => onScopeSelect(repo)}
                        className={cn(
                          "flex-1 rounded-lg px-3 py-2 text-left transition",
                          selectedScope === repo ? "bg-primary/10 text-foreground" : "hover:bg-muted"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-xs">{repoGlyph(repo)}</span>
                            <span className="truncate text-[0.98rem] font-semibold">{repoName(repo)}</span>
                          </div>
                          <Badge variant="secondary" className="h-5 min-w-[1.65rem] shrink-0 justify-center px-1.5">
                            {runCount}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{repo}</p>
                      </button>
                      {(runCount > 0 || isArchived) && (
                        <Button
                          type="button"
                          size="icon"
                          variant={isArchived ? "secondary" : "ghost"}
                          className="mt-1 h-8 w-8 shrink-0"
                          onClick={() => onToggleChatArchive(repo)}
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}

                {archiveFilteredWorkspaces.length === 0 && <p className="px-1 text-xs text-muted-foreground">No active chats in this lane.</p>}

                {filteredWorkspaces.length > archiveFilteredWorkspaces.length && (
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                    onClick={() => setShowAllWorkspaces((value) => !value)}
                  >
                    {showAllWorkspaces ? "Show active chats only" : `Show all workspaces (${filteredWorkspaces.length})`}
                  </button>
                )}
              </div>
            )}
          </section>

          <section>
            <button
              type="button"
              className="mb-2 flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground"
              onClick={() => setLanesSectionOpen((open) => !open)}
            >
              Status Lanes
              {lanesSectionOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {lanesSectionOpen && (
              <div className="space-y-2">
                {lanes.map((lane) => {
                  const laneRuns = lane.id === "all" ? runs : runs.filter((run) => statusBucket(run.status) === lane.id);
                  const grouped = lane.id === "all" ? [] : groupLaneWorkspaces(laneRuns);
                  const meta = laneMeta[lane.id];
                  const Icon = meta.icon;

                  return (
                    <div key={lane.id} className="space-y-2">
                      <button
                        type="button"
                        onClick={() => onLaneSelect(lane.id)}
                        className={cn(
                          "w-full rounded-lg px-3 py-2 text-left transition",
                          activeLane === lane.id ? "bg-primary/10 text-foreground" : "hover:bg-muted"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs">
                              <Icon className={cn("h-3.5 w-3.5", meta.iconClass)} />
                            </span>
                            <span className="truncate text-base font-semibold">{lane.label}</span>
                          </div>
                          <Badge variant={meta.badgeVariant} className="h-5 min-w-[1.65rem] shrink-0 justify-center px-1.5">
                            {counts[lane.id]}
                          </Badge>
                        </div>
                      </button>

                      {lane.id !== "all" && grouped.length > 0 && (
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
                                "w-full rounded-md px-2.5 py-2 text-left transition",
                                selectedScope === item.repo && activeLane === lane.id ? "bg-accent" : "hover:bg-muted"
                              )}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-xs">{repoGlyph(item.repo)}</span>
                                  <span className="truncate text-xs font-semibold">{repoName(item.repo)}</span>
                                </div>
                                <Badge variant="secondary" className="h-5 min-w-[1.65rem] shrink-0 justify-center px-1.5 text-xs">
                                  {item.runCount}
                                </Badge>
                              </div>
                              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.branch}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3">
        <Button variant="outline" className="w-full justify-start gap-2" onClick={onAddWorkspace}>
          <FolderGit2 className="h-4 w-4" />
          Add workspace
        </Button>
      </div>
    </aside>
  );
}
