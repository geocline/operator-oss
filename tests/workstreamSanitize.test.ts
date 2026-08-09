import { describe, expect, it } from "vitest";
import {
  validateCardFacingFilename,
  validateCardFacingPayload,
  validateCardFacingText,
} from "../lib/workstreams/sanitize";

/**
 * The card-facing privacy policy was removed 2026-08-07 per George: everyone
 * with tracker access can already see everything in these deals, so scanning
 * posts for paths, names, and identifiers only blocked legitimate updates.
 * These tests pin the permissive contract so the filter cannot creep back in.
 */

describe("card-facing text validation", () => {
  it.each([
    "/Users/person/deals/notes.md",
    "~/deals/notes.md",
    "C:\\Users\\person\\deals\\notes.md",
    "file:///Users/person/deals/notes.md",
    "http://localhost:3000/report",
    "http://192.168.1.10/report",
    "https://dashboard.internal/report",
    "The file is in Temp Outputs.",
    "See the handoff prompt for details.",
    "The worktree path contains the file.",
    "Geo reviewed this.",
    "George reviewed this.",
    "Claude prepared this.",
    "Codex prepared this.",
    "Reference 123e4567-e89b-12d3-a456-426614174000.",
    "Reference 5EZSZfXpOCQdxeqP3wJ8n.",
  ])("accepts previously blocked text: %s", (text) => {
    expect(validateCardFacingText(text)).toEqual({ ok: true, violations: [] });
  });

  it("accepts ordinary status text", () => {
    expect(
      validateCardFacingText(
        "Underwriting review is complete. The updated rent roll is attached.",
      ),
    ).toEqual({ ok: true, violations: [] });
  });

  it("still requires the value to be a string", () => {
    const result = validateCardFacingText(42);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      "invalid_value",
    );
  });
});

describe("card-facing filename validation", () => {
  it.each([
    "report.html",
    "report.PDF",
    "report.xlsx",
    "chart.png",
    "data.csv",
    "notes.md",
    "notes.txt",
    "archive.zip",
    "Operator-report.pdf",
    "Temp Outputs.pdf",
    "report",
  ])("accepts filename %s", (filename) => {
    expect(validateCardFacingFilename(filename)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it.each(["/tmp/report.pdf", "C:\\Temp\\report.pdf", "folder/report.pdf"])(
    "still rejects path separators in %s",
    (filename) => {
      const result = validateCardFacingFilename(filename);
      expect(result.ok, filename).toBe(false);
      expect(
        result.violations.map((violation) => violation.code),
        filename,
      ).toContain("local_path");
    },
  );

  it("rejects an empty or non-string filename", () => {
    expect(validateCardFacingFilename("").ok).toBe(false);
    expect(validateCardFacingFilename(null).ok).toBe(false);
  });
});

describe("card-facing payload validation", () => {
  it("accepts a body and filenames that the old policy refused", () => {
    expect(
      validateCardFacingPayload({
        text: "George reviewed the file at /Users/geo/deals/summary.pdf.",
        filenames: ["summary.pdf", "Operator-session.zip"],
      }),
    ).toEqual({ ok: true, violations: [] });
  });

  it("reports field-specific violations for structurally bad filenames", () => {
    const result = validateCardFacingPayload({
      text: "Review is complete.",
      filenames: ["summary.pdf", "nested/folder/report.pdf"],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "filenames[1]", code: "local_path" }),
      ]),
    );
  });

  it("rejects a non-array filenames value", () => {
    const result = validateCardFacingPayload({
      text: "Review is complete.",
      filenames: "summary.pdf" as unknown as unknown[],
    });
    expect(result.ok).toBe(false);
  });
});
