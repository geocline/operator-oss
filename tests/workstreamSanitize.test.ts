import { describe, expect, it } from "vitest";
import {
  validateCardFacingFilename,
  validateCardFacingPayload,
  validateCardFacingText,
} from "../lib/workstreams/sanitize";

function expectTextViolation(text: string, code: string) {
  const result = validateCardFacingText(text);
  expect(result.ok, text).toBe(false);
  expect(result.violations.map((violation) => violation.code), text).toContain(code);
}

describe("card-facing text privacy validation", () => {
  it.each([
    ["/Users/person/deals/notes.md", "local_path"],
    ["/home/person/deals/notes.md", "local_path"],
    ["~/deals/notes.md", "local_path"],
    ["C:\\Users\\person\\deals\\notes.md", "local_path"],
    ["\\\\server\\share\\notes.md", "local_path"],
    ["file:///Users/person/deals/notes.md", "file_url"],
    ["result:/Users/person/secret.pdf", "local_path"],
    ["path=~/secret.pdf", "local_path"],
    ["see[/home/person/secret.pdf]", "local_path"],
    ["path=C:\\Users\\person\\secret.pdf", "local_path"],
  ])("rejects local path disclosure in %s", (text, code) => {
    expectTextViolation(text, code);
  });

  it.each([
    ["http://localhost:3000/report", "internal_url"],
    ["http://127.0.0.1/report", "internal_url"],
    ["http://10.20.30.40/report", "internal_url"],
    ["http://172.16.2.3/report", "internal_url"],
    ["http://192.168.1.10/report", "internal_url"],
    ["http://169.254.1.2/report", "internal_url"],
    ["http://100.64.0.1/report", "internal_url"],
    ["http://100.127.255.254/report", "internal_url"],
    ["http://[::1]/report", "internal_url"],
    ["http://[fe80::1]/report", "internal_url"],
    ["http://[fd00::1]/report", "internal_url"],
    ["https://dashboard.internal/report", "internal_url"],
    ["https://intranet/report", "internal_url"],
    ["http://localhost./report", "internal_url"],
    ["http://127.0.0.1./report", "internal_url"],
    ["http://10.0.0.1./report", "internal_url"],
    ["https://dashboard.internal./report", "internal_url"],
    ["http://home.arpa/report", "internal_url"],
  ])("rejects internal URL disclosure in %s", (text, code) => {
    expectTextViolation(text, code);
  });

  it.each([
    ["Connect to localhost:3000 for details.", "internal_url"],
    ["Connect to dashboard.internal for details.", "internal_url"],
    ["Connect to printer.local. for details.", "internal_url"],
    ["Connect to home.arpa for details.", "internal_url"],
    ["Connect to 10.20.30.40:8080 for details.", "internal_url"],
    ["Connect to 100.64.0.1 for details.", "internal_url"],
    ["Connect to [fd00::1]:8080 for details.", "internal_url"],
  ])("rejects internal host references without a URL scheme in %s", (text, code) => {
    expectTextViolation(text, code);
  });

  it.each([
    ["The file is in Temp Outputs.", "temp_outputs"],
    ["See the handoff prompt for details.", "internal_term"],
    ["The system prompt contains more context.", "internal_term"],
    ["Resume the prior session ID.", "internal_term"],
    ["Resume the prior session_token.", "internal_term"],
    ["The internal task ID is complete.", "internal_term"],
    ["The internal task_id is complete.", "internal_term"],
    ["The project path was updated.", "internal_term"],
    ["Generation ID 3 produced this.", "internal_term"],
    ["The feature branch path has the result.", "internal_term"],
    ["The worktree path contains the file.", "internal_term"],
    ["Geo reviewed this.", "internal_name"],
    ["George reviewed this.", "internal_name"],
    ["Ari reviewed this.", "internal_name"],
    ["Operator prepared this.", "internal_name"],
    ["Claude prepared this.", "internal_name"],
    ["Codex prepared this.", "internal_name"],
    ["ChatGPT prepared this.", "internal_name"],
    ["The harness prepared this.", "internal_name"],
  ])("rejects private terminology or names in %s", (text, code) => {
    expectTextViolation(text, code);
  });

  it.each([
    ["Reference 123e4567-e89b-12d3-a456-426614174000.", "internal_identifier"],
    ["Reference 1ef21d2e-7b4a-6cc8-9f3a-0242ac120002.", "internal_identifier"],
    ["Reference 01890f5e-b3d8-7cc2-8f2b-a62e26c14f21.", "internal_identifier"],
    ["Reference 01890f5e-b3d8-8cc2-8f2b-a62e26c14f21.", "internal_identifier"],
    ["Reference 5EZSZfXpOCQdxeqP3wJ8n.", "internal_identifier"],
    ["Reference abcdefghijklmnopqrstu.", "internal_identifier"],
  ])("rejects internal identifiers in %s", (text, code) => {
    expectTextViolation(text, code);
  });

  it("accepts concise self-contained status text and public URLs", () => {
    const result = validateCardFacingText(
      "Underwriting review is complete. The updated rent roll is available at https://example.com/results.",
    );
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it("uses word boundaries to avoid rejecting ordinary business words", () => {
    const result = validateCardFacingText(
      "The project task is complete. Resume the review session after the branch meeting. Projected revenue and geographic coverage are included.",
    );
    expect(result.ok).toBe(true);
  });

  it("allows public IPv6 URLs", () => {
    const result = validateCardFacingText(
      "The public result is available at https://[2606:4700:4700::1111]/.",
    );
    expect(result).toEqual({ ok: true, violations: [] });
  });
});

describe("card-facing filename validation", () => {
  it.each([
    "report.html",
    "report.PDF",
    "report.xlsx",
    "report.docx",
    "report.pptx",
    "chart.png",
    "photo.jpg",
    "photo.jpeg",
    "animation.gif",
    "image.webp",
  ])("accepts supported filename %s", (filename) => {
    expect(validateCardFacingFilename(filename)).toEqual({ ok: true, violations: [] });
  });

  it.each(["script.js", "data.csv", "archive.zip", "notes.txt", "report", ".pdf"])(
    "rejects unsupported filename %s",
    (filename) => {
      expectTextViolationForFilename(filename, "unsupported_file_type");
    },
  );

  it.each([
    ["/tmp/report.pdf", "local_path"],
    ["C:\\Temp\\report.pdf", "local_path"],
    ["folder/report.pdf", "local_path"],
    ["Temp Outputs.pdf", "temp_outputs"],
    ["Operator-report.pdf", "internal_name"],
  ])("rejects unsafe filename %s", (filename, code) => {
    expectTextViolationForFilename(filename, code);
  });

  it("allows ordinary business filenames containing session or project", () => {
    expect(validateCardFacingFilename("session-results.pdf")).toEqual({
      ok: true,
      violations: [],
    });
    expect(validateCardFacingFilename("project-summary.xlsx")).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("rejects the whole payload and returns field-specific violations", () => {
    const result = validateCardFacingPayload({
      text: "Review is complete.",
      filenames: ["summary.pdf", "Operator-session.zip"],
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "filenames[1]", code: "internal_name" }),
        expect.objectContaining({ field: "filenames[1]", code: "unsupported_file_type" }),
      ]),
    );
  });
});

function expectTextViolationForFilename(filename: string, code: string) {
  const result = validateCardFacingFilename(filename);
  expect(result.ok, filename).toBe(false);
  expect(result.violations.map((violation) => violation.code), filename).toContain(code);
}
