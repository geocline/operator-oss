import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
const apply = process.argv.includes("--apply");
const db = new Database(process.env.HOME + "/.zen-orchestrator/orchestrator.db");
const rows = db.prepare(`select t.id, t.title, t.subdir, w.external_card_id card, p.repo_path from workstream_links w join tasks t on t.id=w.task_id join projects p on p.id=t.project_id where w.state='active' and t.subdir=''`).all();
// index every .card-project.json under <lane>/card-projects/*
const idx = new Map();
for (const lane of new Set(rows.map(r => r.repo_path))) {
  const dir = path.join(lane, "card-projects");
  if (!existsSync(dir)) continue;
  for (const d of readdirSync(dir)) {
    const f = path.join(dir, d, ".card-project.json");
    try { const m = JSON.parse(readFileSync(f, "utf8")); if (m.card_id) idx.set(m.card_id, { lane, subdir: "card-projects/" + d, synced: m.last_synced }); } catch {}
  }
}
const upd = db.prepare("update tasks set subdir=?, updated_at=? where id=?");
let hit = 0, miss = [];
for (const r of rows) {
  const m = idx.get(r.card);
  if (!m) { miss.push(r); continue; }
  if (m.lane !== r.repo_path) { miss.push({ ...r, note: "folder in other lane " + m.lane }); continue; }
  hit++;
  console.log(`${apply ? "SET " : "would set"} ${r.title.padEnd(52)} -> ${m.subdir}  (synced ${String(m.synced).slice(0,10)})`);
  if (apply) upd.run(m.subdir, Date.now(), r.id);
}
console.log(`\n${hit} matched, ${miss.length} unmatched`);
for (const r of miss) console.log("  MISS", r.title, "|", r.repo_path, "|", r.card, r.note ?? "");
