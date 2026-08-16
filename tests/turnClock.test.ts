import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { elapsed, turnClockVisible, TURN_CLOCK_DELAY_MS } from "@/app/orchestrator/format";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("elapsed()", () => {
  const start = Date.parse("2026-08-15T12:00:00.000Z");
  it("formats under a minute as m:ss", () => {
    expect(elapsed(start, start + 47_000)).toBe("0:47");
  });
  it("formats under an hour as m:ss with no zero-pad on minutes", () => {
    expect(elapsed(start, start + (12 * 60 + 3) * 1000)).toBe("12:03");
  });
  it("formats an hour or more as h:mm:ss", () => {
    expect(elapsed(start, start + (3600 + 2 * 60 + 11) * 1000)).toBe("1:02:11");
  });
  it("floors partial seconds and never goes negative", () => {
    expect(elapsed(start, start + 900)).toBe("0:00");
    expect(elapsed(start, start - 5000)).toBe("0:00");
  });
});

describe("turnClockVisible()", () => {
  const anchor = Date.parse("2026-08-15T12:00:00.000Z");
  it("hides the clock for the first 15s of a turn", () => {
    expect(turnClockVisible(anchor, anchor)).toBe(false);
    expect(turnClockVisible(anchor, anchor + 14_999)).toBe(false);
  });
  it("shows the clock at and past the 15s threshold", () => {
    expect(turnClockVisible(anchor, anchor + TURN_CLOCK_DELAY_MS)).toBe(true);
    expect(turnClockVisible(anchor, anchor + 60_000)).toBe(true);
  });
  it("reload mid-turn: an old anchor from before reload is immediately visible", () => {
    // A page reload rebuilds the anchor from the persisted turn_started_at
    // (or the last user message), which can already be minutes old — the
    // clock must not restart a fresh 15s countdown from the reload moment.
    const longAgo = anchor - 5 * 60_000;
    expect(turnClockVisible(longAgo, anchor)).toBe(true);
  });
});

// Wiring: the clock is anchored on task.turn_started_at (falling back to the
// last non-queued user message), ticks once a second while running, and
// appears both beside the typing dots and in the header .sh-tools chip row.
// SessionView pulls in fetch-backed children (WorkstreamTaskControls,
// SyncBanner), so — like the other SessionView-touching tests in this repo
// (tests/workstreamSessionUi.test.ts) — this is a source-text pin rather than
// a full component render.
describe("turn clock wiring in SessionView", () => {
  const view = source("app/orchestrator/SessionView.tsx");

  it("anchors on turn_started_at, falling back to the last user message", () => {
    expect(view).toContain("if (task.turn_started_at) return task.turn_started_at;");
    expect(view).toContain('if (m.role === "user" && m.createdAt) return m.createdAt;');
  });

  it("ticks once a second only while running and not awaiting an answer", () => {
    expect(view).toContain("if (!running || awaitingAnswer || !turnAnchor) return;");
    expect(view).toContain("setInterval(() => setClockNow(Date.now()), 1000)");
  });

  it("gates visibility on the pure turnClockVisible() helper, not ad-hoc math", () => {
    expect(view).toContain("turnClockVisible(turnAnchor, clockNow)");
  });

  it("renders beside the typing dots and in the header chip row", () => {
    expect(view).toContain('{showTurnClock && <span className="turn-clock">{turnClockText}</span>}');
    expect(view).toContain('turn-clock turn-clock-chip');
  });
});
