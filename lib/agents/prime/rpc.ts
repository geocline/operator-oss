import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/**
 * Line-buffered JSONL RPC client for `prime-agent --mode rpc`.
 *
 * Protocol: requests are `{id, type, ...fields}` written to stdin; the CLI
 * replies with `{type: "response", id, success, data|error}` and interleaves
 * streamed events (agent_start, message_*, tool_execution_*, agent_end) on the
 * same stdout. Stdout is protocol-only; stderr is captured as a bounded tail
 * for actionable errors.
 *
 * The child owns a fresh POSIX process group so stop() can settle the whole
 * tree (workers, kernels, subagents) - RPC abort first, then SIGTERM, then
 * SIGKILL against the group. Every failure path stops the process before the
 * caller may collect final events or usage.
 */

export type PrimeRpcEvent = { type: string } & Record<string, unknown>;

export interface PrimeRpcResponse {
  type: "response";
  id: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface PrimeRpcOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onEvent?: (event: PrimeRpcEvent) => void;
  signal?: AbortSignal;
  /** Grace period after RPC abort before SIGTERM (ms). */
  abortGraceMs?: number;
  /** Grace period after SIGTERM before SIGKILL (ms). */
  termGraceMs?: number;
  stderrTailBytes?: number;
  defaultRequestTimeoutMs?: number;
  /** How many recent events to retain for terminal-evidence checks. */
  recentEventLimit?: number;
}

interface PendingRequest {
  resolve: (response: PrimeRpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  type: string;
}

interface EventWaiter {
  predicate: (event: PrimeRpcEvent) => boolean;
  resolve: (event: PrimeRpcEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PrimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class PrimeRpcClient {
  readonly settled: Promise<PrimeExit>;

  private readonly child: ChildProcess;
  private readonly onEvent?: (event: PrimeRpcEvent) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly recent: PrimeRpcEvent[] = [];
  private readonly recentLimit: number;
  private readonly abortGraceMs: number;
  private readonly termGraceMs: number;
  private readonly stderrTailBytes: number;
  private readonly defaultTimeoutMs: number;
  private stdoutBuffer = "";
  private stderrTail = "";
  private sequence = 0;
  private failure: Error | null = null;
  private stopPromise: Promise<PrimeExit> | null = null;
  private exit: PrimeExit | null = null;

  constructor(options: PrimeRpcOptions) {
    this.onEvent = options.onEvent;
    this.abortGraceMs = options.abortGraceMs ?? 3_000;
    this.termGraceMs = options.termGraceMs ?? 3_000;
    this.stderrTailBytes = options.stderrTailBytes ?? 8_192;
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? 120_000;
    this.recentLimit = options.recentEventLimit ?? 500;

    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      // Own process group on POSIX so the full tree can be signaled at once.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrTailBytes);
    });

    let settle!: (exit: PrimeExit) => void;
    this.settled = new Promise<PrimeExit>((resolve) => {
      settle = resolve;
    });
    this.child.once("exit", (code, signal) => {
      this.exit = { code, signal };
      this.failAllPending(this.exitError());
      settle(this.exit);
    });
    this.child.once("error", (error) => {
      // Spawn failures (missing binary, no exec bit) never fire "exit" — the
      // process is settled by definition, so resolve here too or stop() hangs.
      this.failure = this.failure ?? error;
      this.failAllPending(error);
      if (!this.exit) {
        this.exit = { code: null, signal: null };
        settle(this.exit);
      }
    });

    if (options.signal) {
      if (options.signal.aborted) void this.stop({ signalReason: "aborted before start" });
      else options.signal.addEventListener("abort", () => void this.stop({ signalReason: "external abort" }), { once: true });
    }
  }

  get exited(): boolean {
    return this.exit !== null;
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  recentEvents(): PrimeRpcEvent[] {
    return [...this.recent];
  }

  async request(
    type: string,
    fields: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<PrimeRpcResponse> {
    if (this.failure) throw this.failure;
    if (this.exit) throw this.exitError();
    const id = `req-${++this.sequence}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const response = new Promise<PrimeRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Prime RPC ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
    });
    this.child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const result = await response;
    if (!result.success) {
      throw new Error(`Prime RPC ${type} failed: ${result.error ?? "unknown error"}`);
    }
    return result;
  }

  waitForEvent(
    predicate: (event: PrimeRpcEvent) => boolean,
    options: { timeoutMs?: number; label?: string } = {},
  ): Promise<PrimeRpcEvent> {
    const already = this.recent.find(predicate);
    if (already) return Promise.resolve(already);
    if (this.failure) return Promise.reject(this.failure);
    if (this.exit) return Promise.reject(this.exitError());
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate,
        resolve: (event) => {
          clearTimeout(waiter.timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          reject(error);
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${options.label ?? "Prime event"}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /**
   * Settle the turn: RPC abort, wait briefly for a terminal event or exit,
   * then SIGTERM -> SIGKILL the full process group. Idempotent; always
   * resolves with the final exit. Callers must await this before collecting
   * final events or usage in any error path.
   */
  stop(options: { signalReason?: string } = {}): Promise<PrimeExit> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(options.signalReason);
    return this.stopPromise;
  }

  private async performStop(reason?: string): Promise<PrimeExit> {
    if (this.exit) return this.exit;
    // Snapshot the descendant tree while the parent is still alive: the npm
    // wrapper re-execs the real binary in a NEW process group (own setsid), so
    // a plain group kill misses it — and once the wrapper exits, the orphan
    // reparents to PID 1 and the ppid chain is gone.
    let tree = this.processTree();
    // Polite phase: RPC abort, then wait for a terminal signal from the agent.
    try {
      await this.request("abort", {}, { timeoutMs: Math.min(this.abortGraceMs, 2_000) });
      await Promise.race([
        this.waitForEvent((e) => e.type === "agent_end", { timeoutMs: this.abortGraceMs, label: "aborted agent_end" }),
        this.settled,
      ]);
    } catch {
      // Unresponsive protocol - fall through to signals.
    }
    tree = [...new Set([...tree, ...this.processTree()])];
    if (!this.exit || this.anyAlive(tree)) {
      this.signalTree(tree, "SIGTERM");
      await Promise.race([this.settled, delay(this.termGraceMs)]);
      await this.waitForTreeExit(tree, this.termGraceMs);
    }
    if (!this.exit || this.anyAlive(tree)) {
      this.signalTree([...new Set([...tree, ...this.processTree()])], "SIGKILL");
      await this.settled;
      await this.waitForTreeExit(tree, this.termGraceMs);
    }
    // Final sweep: catch a straggler forked after the earlier snapshots (it
    // still carries the child's inherited process group even once orphaned).
    for (let pass = 0; pass < 2; pass++) {
      const stragglers = this.processTree().filter((pid) => pid !== this.child.pid);
      const alive = stragglers.filter((pid) => this.anyAlive([pid]));
      if (!alive.length) break;
      this.signalTree(alive, "SIGKILL");
      await delay(150);
    }
    if (reason && !this.failure) this.failure = new Error(`Prime turn stopped: ${reason}`);
    return this.exit ?? (await this.settled);
  }

  /**
   * The spawned pid plus every live descendant (ps ppid links) plus every pid
   * still in the child's original process group — the group scan catches a
   * worker that was spawned after a ppid snapshot and reparented to PID 1
   * when its parent exited, as long as it kept the inherited group.
   */
  private processTree(): number[] {
    const root = this.child.pid;
    if (!root || process.platform === "win32") return root ? [root] : [];
    try {
      const out = execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], { encoding: "utf8" });
      const children = new Map<number, number[]>();
      const byGroup = new Map<number, number[]>();
      for (const line of out.trim().split("\n")) {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid)!.push(pid);
        if (Number.isInteger(pgid)) {
          if (!byGroup.has(pgid)) byGroup.set(pgid, []);
          byGroup.get(pgid)!.push(pid);
        }
      }
      const acc = new Set<number>([root, ...(byGroup.get(root) ?? [])]);
      const queue = [...acc];
      while (queue.length) {
        for (const child of children.get(queue.shift()!) ?? []) {
          if (!acc.has(child)) {
            acc.add(child);
            queue.push(child);
          }
        }
      }
      return [...acc];
    } catch {
      return [root];
    }
  }

  private anyAlive(pids: number[]): boolean {
    return pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }

  private async waitForTreeExit(pids: number[], graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.anyAlive(pids)) await delay(50);
  }

  /** Signal every captured pid AND its process group — escaped groups included. */
  private signalTree(pids: number[], signal: NodeJS.Signals): void {
    if (process.platform === "win32") {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
      return;
    }
    const groups = new Set<number>();
    for (const pid of pids) {
      try {
        const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
        if (Number.isInteger(pgid) && pgid > 1) groups.add(pgid);
      } catch {
        // Process already gone; its pid signal below is a no-op too.
      }
    }
    for (const pgid of groups) {
      try {
        process.kill(-pgid, signal);
      } catch {
        // Group already gone.
      }
    }
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let lineEnd: number;
    while ((lineEnd = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, lineEnd).replace(/\r$/, "").trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(lineEnd + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.protocolFailure(new Error(`Prime RPC emitted non-JSON stdout (malformed protocol): ${line.slice(0, 300)}`));
        return;
      }
      const message = parsed as PrimeRpcEvent | PrimeRpcResponse;
      if (message.type === "response" && typeof (message as PrimeRpcResponse).id === "string") {
        const response = message as PrimeRpcResponse;
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          pending.resolve(response);
        }
        continue;
      }
      const event = message as PrimeRpcEvent;
      this.recent.push(event);
      if (this.recent.length > this.recentLimit) this.recent.shift();
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(event)) {
          this.waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
      this.onEvent?.(event);
    }
  }

  private protocolFailure(error: Error): void {
    if (!this.failure) this.failure = error;
    this.failAllPending(error);
    // A corrupted protocol stream is unrecoverable; settle the tree.
    void this.stop({ signalReason: error.message });
  }

  private exitError(): Error {
    if (this.failure) return this.failure;
    const tail = this.stderrTail.trim();
    const status = this.exit
      ? `exited with code ${this.exit.code}${this.exit.signal ? ` (signal ${this.exit.signal})` : ""}`
      : "exited";
    return new Error(`prime-agent ${status}${tail ? `: ${tail.slice(-1_000)}` : ""}`);
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`Prime RPC ${pending.type} failed: ${error.message}`));
    }
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startPrimeRpc(options: PrimeRpcOptions): PrimeRpcClient {
  return new PrimeRpcClient(options);
}
