import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface OperatorSessionIndexRecord {
  session_id: string;
  task_id: string;
  project_id: string;
  task_title: string;
  project_path: string;
  harness: "codex" | "claude" | "prime" | "kimi-code";
  model: string;
  updated_at: string;
}

export function appendOperatorSessionIndex(
  home: string,
  record: OperatorSessionIndexRecord,
): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "operator-session-index.jsonl");
  appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
