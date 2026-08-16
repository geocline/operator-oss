import { execFileSync } from "node:child_process";

export const KIMI_WIRE_CLI_VERSION = "1.49.0";

const compatible = new Set<string>();

export function assertCompatibleKimiWireCli(executable: string): void {
  if (compatible.has(executable)) return;
  let version = "";
  let help = "";
  try {
    version = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    help = execFileSync(executable, ["--help"], {
      encoding: "utf8",
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `Kimi Code requires official Kimi Wire CLI ${KIMI_WIRE_CLI_VERSION}; compatibility check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!new RegExp(`(?:^|\\s)${KIMI_WIRE_CLI_VERSION.replaceAll(".", "\\.")}$`).test(version)) {
    throw new Error(
      `Kimi Code requires official Kimi Wire CLI ${KIMI_WIRE_CLI_VERSION}; found ${version || "(unknown version)"}.`,
    );
  }
  for (const required of ["--wire", "--work-dir"]) {
    if (!help.includes(required)) {
      throw new Error(
        `Kimi Code Wire CLI ${KIMI_WIRE_CLI_VERSION} is missing SDK-required ${required}.`,
      );
    }
  }
  compatible.add(executable);
}

export function clearKimiWireCliCompatibilityCacheForTest(): void {
  compatible.clear();
}
