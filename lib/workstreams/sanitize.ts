import type {
  CardFacingValidation,
  CardFacingViolation,
  CardFacingViolationCode,
} from "./types";

const SUPPORTED_FILE_EXTENSION =
  /\.(?:html|pdf|xlsx|docx|pptx|png|jpe?g|gif|webp)$/i;

const FILE_URL = /\bfile:\/\/[^\s<>()]+/i;
const LOCAL_PATH =
  /(?:^|[^A-Za-z0-9/])(?:~[/\\]|\/(?!\/)[^\s<>()]+|[A-Za-z]:[\\/][^\s<>()]+|\\\\[^\\\s]+\\[^\s<>()]+)/i;
const TEMP_OUTPUTS = /\btemp[\s_-]+outputs?\b/i;
const INTERNAL_TERM =
  /\b(?:hand-?off[\s_-]+(?:prompt|file|notes?)|(?:system|session)[\s_-]+prompt|session[\s_-]+(?:id|token|hand-?off)|task[\s_-]+id|project[\s_-]+(?:folder|path|root)|generation[\s_-]+(?:id|run)|branch[\s_-]+(?:name|id|path)|work[\s_-]?tree[\s_-]+(?:path|branch))\b/i;
const INTERNAL_NAME =
  /\b(?:geo|george|ari|operator|claude|codex|chatgpt|harness(?:es)?)\b/i;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const OPAQUE_IDENTIFIER =
  /\b(?:[A-Za-z]{21}|(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+)\b/;
const HTTP_URL = /\bhttps?:\/\/[^\s<>()]+/gi;

const MESSAGES: Record<CardFacingViolationCode, string> = {
  invalid_value: "The value must be plain text.",
  local_path: "Local filesystem locations are not allowed.",
  file_url: "Local file URLs are not allowed.",
  internal_url: "Private or internal URLs are not allowed.",
  temp_outputs: "Temporary output locations are not allowed.",
  internal_term: "Internal implementation terminology is not allowed.",
  internal_name: "Private people, product, or tool names are not allowed.",
  internal_identifier: "Internal identifiers are not allowed.",
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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  ) {
    return false;
  }
  const [a, b] = parts.map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isInternalHostname(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  } else {
    host = host.replace(/\.$/, "");
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host === "home.arpa" ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) {
    if (
      host === "::" ||
      host === "::1" ||
      /^f[cd][0-9a-f:]*$/i.test(host) ||
      /^fe[89ab][0-9a-f:]*$/i.test(host)
    ) {
      return true;
    }
    const mappedIpv4 = host.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mappedHex) {
      const address =
        (Number.parseInt(mappedHex[1], 16) << 16) |
        Number.parseInt(mappedHex[2], 16);
      return isPrivateIpv4(
        [
          (address >>> 24) & 255,
          (address >>> 16) & 255,
          (address >>> 8) & 255,
          address & 255,
        ].join("."),
      );
    }
    return false;
  }
  return !host.includes(".");
}

function hasInternalUrl(text: string): boolean {
  for (const match of text.matchAll(HTTP_URL)) {
    try {
      if (isInternalHostname(new URL(match[0]).hostname)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function hasBareInternalHost(text: string): boolean {
  const withoutUrls = text.replace(HTTP_URL, "");
  for (const match of withoutUrls.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (isPrivateIpv4(match[0])) return true;
  }
  for (const match of withoutUrls.matchAll(/\[([0-9a-f:.]+)\](?::\d{1,5})?/gi)) {
    if (isInternalHostname(match[1])) return true;
  }
  if (
    /\b(?:localhost|(?:[a-z0-9-]+\.)+(?:local|internal|lan)|(?:[a-z0-9-]+\.)*home\.arpa)\.?(?::\d{1,5})?/i.test(
      withoutUrls,
    )
  ) {
    return true;
  }
  for (const match of withoutUrls.matchAll(/\b([a-z][a-z0-9-]{1,62}):(\d{2,5})\b/gi)) {
    const port = Number(match[2]);
    if (port <= 65_535 && isInternalHostname(match[1])) return true;
  }
  return false;
}

function hasLocalPath(text: string): boolean {
  return LOCAL_PATH.test(text.replace(HTTP_URL, ""));
}

function scanText(
  value: unknown,
  field: string,
  includeInternalUrls: boolean,
): CardFacingViolation[] {
  const violations: CardFacingViolation[] = [];
  if (typeof value !== "string") {
    addViolation(violations, field, "invalid_value");
    return violations;
  }
  if (FILE_URL.test(value)) addViolation(violations, field, "file_url");
  if (hasLocalPath(value)) addViolation(violations, field, "local_path");
  if (
    includeInternalUrls &&
    (hasInternalUrl(value) || hasBareInternalHost(value))
  ) {
    addViolation(violations, field, "internal_url");
  }
  if (TEMP_OUTPUTS.test(value)) addViolation(violations, field, "temp_outputs");
  if (INTERNAL_TERM.test(value)) addViolation(violations, field, "internal_term");
  if (INTERNAL_NAME.test(value)) addViolation(violations, field, "internal_name");
  if (UUID.test(value) || OPAQUE_IDENTIFIER.test(value)) {
    addViolation(violations, field, "internal_identifier");
  }
  return violations;
}

function result(violations: CardFacingViolation[]): CardFacingValidation {
  return { ok: violations.length === 0, violations };
}

export function validateCardFacingText(
  text: unknown,
  field = "text",
): CardFacingValidation {
  return result(scanText(text, field, true));
}

export function validateCardFacingFilename(
  filename: unknown,
  field = "filename",
): CardFacingValidation {
  const violations = scanText(filename, field, false);
  if (
    typeof filename !== "string" ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    addViolation(violations, field, "local_path");
  }
  if (
    typeof filename !== "string" ||
    filename.startsWith(".") ||
    !SUPPORTED_FILE_EXTENSION.test(filename)
  ) {
    addViolation(violations, field, "unsupported_file_type");
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
