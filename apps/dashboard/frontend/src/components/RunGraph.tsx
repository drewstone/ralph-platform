import type { ForgeRun, RunDetails } from "../types";
import { compactText } from "../utils";
import { Badge } from "@/components/ui/badge";

interface RunGraphProps {
  run: ForgeRun;
  details?: RunDetails;
}

export function RunGraph({ run, details }: RunGraphProps) {
  const events = details?.events || [];
  const warnCount = events.filter((event) => event.level === "warn").length;
  const errorCount = events.filter((event) => event.level === "error").length;
  const infoCount = events.filter((event) => event.level === "info").length;

  const topEvents = events.slice(0, 3);
  const logLines = details?.logTail || [];

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2">
        <Badge variant="secondary">Run {run.runId.slice(0, 10)}</Badge>
      </div>

      <div className="space-y-2 border-l border-border pl-3">
        <section className="rounded-md border bg-background p-2">
          <p className="font-mono text-[11px] font-semibold">Input</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{compactText(run.taskText || run.specFile || "No task text", 160)}</p>
        </section>

        <section className="rounded-md border bg-background p-2">
          <p className="font-mono text-[11px] font-semibold">Events ({events.length})</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">info {infoCount} | warn {warnCount} | error {errorCount}</p>
          <div className="mt-1 space-y-1">
            {topEvents.map((event) => (
              <p className="font-mono text-[11px] text-muted-foreground" key={event.id}>
                {event.level}: {compactText(event.message, 130)}
              </p>
            ))}
          </div>
        </section>

        <section className="rounded-md border bg-background p-2">
          <p className="font-mono text-[11px] font-semibold">Logs</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{logLines.length} lines captured</p>
          <div className="mt-1 space-y-1">
            {logLines.slice(0, 2).map((line, index) => (
              <p className="font-mono text-[11px] text-muted-foreground" key={`${run.runId}-log-${index}`}>
                {compactText(line, 130)}
              </p>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
