import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

// Package B5: Services/Terminal are suppressed (not rendered) rather than
// disabled with a "select a project first" tooltip, when no project is
// selected — following the same "suppress, don't disable" rule as
// tests/worktreeClarityUi.test.ts pins elsewhere.
describe("titlebar Services/Terminal suppression", () => {
  it("renders Services only when a project is selected, with no disabled/tooltip fallback", () => {
    const orch = source("app/Orchestrator.tsx");
    expect(orch).toContain('{features.services && project && (');
    expect(orch).toContain("Toggle the project's managed services (dev server, setup, test)");
    expect(orch).not.toContain('title={project ? "Toggle the project\'s managed services');
  });

  it("renders Terminal only when a project is selected, with no disabled/tooltip fallback", () => {
    const orch = source("app/Orchestrator.tsx");
    expect(orch).toContain("{project && (\n              <button\n                className={`tb-btn${o.termOpen");
    expect(orch).not.toContain('title={project ? "Toggle terminal (runs in the project\'s working dir)" : "Select a project first"}');
  });

  it("no longer disables either titlebar button on a missing project", () => {
    const orch = source("app/Orchestrator.tsx");
    expect(orch).not.toContain('disabled={!project}');
  });
});

// Package B5: the tasks-column Sessions header button hides entirely for a
// project with zero started tasks — an empty project has nothing to show in
// the Sessions modal.
describe("tasks column Sessions button suppression", () => {
  it("gates the Sessions button on the project having at least one started task", () => {
    const col = source("app/orchestrator/TasksColumn.tsx");
    expect(col).toContain("hasStartedTasks");
    expect(col).toContain('{hasStartedTasks && <button className="btn btn-line btn-sm" onClick={onShowSessions}');
  });
});
