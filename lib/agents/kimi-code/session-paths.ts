import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LITELLM_KIMI_CODE_HOME } from "../../config";
import { kimiCodeTaskHome } from "./policy";

export function ensureKimiCodeTaskHome(taskId: string): string {
  const home = path.resolve(LITELLM_KIMI_CODE_HOME);
  const taskHome = path.resolve(kimiCodeTaskHome(taskId));
  if (taskHome !== path.join(home, taskId)) {
    throw new Error("Kimi Code task path escapes the configured home");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(taskHome, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(taskHome, "skills"), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(taskHome, "settlements"), { recursive: true, mode: 0o700 });
  return taskHome;
}

export function createKimiCodeSettlementPath(taskId: string): string {
  const taskHome = ensureKimiCodeTaskHome(taskId);
  return path.join(taskHome, "settlements", `${randomUUID()}.json`);
}

export function assertKimiCodeSettlement(settlementFile: string): void {
  if (!existsSync(settlementFile)) {
    throw new Error("Kimi Code process settlement evidence is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settlementFile, "utf8"));
  } catch {
    throw new Error("Kimi Code process settlement evidence is malformed");
  }
  const record = parsed as {
    status?: unknown;
    survivors?: unknown;
    detail?: unknown;
    child_environment?: {
      credential_keys?: unknown;
      home_is_task_home?: unknown;
    };
  };
  if (
    record.status !== "settled"
    || !Array.isArray(record.survivors)
    || record.survivors.length > 0
  ) {
    throw new Error(
      `Kimi Code process tree did not settle${
        typeof record.detail === "string" ? `: ${record.detail}` : ""
      }`,
    );
  }
  if (
    !record.child_environment
    || !Array.isArray(record.child_environment.credential_keys)
    || record.child_environment.credential_keys.length !== 1
    || record.child_environment.credential_keys[0] !== "KIMI_API_KEY"
    || record.child_environment.home_is_task_home !== true
  ) {
    throw new Error("Kimi Code child environment isolation could not be proven");
  }
}

export type KimiCodeIsolationEvidence = {
  taskStateIsolated: boolean;
  relayCredentialOnly: boolean;
  ambientCredentialLeak: boolean;
};

export function readKimiCodeIsolationEvidence(
  taskId: string,
): KimiCodeIsolationEvidence {
  const taskHome = path.resolve(kimiCodeTaskHome(taskId));
  const settlements = path.join(taskHome, "settlements");
  let files: string[];
  try {
    files = readdirSync(settlements)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(settlements, name));
  } catch {
    files = [];
  }
  let taskStateIsolated = files.length > 0;
  let relayCredentialOnly = files.length > 0;
  let ambientCredentialLeak = false;
  for (const file of files) {
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as {
        child_environment?: {
          credential_keys?: unknown;
          home_is_task_home?: unknown;
        };
      };
      const credentialKeys = record.child_environment?.credential_keys;
      const isolated = record.child_environment?.home_is_task_home === true;
      const relayOnly =
        Array.isArray(credentialKeys)
        && credentialKeys.length === 1
        && credentialKeys[0] === "KIMI_API_KEY";
      taskStateIsolated &&= isolated;
      relayCredentialOnly &&= relayOnly;
      ambientCredentialLeak ||= Array.isArray(credentialKeys)
        && credentialKeys.some((key) => key !== "KIMI_API_KEY");
    } catch {
      taskStateIsolated = false;
      relayCredentialOnly = false;
    }
  }
  return {
    taskStateIsolated,
    relayCredentialOnly,
    ambientCredentialLeak,
  };
}

export function removeKimiCodeTaskState(taskId: string): void {
  const home = path.resolve(LITELLM_KIMI_CODE_HOME);
  const taskHome = path.resolve(kimiCodeTaskHome(taskId));
  if (taskHome !== path.join(home, taskId)) {
    throw new Error("Kimi Code task path escapes the configured home");
  }
  let stat;
  try {
    stat = lstatSync(taskHome);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(taskHome);
    return;
  }
  const realHome = realpathSync(home);
  const realTaskHome = realpathSync(taskHome);
  if (path.dirname(realTaskHome) !== realHome) {
    throw new Error("Kimi Code task state parent is not the configured home");
  }
  rmSync(realTaskHome, { recursive: true, force: true });
}
