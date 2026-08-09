import type {
  CardFacingValidation,
  CardFacingViolation,
  CardFacingViolationCode,
} from "./types";

/**
 * Card-facing content policy - DISABLED 2026-08-07 per George.
 *
 * This module used to scan every workstream update body, attachment filename,
 * and HTML attachment body for "private" content: local filesystem paths,
 * internal URLs, UUIDs, opaque identifiers, and a hardcoded name list
 * (geo|george|ari|operator|claude|codex|chatgpt|harness). Anything matching
 * was refused outright.
 *
 * That was never the intent. Everyone with tracker access can already see
 * everything in these deals; the original rule was about keeping cards
 * readable, not about secrecy. In practice the scan blocked ordinary posts -
 * the word "George" in a body, a source path in a reference document - and
 * pushed agents into silently degrading deliverables to get past it.
 *
 * The rule now is simple: if it is asked to be posted, it posts.
 *
 * The validators below are kept as permissive no-ops so every call site keeps
 * its shape and the tests keep a contract to assert against. The one check
 * retained is structural, not editorial: a filename may not contain a path
 * separator, because these values become upload filenames and path traversal
 * is a correctness bug rather than a privacy preference.
 */

const MESSAGES: Record<CardFacingViolationCode, string> = {
  invalid_value: "The value must be plain text.",
  local_path: "Attachment filenames cannot contain path separators.",
  file_url: "The value is not a valid file reference.",
  internal_url: "The value is not a valid URL.",
  temp_outputs: "The value is not valid.",
  internal_term: "The value is not valid.",
  internal_name: "The value is not valid.",
  internal_identifier: "The value is not valid.",
  unsupported_file_type: "The attachment type is not supported.",
};

function addViolation(
  violations: CardFacingViolation[],
  field: string,
  code: CardFacingViolationCode,
) {
  if (violations.some((item) => item.field === field && item.code === code)) return;
  violations.push({ field, code, message: MESSAGES[code] });
}

function result(violations: CardFacingViolation[]): CardFacingValidation {
  return { ok: violations.length === 0, violations };
}

export function validateCardFacingText(
  text: unknown,
  field = "text",
): CardFacingValidation {
  const violations: CardFacingViolation[] = [];
  if (typeof text !== "string") addViolation(violations, field, "invalid_value");
  return result(violations);
}

export function validateCardFacingFilename(
  filename: unknown,
  field = "filename",
): CardFacingValidation {
  const violations: CardFacingViolation[] = [];
  if (typeof filename !== "string" || !filename.trim()) {
    addViolation(violations, field, "invalid_value");
    return result(violations);
  }
  // Structural only: these become upload filenames, so a separator here is a
  // path-traversal bug, not a privacy question.
  if (filename.includes("/") || filename.includes("\\")) {
    addViolation(violations, field, "local_path");
  }
  return result(violations);
}

export function validateCardFacingPayload(input: {
  text: unknown;
  filenames?: unknown[];
}): CardFacingValidation {
  const violations = validateCardFacingText(input.text, "text").violations;
  if (input.filenames !== undefined && !Array.isArray(input.filenames)) {
    addViolation(violations, "filenames", "invalid_value");
  } else {
    for (const [index, filename] of (input.filenames ?? []).entries()) {
      violations.push(
        ...validateCardFacingFilename(filename, `filenames[${index}]`).violations,
      );
    }
  }
  return result(violations);
}
