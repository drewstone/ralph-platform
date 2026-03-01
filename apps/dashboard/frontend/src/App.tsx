import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Archive,
  ExternalLink,
  Menu,
  Pause,
  Play,
  RefreshCw,
  Send,
  SquarePen,
  Trash2,
  Undo2,
  XCircle
} from "lucide-react";
import {
  deleteRun,
  fetchDashboardState,
  fetchRunDetails,
  fetchWorkspaceDiff,
  fetchWorkspaceSnapshot,
  openSignalSocket,
  openWorkspaceTarget,
  queueRun,
  runAction
} from "./api";
import { RunGraph } from "./components/RunGraph";
import { Sidebar } from "./components/Sidebar";
import type { DashboardState, ForgeRun, RunDetails, WorkspaceOpenTarget, WorkspaceSnapshot } from "./types";
import { compactText, formatInt, formatUsd, lanes, repoName, runSummary, sortRuns, statusBucket, type LaneId } from "./utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type SortMode = "updated_desc" | "created_desc" | "created_asc" | "status";
type SidePanelTab = "files" | "diff" | "inspector";
type InspectorTab = "summary" | "graph" | "events" | "log" | "meta";
type BoolMap = Record<string, boolean>;
type StringMap = Record<string, string>;

function useStoredValue<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  });

  function update(next: T): void {
    setValue(next);
    window.localStorage.setItem(key, JSON.stringify(next));
  }

  return [value, update];
}

function extractPrUrl(details?: RunDetails): string | undefined {
  if (!details) return undefined;
  const text = [...details.events.map((event) => event.message), ...(details.logTail || [])].join("\n");
  const match = text.match(/https?:\/\/[^\s)]+\/pull\/\d+/i);
  return match?.[0];
}

function shortBranch(value?: string): string {
  if (!value) return "-";
  return value.split("...")[0].replace(/^##\s*/, "").trim() || value;
}

function prettyTimestamp(value?: string): string {
  if (!value) return "-";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString();
}

function mergeRepos(defaultRepo: string | undefined, pinned: string[], known: string[]): string[] {
  const ordered = [defaultRepo || "", ...pinned, ...known];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of ordered) {
    const resolved = String(repo || "").trim();
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function statusBadgeVariant(status: ForgeRun["status"]): "success" | "warning" | "danger" | "secondary" {
  const bucket = statusBucket(status);
  if (bucket === "done") return "success";
  if (bucket === "in_review") return "warning";
  if (bucket === "canceled") return "danger";
  return "secondary";
}

export function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [stateError, setStateError] = useState("");
  const [notice, setNotice] = useState("");

  const [scopeRepo, setScopeRepo] = useState("__all__");
  const [activeLane, setActiveLane] = useState<LaneId>("all");
  const [runSearch, setRunSearch] = useState("");
  const [runSort, setRunSort] = useState<SortMode>("created_asc");
  const [repoSearch, setRepoSearch] = useState("");

  const [selectedRunId, setSelectedRunId] = useState("");
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const [runDetailsById, setRunDetailsById] = useState<Record<string, RunDetails>>({});

  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>("files");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("summary");

  const [composerRepo, setComposerRepo] = useState("");
  const [composerMessage, setComposerMessage] = useState("");
  const [composerSpec, setComposerSpec] = useState("");
  const [composerBranch, setComposerBranch] = useState("");
  const [composerBaseBranch, setComposerBaseBranch] = useState("main");
  const [composerLoopArgs, setComposerLoopArgs] = useState("");
  const [showComposerAdvanced, setShowComposerAdvanced] = useState(false);
  const [composerSubmitting, setComposerSubmitting] = useState(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useStoredValue<boolean>("ralph.sidebar.collapsed", false);
  const [sidebarWidth, setSidebarWidth] = useStoredValue<number>("ralph.sidebar.width", 300);
  const [archivedChats, setArchivedChats] = useStoredValue<BoolMap>("ralph.archived.chats", {});
  const [archivedRuns, setArchivedRuns] = useStoredValue<BoolMap>("ralph.archived.runs", {});
  const [showArchivedRuns, setShowArchivedRuns] = useStoredValue<boolean>("ralph.show.archived.runs", false);
  const [pinnedWorkspaces, setPinnedWorkspaces] = useStoredValue<string[]>("ralph.pinned.workspaces", []);

  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [workspaceByRepo, setWorkspaceByRepo] = useState<Record<string, WorkspaceSnapshot>>({});
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);

  const [selectedDiffFileByRepo, setSelectedDiffFileByRepo] = useStoredValue<StringMap>("ralph.workspace.selected.diff", {});
  const [currentDiff, setCurrentDiff] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);

  const [openTarget, setOpenTarget] = useState<WorkspaceOpenTarget>("finder");
  const [openingTarget, setOpeningTarget] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspaceDraftPath, setWorkspaceDraftPath] = useState("");

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const refreshingRef = useRef(false);

  const knownRepos = useMemo(
    () => mergeRepos(dashboard?.defaultRepo, pinnedWorkspaces, dashboard?.knownRepos || []),
    [dashboard?.defaultRepo, dashboard?.knownRepos, pinnedWorkspaces]
  );

  const allRuns = dashboard?.forge.runs || [];
  const visibleRuns = useMemo(() => {
    if (showArchivedRuns) return allRuns;
    return allRuns.filter((run) => !archivedRuns[run.runId]);
  }, [allRuns, archivedRuns, showArchivedRuns]);

  const scopedRuns = useMemo(() => {
    if (scopeRepo === "__all__") return visibleRuns;
    return visibleRuns.filter((run) => run.repo === scopeRepo);
  }, [visibleRuns, scopeRepo]);

  const laneRuns = useMemo(() => {
    if (activeLane === "all") return scopedRuns;
    return scopedRuns.filter((run) => statusBucket(run.status) === activeLane);
  }, [scopedRuns, activeLane]);

  const filteredRuns = useMemo(() => {
    const query = runSearch.trim().toLowerCase();
    const searched = query
      ? laneRuns.filter((run) =>
          [run.runId, run.repo, run.taskText, run.specFile, run.branchName, run.baseBranch]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query)
        )
      : laneRuns;
    return sortRuns(searched, runSort);
  }, [laneRuns, runSearch, runSort]);

  const selectedRun = useMemo(() => visibleRuns.find((run) => run.runId === selectedRunId) || null, [visibleRuns, selectedRunId]);
  const selectedRunDetails = selectedRun ? runDetailsById[selectedRun.runId] : undefined;

  const scopeKey = scopeRepo === "__all__" ? "__all__" : scopeRepo;
  const chatArchived = archivedChats[scopeKey] === true;

  const activeRepo = selectedRun?.repo || (scopeRepo !== "__all__" ? scopeRepo : composerRepo || dashboard?.defaultRepo || knownRepos[0] || "");
  const activeWorkspace = activeRepo ? workspaceByRepo[activeRepo] : undefined;
  const selectedDiffFile = activeRepo ? selectedDiffFileByRepo[activeRepo] || "" : "";

  const canInspect = Boolean(selectedRun || dashboard?.forge.activeRunId);

  useEffect(() => {
    if (sidePanelTab === "inspector" && !canInspect) {
      setSidePanelTab("files");
    }
  }, [sidePanelTab, canInspect]);

  useEffect(() => {
    if (!selectedRunId && filteredRuns.length > 0) {
      setSelectedRunId(filteredRuns[0].runId);
    }
    if (filteredRuns.length === 0) {
      setSelectedRunId("");
    }
  }, [filteredRuns, selectedRunId]);

  useEffect(() => {
    if (!selectedRun) return;
    if (runDetailsById[selectedRun.runId]) return;
    void loadRunDetails(selectedRun.runId);
  }, [selectedRun, runDetailsById]);

  useEffect(() => {
    if (!dashboard) return;
    if (scopeRepo === "__all__") {
      if (!composerRepo) {
        setComposerRepo(dashboard.defaultRepo || "");
      }
      return;
    }
    if (composerRepo !== scopeRepo) {
      setComposerRepo(scopeRepo);
    }
  }, [dashboard?.defaultRepo, scopeRepo]);

  useEffect(() => {
    if (!resizingSidebar) return;

    function onMouseMove(event: MouseEvent): void {
      setSidebarWidth(Math.max(260, Math.min(480, event.clientX)));
    }

    function onMouseUp(): void {
      setResizingSidebar(false);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizingSidebar, setSidebarWidth]);

  useEffect(() => {
    void refreshState();
    const interval = window.setInterval(() => {
      void refreshState();
    }, 5000);

    const close = openSignalSocket(() => {
      void refreshState();
    });

    return () => {
      close();
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!activeRepo) return;
    void refreshWorkspace(activeRepo);
  }, [activeRepo]);

  useEffect(() => {
    if (!activeRepo || !selectedDiffFile) {
      setCurrentDiff("");
      return;
    }

    let cancelled = false;

    async function loadDiff(): Promise<void> {
      setDiffLoading(true);
      try {
        const response = await fetchWorkspaceDiff(activeRepo, selectedDiffFile);
        if (!cancelled) {
          setCurrentDiff(response.diff || "No diff available.");
        }
      } catch (error) {
        if (!cancelled) {
          setCurrentDiff(error instanceof Error ? error.message : "Failed to load diff");
        }
      } finally {
        if (!cancelled) {
          setDiffLoading(false);
        }
      }
    }

    void loadDiff();

    return () => {
      cancelled = true;
    };
  }, [activeRepo, selectedDiffFile]);

  async function refreshState(): Promise<void> {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const repo = scopeRepo !== "__all__" ? scopeRepo : undefined;
      const nextState = await fetchDashboardState(repo);
      setDashboard(nextState);
      setStateError(nextState.stateError || "");
      if (scopeRepo !== "__all__" && !mergeRepos(nextState.defaultRepo, pinnedWorkspaces, nextState.knownRepos).includes(scopeRepo)) {
        setScopeRepo("__all__");
      }
    } catch (error) {
      setStateError(error instanceof Error ? error.message : "Failed to load state");
    } finally {
      refreshingRef.current = false;
    }
  }

  async function refreshWorkspace(repo: string): Promise<void> {
    setWorkspaceLoading(true);
    try {
      const snapshot = await fetchWorkspaceSnapshot(repo);
      setWorkspaceByRepo((current) => ({ ...current, [repo]: snapshot }));
      setWorkspaceError("");

      const firstFile = snapshot.changedFiles[0]?.path || "";
      const currentSelected = selectedDiffFileByRepo[repo] || "";
      const stillExists = snapshot.changedFiles.some((file) => file.path === currentSelected);
      if (!currentSelected || !stillExists) {
        setSelectedDiffFileByRepo({ ...selectedDiffFileByRepo, [repo]: firstFile });
      }
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Failed to load workspace");
    } finally {
      setWorkspaceLoading(false);
    }
  }

  async function loadRunDetails(runId: string, force = false): Promise<void> {
    if (!force && runDetailsById[runId]) return;
    try {
      const details = await fetchRunDetails(runId);
      setRunDetailsById((current) => ({ ...current, [runId]: details }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load run details");
    }
  }

  async function handleRunAction(run: ForgeRun, action: "pause" | "resume" | "abort" | "retry" | "refresh"): Promise<void> {
    if (action === "refresh") {
      await loadRunDetails(run.runId, true);
      await refreshState();
      await refreshWorkspace(run.repo);
      return;
    }
    try {
      await runAction(run.runId, action);
      await refreshState();
      await loadRunDetails(run.runId, true);
      await refreshWorkspace(run.repo);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Failed action: ${action}`);
    }
  }

  async function handleDeleteRun(run: ForgeRun): Promise<void> {
    if (!window.confirm(`Delete run ${run.runId}?`)) {
      return;
    }
    try {
      await deleteRun(run.runId);
      setRunDetailsById((current) => {
        const next = { ...current };
        delete next[run.runId];
        return next;
      });
      setExpandedRunIds((current) => {
        const next = new Set(current);
        next.delete(run.runId);
        return next;
      });
      if (selectedRunId === run.runId) {
        setSelectedRunId("");
      }
      setNotice(`Deleted run ${run.runId}`);
      await refreshState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to delete run");
    }
  }

  function toggleRunExpanded(runId: string): void {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  }

  function continueFromRun(run: ForgeRun): void {
    setComposerRepo(run.repo);
    setComposerBranch(run.branchName || "");
    setComposerBaseBranch(run.baseBranch || "main");
    setComposerMessage(`Continue from run ${run.runId}: `);
    setShowComposerAdvanced(true);
    composerRef.current?.focus();
  }

  function toggleChatArchive(): void {
    setArchivedChats({ ...archivedChats, [scopeKey]: !chatArchived });
  }

  function toggleRunArchive(runId: string): void {
    const next = { ...archivedRuns };
    if (next[runId]) {
      delete next[runId];
    } else {
      next[runId] = true;
    }
    setArchivedRuns(next);
  }

  function selectDiffFile(filePath: string): void {
    if (!activeRepo) return;
    setSelectedDiffFileByRepo({ ...selectedDiffFileByRepo, [activeRepo]: filePath });
  }

  async function submitComposer(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (chatArchived) {
      setNotice("This chat is archived. Reopen it to send a run message.");
      return;
    }

    const repo = (scopeRepo === "__all__" ? composerRepo : scopeRepo).trim();
    if (!repo) {
      setNotice("Pick or enter a workspace repo path.");
      return;
    }

    if (!composerMessage.trim() && !composerSpec.trim()) {
      setNotice("Enter a run message or spec file.");
      return;
    }

    setComposerSubmitting(true);
    try {
      const queued = await queueRun({
        repo,
        ...(composerMessage.trim() ? { taskText: composerMessage.trim() } : {}),
        ...(composerSpec.trim() ? { specFile: composerSpec.trim() } : {}),
        ...(composerBranch.trim() ? { branchName: composerBranch.trim() } : {}),
        ...(composerBaseBranch.trim() ? { baseBranch: composerBaseBranch.trim() } : {}),
        ...(composerLoopArgs.trim()
          ? {
              loopArgs: composerLoopArgs
                .trim()
                .split(/\s+/)
                .filter(Boolean)
            }
          : {}),
        worktree: true,
        openPr: false,
        noPush: false
      });

      if (!knownRepos.includes(repo)) {
        setPinnedWorkspaces([repo, ...pinnedWorkspaces.filter((item) => item !== repo)]);
      }

      setSelectedRunId(queued.run.runId);
      setExpandedRunIds(new Set([queued.run.runId]));
      setComposerMessage("");
      setComposerSpec("");
      setNotice(`Queued run ${queued.run.runId}`);
      await refreshState();
      await refreshWorkspace(repo);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to queue run");
    } finally {
      setComposerSubmitting(false);
    }
  }

  async function openInTarget(): Promise<void> {
    if (!activeRepo) {
      setNotice("Choose a workspace repo first.");
      return;
    }

    setOpeningTarget(true);
    try {
      await openWorkspaceTarget(activeRepo, openTarget);
      setNotice(openTarget === "copy_path" ? "Copied repo path" : `Opened in ${openTarget}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to open target");
    } finally {
      setOpeningTarget(false);
    }
  }

  function addWorkspace(repoPath: string): void {
    const repo = String(repoPath || "").trim();
    if (!repo) return;

    const next = [repo, ...pinnedWorkspaces.filter((item) => item !== repo)];
    setPinnedWorkspaces(next);
    setScopeRepo(repo);
    setComposerRepo(repo);
    setNotice(`Added workspace ${repoName(repo)}`);
    void refreshState();
  }

  function submitWorkspaceDialog(): void {
    const repo = workspaceDraftPath.trim();
    if (!repo) {
      setNotice("Workspace path is required.");
      return;
    }
    addWorkspace(repo);
    setWorkspaceDraftPath("");
    setWorkspaceDialogOpen(false);
  }

  const laneLabel = lanes.find((lane) => lane.id === activeLane)?.label || "All";
  const layoutStyle = { "--sidebar-w": `${sidebarWidth}px` } as CSSProperties;

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background">
      <div className="h-full md:grid md:grid-cols-[var(--sidebar-w)_8px_minmax(0,1fr)]" style={layoutStyle}>
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-40 w-[min(92vw,380px)] border-r bg-card transition-transform md:static md:w-auto md:translate-x-0",
            mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <Sidebar
            workspaces={knownRepos}
            runs={visibleRuns}
            repoFilter={repoSearch}
            onRepoFilterChange={setRepoSearch}
            selectedScope={scopeRepo}
            activeLane={activeLane}
            onScopeSelect={(scope) => {
              setScopeRepo(scope);
              setActiveLane("all");
              setMobileSidebarOpen(false);
            }}
            onLaneSelect={setActiveLane}
            onRunSelect={(run) => {
              setScopeRepo(run.repo);
              setSelectedRunId(run.runId);
              setExpandedRunIds((current) => new Set([...current, run.runId]));
              setSidePanelTab("inspector");
              setMobileSidebarOpen(false);
            }}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
            onAddWorkspace={() => {
              setWorkspaceDraftPath(scopeRepo !== "__all__" ? scopeRepo : "");
              setWorkspaceDialogOpen(true);
            }}
          />
        </div>

        <div
          className="hidden cursor-col-resize bg-gradient-to-b from-transparent via-border to-transparent md:block"
          onMouseDown={() => {
            if (!sidebarCollapsed) setResizingSidebar(true);
          }}
        />

        <main className="flex min-h-0 flex-col">
          <header className="border-b bg-background/90 px-4 py-2.5 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" className="md:hidden" onClick={() => setMobileSidebarOpen(true)}>
                    <Menu className="h-4 w-4" />
                  </Button>
                  <h1 className="text-xl font-semibold tracking-tight">Run Chat</h1>
                  <Badge variant="outline" className="hidden sm:inline-flex">
                    {laneLabel}
                  </Badge>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {(activeRepo ? repoName(activeRepo) : "No workspace")} · {shortBranch(activeWorkspace?.branch)} · {activeWorkspace?.remoteSlug || "-"} · {activeWorkspace?.gitUser || "-"}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Select
                  value={scopeRepo}
                  onValueChange={(value) => {
                    setScopeRepo(value);
                    setActiveLane("all");
                  }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Scope" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">All repositories</SelectItem>
                    {knownRepos.map((repo) => (
                      <SelectItem key={repo} value={repo}>
                        {repoName(repo)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={openTarget} onValueChange={(value) => setOpenTarget(value as WorkspaceOpenTarget)}>
                  <SelectTrigger className="w-[156px]">
                    <SelectValue placeholder="Open target" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="finder">Open in Finder</SelectItem>
                    <SelectItem value="cursor">Open in Cursor</SelectItem>
                    <SelectItem value="vscode">Open in VS Code</SelectItem>
                    <SelectItem value="xcode">Open in Xcode</SelectItem>
                    <SelectItem value="warp">Open in Warp</SelectItem>
                    <SelectItem value="terminal">Open in Terminal</SelectItem>
                    <SelectItem value="copy_path">Copy path</SelectItem>
                  </SelectContent>
                </Select>

                <Button variant="outline" onClick={() => void openInTarget()} disabled={openingTarget}>
                  <ExternalLink className="h-4 w-4" />
                  <span className="hidden sm:inline">{openingTarget ? "Opening" : "Open"}</span>
                </Button>

                <Button variant="outline" onClick={toggleChatArchive}>
                  <Archive className="h-4 w-4" />
                  <span className="hidden sm:inline">{chatArchived ? "Reopen" : "Archive"}</span>
                </Button>

                <Button
                  onClick={() => {
                    if (chatArchived) {
                      toggleChatArchive();
                    }
                    composerRef.current?.focus();
                  }}
                >
                  <SquarePen className="h-4 w-4" />
                  <span className="hidden sm:inline">New Run</span>
                </Button>
              </div>
            </div>
          </header>

          <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_390px]">
            <Card className="flex min-h-0 flex-col">
              <CardHeader className="space-y-1 pb-3">
                <CardTitle className="text-2xl leading-none tracking-tight">Chat Timeline</CardTitle>
                <CardDescription>
                  {laneLabel} lane, {filteredRuns.length} message(s)
                </CardDescription>
              </CardHeader>

              <CardContent className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
                  <Input value={runSearch} onChange={(event) => setRunSearch(event.currentTarget.value)} placeholder="Search runs by id, repo, branch, message..." />

                  <Select value={runSort} onValueChange={(value) => setRunSort(value as SortMode)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="created_asc">Oldest first</SelectItem>
                      <SelectItem value="updated_desc">Updated (newest)</SelectItem>
                      <SelectItem value="created_desc">Created (newest)</SelectItem>
                      <SelectItem value="status">Status</SelectItem>
                    </SelectContent>
                  </Select>

                  <label className="flex items-center gap-2 rounded-md border px-3 text-xs text-muted-foreground">
                    <Checkbox checked={showArchivedRuns} onCheckedChange={(checked) => setShowArchivedRuns(checked === true)} />
                    show archived
                  </label>
                </div>

                <ScrollArea className="min-h-0 rounded-lg border bg-muted/20 p-2">
                  <div className="space-y-2">
                    {filteredRuns.length === 0 ? (
                      <div className="rounded-lg border border-dashed bg-background p-5">
                        <p className="text-sm font-medium">No runs yet in this chat lane</p>
                        <p className="mt-1 text-xs text-muted-foreground">Send a message below to queue a new run.</p>
                      </div>
                    ) : (
                      filteredRuns.map((run) => {
                        const expanded = expandedRunIds.has(run.runId);
                        const details = runDetailsById[run.runId];
                        const summary = compactText(runSummary(run), 220);
                        const prUrl = extractPrUrl(details);
                        const isArchived = archivedRuns[run.runId] === true;

                        return (
                          <div key={run.runId} className={cn("overflow-hidden rounded-lg border bg-card", selectedRunId === run.runId && "border-primary/50")}> 
                            <button
                              type="button"
                              className="w-full px-3 py-3 text-left"
                              onClick={() => {
                                setSelectedRunId(run.runId);
                                toggleRunExpanded(run.runId);
                                if (!runDetailsById[run.runId]) {
                                  void loadRunDetails(run.runId);
                                }
                              }}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <p className="text-sm font-semibold leading-tight">{summary}</p>
                                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                                    {repoName(run.repo)} | {run.branchName || run.baseBranch || "-"} | {run.runId}
                                  </p>
                                  <p className="font-mono text-[11px] text-muted-foreground">updated {prettyTimestamp(run.updatedAt)}</p>
                                  {prUrl && (
                                    <p className="mt-1 text-xs">
                                      PR: {" "}
                                      <a href={prUrl} target="_blank" rel="noreferrer" className="text-primary">
                                        {prUrl}
                                      </a>
                                    </p>
                                  )}
                                </div>
                                <Badge variant={statusBadgeVariant(run.status)}>{run.status}</Badge>
                              </div>
                            </button>

                            {expanded && (
                              <div className="border-t bg-muted/10 p-3">
                                <div className="mb-2 flex flex-wrap gap-2">
                                  <Button size="sm" variant="secondary" onClick={() => continueFromRun(run)}>
                                    <Undo2 className="h-3.5 w-3.5" />
                                    Continue
                                  </Button>

                                  {(run.status === "running" || run.status === "paused") && (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      onClick={() => void handleRunAction(run, run.status === "running" ? "pause" : "resume")}
                                    >
                                      {run.status === "running" ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                      {run.status === "running" ? "Pause" : "Resume"}
                                    </Button>
                                  )}

                                  {(run.status === "running" || run.status === "paused") && (
                                    <Button size="sm" variant="destructive" onClick={() => void handleRunAction(run, "abort")}>
                                      <XCircle className="h-3.5 w-3.5" />
                                      Abort
                                    </Button>
                                  )}

                                  {(run.status === "failed" || run.status === "aborted" || run.status === "completed") && (
                                    <Button size="sm" variant="secondary" onClick={() => void handleRunAction(run, "retry")}>
                                      <Play className="h-3.5 w-3.5" />
                                      Retry
                                    </Button>
                                  )}

                                  <Button size="sm" variant="secondary" onClick={() => void handleRunAction(run, "refresh")}>
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    Refresh
                                  </Button>

                                  <Button size="sm" variant="secondary" onClick={() => toggleRunArchive(run.runId)}>
                                    <Archive className="h-3.5 w-3.5" />
                                    {isArchived ? "Unarchive" : "Archive"}
                                  </Button>

                                  {run.status !== "running" && run.status !== "paused" && run.status !== "aborting" && (
                                    <Button size="sm" variant="destructive" onClick={() => void handleDeleteRun(run)}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                      Delete
                                    </Button>
                                  )}
                                </div>

                                <RunGraph run={run} details={details} />
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </ScrollArea>

                <form onSubmit={(event) => void submitComposer(event)} className="space-y-2 rounded-lg border bg-background p-3">
                  {chatArchived ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      This chat is archived. Reopen chat to send another run message.
                    </div>
                  ) : (
                    <>
                      {scopeRepo === "__all__" && (
                        <Input value={composerRepo} onChange={(event) => setComposerRepo(event.currentTarget.value)} placeholder="/absolute/path/to/workspace" />
                      )}

                      <Textarea
                        ref={composerRef}
                        value={composerMessage}
                        onChange={(event) => setComposerMessage(event.currentTarget.value)}
                        placeholder="Describe the feature/task for this run..."
                      />

                      {showComposerAdvanced && (
                        <div className="grid gap-2 md:grid-cols-2">
                          <Input value={composerSpec} onChange={(event) => setComposerSpec(event.currentTarget.value)} placeholder="spec file (optional)" />
                          <Input value={composerBaseBranch} onChange={(event) => setComposerBaseBranch(event.currentTarget.value)} placeholder="base branch" />
                          <Input value={composerBranch} onChange={(event) => setComposerBranch(event.currentTarget.value)} placeholder="worktree branch name" />
                          <Input value={composerLoopArgs} onChange={(event) => setComposerLoopArgs(event.currentTarget.value)} placeholder="extra loop args" />
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <Button type="button" variant="secondary" onClick={() => setShowComposerAdvanced((value) => !value)}>
                          {showComposerAdvanced ? "Hide Advanced" : "Advanced"}
                        </Button>

                        <Button type="submit" disabled={composerSubmitting}>
                          <Send className="h-4 w-4" />
                          {composerSubmitting ? "Sending" : "Send Run"}
                        </Button>
                      </div>
                    </>
                  )}
                </form>
              </CardContent>
            </Card>

            <Card className="min-h-0">
              <CardHeader className="pb-3">
                <CardTitle className="text-2xl leading-none tracking-tight">Workspace</CardTitle>
                <CardDescription>{activeRepo || "Select a workspace"}</CardDescription>
              </CardHeader>

              <CardContent className="min-h-0">
                <Tabs value={sidePanelTab} onValueChange={(value) => setSidePanelTab(value as SidePanelTab)} className="flex h-full min-h-0 flex-col gap-2">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="files">Files</TabsTrigger>
                    <TabsTrigger value="diff">Diff</TabsTrigger>
                    <TabsTrigger value="inspector" disabled={!canInspect}>
                      Inspector
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="files" className="mt-0 min-h-0 flex-1">
                    <div className="flex h-full min-h-0 flex-col rounded-lg border p-3">
                      <p className="text-sm font-semibold">Changed files</p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">branch {shortBranch(activeWorkspace?.branch)}</p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        {workspaceLoading ? "Refreshing workspace..." : `${activeWorkspace?.changedFiles.length || 0} file(s)`}
                      </p>
                      {workspaceError && <p className="mt-1 text-xs text-destructive">{workspaceError}</p>}

                      <Separator className="my-3" />

                      <ScrollArea className="min-h-0 flex-1">
                        <div className="space-y-1 pr-2">
                          {(activeWorkspace?.changedFiles || []).map((file) => (
                            <button
                              key={file.path}
                              type="button"
                              onClick={() => {
                                selectDiffFile(file.path);
                                setSidePanelTab("diff");
                              }}
                              className={cn(
                                "w-full rounded-md border px-2 py-2 text-left font-mono text-xs transition",
                                selectedDiffFile === file.path ? "border-primary/50 bg-accent" : "border-border bg-background hover:bg-muted"
                              )}
                            >
                              <div className="grid grid-cols-[32px_minmax(0,1fr)] gap-2">
                                <span className="text-muted-foreground">{file.status}</span>
                                <span className="truncate">{file.path}</span>
                              </div>
                            </button>
                          ))}
                          {!activeWorkspace?.changedFiles?.length && <p className="text-xs text-muted-foreground">No changed files in this workspace.</p>}
                        </div>
                      </ScrollArea>
                    </div>
                  </TabsContent>

                  <TabsContent value="diff" className="mt-0 min-h-0 flex-1">
                    <div className="flex h-full min-h-0 flex-col rounded-lg border p-3">
                      <p className="text-sm font-semibold">Diff {selectedDiffFile ? `- ${selectedDiffFile}` : ""}</p>
                      <Separator className="my-3" />
                      {!selectedDiffFile ? (
                        <p className="text-xs text-muted-foreground">Pick a file from the Files tab.</p>
                      ) : (
                        <ScrollArea className="min-h-0 flex-1 rounded-md border bg-slate-950 p-3">
                          <pre className="whitespace-pre-wrap font-mono text-xs text-slate-100">{diffLoading ? "Loading diff..." : currentDiff || "No diff available."}</pre>
                        </ScrollArea>
                      )}
                    </div>
                  </TabsContent>

                  <TabsContent value="inspector" className="mt-0 min-h-0 flex-1">
                    {!selectedRun ? (
                      <div className="rounded-lg border p-3">
                        <p className="text-sm font-semibold">No run selected</p>
                        <p className="mt-1 text-xs text-muted-foreground">Select a run from chat timeline to inspect execution details.</p>
                      </div>
                    ) : (
                      <Tabs value={inspectorTab} onValueChange={(value) => setInspectorTab(value as InspectorTab)} className="flex h-full min-h-0 flex-col gap-2">
                        <TabsList className="grid w-full grid-cols-5">
                          <TabsTrigger value="summary">Summary</TabsTrigger>
                          <TabsTrigger value="graph">Graph</TabsTrigger>
                          <TabsTrigger value="events">Events</TabsTrigger>
                          <TabsTrigger value="log">Log</TabsTrigger>
                          <TabsTrigger value="meta">Meta</TabsTrigger>
                        </TabsList>

                        <TabsContent value="summary" className="mt-0 space-y-2">
                          <div className="rounded-lg border p-3">
                            <p className="text-sm font-semibold">{compactText(runSummary(selectedRun), 100)}</p>
                            <p className="mt-1 font-mono text-[11px] text-muted-foreground">repo {selectedRun.repo}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">branch {selectedRun.branchName || "-"} | base {selectedRun.baseBranch || "-"}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">updated {prettyTimestamp(selectedRun.updatedAt)}</p>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div className="rounded-lg border bg-muted/30 p-2">
                              <p className="text-[10px] uppercase text-muted-foreground">Queue</p>
                              <p className="text-2xl font-semibold leading-none">{dashboard?.forge.queue.length ?? 0}</p>
                            </div>
                            <div className="rounded-lg border bg-muted/30 p-2">
                              <p className="text-[10px] uppercase text-muted-foreground">Tokens</p>
                              <p className="text-2xl font-semibold leading-none">{formatInt(dashboard?.snapshot.metrics?.totalTokens)}</p>
                            </div>
                            <div className="rounded-lg border bg-muted/30 p-2">
                              <p className="text-[10px] uppercase text-muted-foreground">Cost</p>
                              <p className="text-2xl font-semibold leading-none">{formatUsd(dashboard?.snapshot.metrics?.estimatedCostUsd)}</p>
                            </div>
                            <div className="rounded-lg border bg-muted/30 p-2">
                              <p className="text-[10px] uppercase text-muted-foreground">Audit</p>
                              <p className="text-2xl font-semibold leading-none">{dashboard?.snapshot.metrics?.latestAuditScore ?? "-"}</p>
                            </div>
                          </div>
                        </TabsContent>

                        <TabsContent value="graph" className="mt-0">
                          <RunGraph run={selectedRun} details={selectedRunDetails} />
                        </TabsContent>

                        <TabsContent value="events" className="mt-0 min-h-0 flex-1">
                          <div className="flex h-full min-h-0 flex-col rounded-lg border p-3">
                            <p className="text-sm font-semibold">Execution events ({selectedRunDetails?.events.length || 0})</p>
                            <ScrollArea className="mt-3 min-h-0 flex-1">
                              <div className="space-y-2 pr-2">
                                {(selectedRunDetails?.events || []).slice(0, 150).map((event) => (
                                  <div key={event.id} className="rounded-md border bg-muted/20 p-2">
                                    <p className="font-mono text-[10px] text-muted-foreground">{prettyTimestamp(event.createdAt)} | {event.level}</p>
                                    <p className="mt-1 text-xs whitespace-pre-wrap break-words">{event.message}</p>
                                  </div>
                                ))}
                                {!selectedRunDetails?.events?.length && <p className="text-xs text-muted-foreground">No events loaded yet.</p>}
                              </div>
                            </ScrollArea>
                          </div>
                        </TabsContent>

                        <TabsContent value="log" className="mt-0 min-h-0 flex-1">
                          <div className="flex h-full min-h-0 flex-col rounded-lg border p-3">
                            <p className="text-sm font-semibold">Runner log</p>
                            <ScrollArea className="mt-3 min-h-0 flex-1 rounded-md border bg-slate-950 p-3">
                              <pre className="whitespace-pre-wrap font-mono text-xs text-slate-100">{selectedRunDetails?.logTail?.join("\n") || "No log lines loaded yet."}</pre>
                            </ScrollArea>
                          </div>
                        </TabsContent>

                        <TabsContent value="meta" className="mt-0">
                          <div className="rounded-lg border p-3">
                            <p className="text-sm font-semibold">Metadata</p>
                            <p className="mt-2 font-mono text-[11px] text-muted-foreground">run id {selectedRun.runId}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">status {selectedRun.status}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">worktree {String(selectedRun.worktree)}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">open_pr {String(selectedRun.openPr)}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">run dir {selectedRun.runDir}</p>
                          </div>
                        </TabsContent>
                      </Tabs>
                    )}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          </section>
        </main>
      </div>

      <Dialog open={workspaceDialogOpen} onOpenChange={setWorkspaceDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Workspace</DialogTitle>
            <DialogDescription>Add any local repository path to track its runs and status lanes.</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-2">
            <Input
              value={workspaceDraftPath}
              onChange={(event) => setWorkspaceDraftPath(event.currentTarget.value)}
              placeholder="/Users/you/code/my-repo"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setWorkspaceDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitWorkspaceDialog}>Add Workspace</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {mobileSidebarOpen && <button className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setMobileSidebarOpen(false)} />}

      {(stateError || workspaceError || notice) && (
        <button
          className="fixed bottom-4 right-4 z-50 max-w-[92vw] rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-left font-mono text-xs text-rose-700"
          onClick={() => {
            setNotice("");
            setStateError("");
            setWorkspaceError("");
          }}
        >
          {stateError || workspaceError || notice}
        </button>
      )}
    </div>
  );
}
