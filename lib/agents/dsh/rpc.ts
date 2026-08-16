import { execFileSync, spawn, type ChildProcess } from "node:child_process";

/**
 * Real JSON-RPC 2.0 stdio client for the dsh-jsonrpc-agent runtime (the
 * `@deepseek-ai/dsh-sdk-jsonrpc-server` wire protocol - see
 * docs/superpowers/specs/2026-08-16-litellm-dsh-driver.md for the capture
 * evidence). One JSON frame per newline; a frame with `id` + `method` is a
 * request, `id` alone is a response, `method` alone (no `id`) is a
 * notification. Stdout is protocol-only; stderr is captured as a bounded tail
 * for actionable errors - identical convention to lib/agents/prime/rpc.ts.
 *
 * Unlike Prime, this protocol has NO cancel/abort/session-close method
 * (verified against the real `dsh-sdk-protocol` README: "No cancel or
 * session-close methods — a client abandons a turn by closing the runtime
 * process"), so stop() skips the polite RPC-abort phase Prime's client has
 * and goes straight to SIGTERM -> SIGKILL against the process tree.
 */

export type DshNotification = { method: string; params: Record<string, unknown> };

interface DshRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface DshRpcOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification?: (notification: DshNotification) => void;
  signal?: AbortSignal;
  /** Grace period after SIGTERM before SIGKILL (ms). */
  termGraceMs?: number;
  stderrTailBytes?: number;
  defaultRequestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export interface DshExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class DshRpcClient {
  readonly settled: Promise<DshExit>;

  private readonly child: ChildProcess;
  private readonly onNotification?: (notification: DshNotification) => void;
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly termGraceMs: number;
  private readonly stderrTailBytes: number;
  private readonly defaultTimeoutMs: number;
  private stdoutBuffer = "";
  private stderrTail = "";
  private sequence = 0;
  private failure: Error | null = null;
  private stopPromise: Promise<DshExit> | null = null;
  private exit: DshExit | null = null;

  constructor(options: DshRpcOptions) {
    this.onNotification = options.onNotification;
    this.termGraceMs = options.termGraceMs ?? 3_000;
    this.stderrTailBytes = options.stderrTailBytes ?? 8_192;
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? 120_000;

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

    let settle!: (exit: DshExit) => void;
    this.settled = new Promise<DshExit>((resolve) => {
      settle = resolve;
    });
    this.child.once("exit", (code, signal) => {
      this.exit = { code, signal };
      this.failAllPending(this.exitError());
      settle(this.exit);
    });
    this.child.once("error", (error) => {
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

  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.exit) throw this.exitError();
    const id = `req-${++this.sequence}`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dsh RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  /**
   * Settle the turn: there is no polite RPC-abort in this protocol, so this
   * goes straight to SIGTERM -> SIGKILL against the full process tree.
   * Idempotent; always resolves with the final exit.
   */
  stop(options: { signalReason?: string } = {}): Promise<DshExit> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(options.signalReason);
    return this.stopPromise;
  }

  private async performStop(reason?: string): Promise<DshExit> {
    if (this.exit) return this.exit;
    let tree = this.processTree();
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
    for (let pass = 0; pass < 2; pass++) {
      const stragglers = this.processTree().filter((pid) => pid !== this.child.pid);
      const alive = stragglers.filter((pid) => this.anyAlive([pid]));
      if (!alive.length) break;
      this.signalTree(alive, "SIGKILL");
      await delay(150);
    }
    if (reason && !this.failure) this.failure = new Error(`dsh turn stopped: ${reason}`);
    return this.exit ?? (await this.settled);
  }

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
        this.protocolFailure(new Error(`dsh RPC emitted non-JSON stdout (malformed protocol): ${line.slice(0, 300)}`));
        return;
      }
      const message = parsed as { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: DshRpcResponse["error"] };
      if (message.id !== undefined && message.method === undefined) {
        // A response (result or error), keyed by id.
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) {
            pending.reject(new Error(`dsh RPC ${pending.method} failed: ${message.error.message} (${message.error.code})`));
          } else {
            pending.resolve(message.result);
          }
        }
        continue;
      }
      if (message.method !== undefined && message.id === undefined) {
        // A notification.
        this.onNotification?.({ method: message.method, params: message.params ?? {} });
        continue;
      }
      // A request FROM the server (server->client requests are dead capability
      // per the protocol README - "the server never sends one"); ignore rather
      // than crash if one ever arrives.
    }
  }

  private protocolFailure(error: Error): void {
    if (!this.failure) this.failure = error;
    this.failAllPending(error);
    void this.stop({ signalReason: error.message });
  }

  private exitError(): Error {
    if (this.failure) return this.failure;
    const tail = this.stderrTail.trim();
    const status = this.exit
      ? `exited with code ${this.exit.code}${this.exit.signal ? ` (signal ${this.exit.signal})` : ""}`
      : "exited";
    return new Error(`dsh-jsonrpc-agent ${status}${tail ? `: ${tail.slice(-1_000)}` : ""}`);
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(`dsh RPC ${pending.method} failed: ${error.message}`));
    }
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function startDshRpc(options: DshRpcOptions): DshRpcClient {
  return new DshRpcClient(options);
}
