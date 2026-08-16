import { describe, expect, it } from "vitest";
import { rowStatus } from "../app/orchestrator/statusLadder";

const task = (status: string, awaiting_input: number) => ({ status, awaiting_input });

describe("rowStatus", () => {
  it("returns awaiting when the task is in_progress and awaiting_input is set", () => {
    expect(rowStatus(task("in_progress", 1), { running: false, unviewed: false })).toEqual({
      kind: "awaiting",
      label: "Needs your input",
    });
  });

  it("returns running when not awaiting but the running flag is on", () => {
    expect(rowStatus(task("in_progress", 0), { running: true, unviewed: false })).toEqual({
      kind: "running",
      label: "Working",
    });
  });

  it("returns unviewed when neither awaiting nor running but the unviewed flag is on", () => {
    expect(rowStatus(task("done", 0), { running: false, unviewed: true })).toEqual({
      kind: "unviewed",
      label: "Finished while you were away",
    });
  });

  it("returns none when nothing is set", () => {
    expect(rowStatus(task("not_started", 0), { running: false, unviewed: false })).toEqual({ kind: "none" });
  });

  // Precedence pairs — the higher signal always wins.
  it("awaiting wins over running", () => {
    expect(rowStatus(task("in_progress", 1), { running: true, unviewed: false }).kind).toBe("awaiting");
  });

  it("awaiting wins over unviewed", () => {
    expect(rowStatus(task("in_progress", 1), { running: false, unviewed: true }).kind).toBe("awaiting");
  });

  it("awaiting wins over both running and unviewed", () => {
    expect(rowStatus(task("in_progress", 1), { running: true, unviewed: true }).kind).toBe("awaiting");
  });

  it("running wins over unviewed", () => {
    expect(rowStatus(task("in_progress", 0), { running: true, unviewed: true }).kind).toBe("running");
  });

  it("a status of in_progress with awaiting_input=0 does not count as awaiting", () => {
    expect(rowStatus(task("in_progress", 0), { running: false, unviewed: false }).kind).toBe("none");
  });

  it("awaiting_input set on a non-in_progress status does not count as awaiting", () => {
    expect(rowStatus(task("done", 1), { running: false, unviewed: false }).kind).toBe("none");
  });
});
