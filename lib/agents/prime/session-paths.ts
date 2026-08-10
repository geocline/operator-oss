import { lstatSync, mkdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { LITELLM_PRIME_HOME } from "@/lib/config";

export interface PrimeTaskPaths {
  taskHome: string;
  configDir: string;
  sessionDir: string;
}

// Path segments come from our own DB, but Prime state is deleted recursively
// on task removal, so containment is enforced here rather than trusted.
function validateSegment(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Prime ${name} must be nonempty`);
  if (trimmed !== value) throw new Error(`Prime ${name} must not contain surrounding whitespace`);
  if (/[/\\]/.test(value)) throw new Error(`Prime ${name} must not contain path separators`);
  if (value === "." || value === "..") throw new Error(`Prime ${name} must not be a relative path segment`);
  return value;
}

export function primeTaskPaths(taskId: string, generation: number): PrimeTaskPaths {
  validateSegment("task id", taskId);
  if (!Number.isInteger(generation) || generation < 0) {
    throw new Error("Prime session generation must be a nonnegative integer");
  }
  const taskHome = path.resolve(LITELLM_PRIME_HOME, taskId);
  const home = path.resolve(LITELLM_PRIME_HOME);
  if (taskHome !== path.join(home, taskId)) {
    throw new Error("Prime task path escapes the Prime home");
  }
  return {
    taskHome,
    configDir: path.join(taskHome, "config"),
    sessionDir: path.join(taskHome, "sessions", String(generation)),
  };
}

export function ensurePrimeTaskDirs(taskId: string, generation: number): PrimeTaskPaths {
  const paths = primeTaskPaths(taskId, generation);
  for (const dir of [path.resolve(LITELLM_PRIME_HOME), paths.taskHome, paths.configDir, paths.sessionDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/**
 * Hard-delete one task's Prime state. Called from the task DELETE route after
 * the abort owner has tripped the turn, and again from a delayed re-sweep in
 * case a dying Prime process flushed a straggler write.
 *
 * Containment is defensive on every axis: the task id is re-validated, the
 * resolved parent must be the configured Prime home (no traversal even via a
 * symlinked home), and a symlinked task directory is removed as a LINK — never
 * followed into whatever it points at.
 */
export function removePrimeTaskState(taskId: string): void {
  validateSegment("task id", taskId);
  const home = path.resolve(LITELLM_PRIME_HOME);
  const taskHome = path.join(home, taskId);

  let stat;
  try {
    stat = lstatSync(taskHome);
  } catch {
    return; // Never ran Prime — nothing to retire.
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(taskHome);
    return;
  }
  // The parent must resolve to the Prime home itself (a hostile symlink swap
  // of the home directory would otherwise redirect the recursive delete).
  // Residual TOCTOU between this check and rmSync requires same-user code
  // running DURING deletion; the delete route settles the task's whole Prime
  // process tree first (settlePrimeTask), so nothing from this task is left
  // to race it. Remove via the verified resolved path, not the raw one.
  const realHome = realpathSync(home);
  const realTaskHome = realpathSync(taskHome);
  if (path.dirname(realTaskHome) !== realHome) {
    throw new Error("Prime task state parent is not the configured Prime home");
  }
  rmSync(realTaskHome, { recursive: true, force: true });
}
