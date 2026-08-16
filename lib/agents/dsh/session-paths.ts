import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LITELLM_DSH_HOME } from "../../config";

export interface DshTaskPaths {
  taskHome: string;
  configDir: string;
  sessionDir: string;
  /** The cordis.yml the driver materializes fresh every turn (no secrets). */
  configFile: string;
}

// Path segments come from our own DB, but dsh state is deleted recursively on
// task removal, so containment is enforced here rather than trusted (mirrors
// lib/agents/prime/session-paths.ts).
function validateSegment(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dsh ${name} must be nonempty`);
  if (trimmed !== value) throw new Error(`dsh ${name} must not contain surrounding whitespace`);
  if (/[/\\]/.test(value)) throw new Error(`dsh ${name} must not contain path separators`);
  if (value === "." || value === "..") throw new Error(`dsh ${name} must not be a relative path segment`);
  return value;
}

export function dshTaskPaths(taskId: string, generation: number): DshTaskPaths {
  validateSegment("task id", taskId);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("dsh session generation must be a nonnegative integer");
  }
  const taskHome = path.resolve(LITELLM_DSH_HOME, taskId);
  const home = path.resolve(LITELLM_DSH_HOME);
  if (taskHome !== path.join(home, taskId)) {
    throw new Error("dsh task path escapes the dsh home");
  }
  const configDir = path.join(taskHome, "config");
  return {
    taskHome,
    configDir,
    sessionDir: path.join(taskHome, "sessions", String(generation)),
    configFile: path.join(configDir, "cordis.yml"),
  };
}

export function ensureDshTaskDirs(taskId: string, generation: number): DshTaskPaths {
  const paths = dshTaskPaths(taskId, generation);
  for (const dir of [path.resolve(LITELLM_DSH_HOME), paths.taskHome, paths.configDir, paths.sessionDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/**
 * Hard-delete one task's dsh state. Called from the task DELETE route after
 * the abort owner has tripped the turn (mirrors
 * lib/agents/prime/session-paths.ts's removePrimeTaskState verbatim).
 */
export function removeDshTaskState(taskId: string): void {
  validateSegment("task id", taskId);
  const home = path.resolve(LITELLM_DSH_HOME);
  const taskHome = path.join(home, taskId);

  let stat;
  try {
    stat = lstatSync(taskHome);
  } catch {
    return; // Never ran dsh — nothing to retire.
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(taskHome);
    return;
  }
  const realHome = realpathSync(home);
  const realTaskHome = realpathSync(taskHome);
  if (path.dirname(realTaskHome) !== realHome) {
    throw new Error("dsh task state parent is not the configured dsh home");
  }
  rmSync(realTaskHome, { recursive: true, force: true });
}
