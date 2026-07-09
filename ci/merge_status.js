// Runner-side: fold the committed history seed (ci/seed_status.csv) into the
// status master (Finalop1lack/download_status.csv, pulled from Drive) WITHOUT
// clobbering anything already there. Keyed by the Index (first CSV column).
//
//   - Rows already present in the master win (they're newer scrape results).
//   - Seed rows for indices NOT yet in the master are added.
//   - Idempotent: once the seed's indices are in the master, re-running adds nothing.
//
// The Index is always a bare integer in column 1, so we key on it without needing
// to fully parse the (comma-containing) rest of the line.
const fs = require("fs");
const path = require("path");

const seedPath = path.resolve(__dirname, "seed_status.csv");
const masterPath = path.resolve(__dirname, "..", "Finalop1lack", "download_status.csv");

if (!fs.existsSync(seedPath)) {
  console.log("No seed_status.csv — nothing to merge.");
  process.exit(0);
}

const indexOf = (line) => {
  const m = line.match(/^\s*"?(\d+)"?\s*,/);
  return m ? m[1] : null;
};
const splitLines = (txt) => txt.split(/\r?\n/).filter((l) => l.trim() !== "");

const seedLines = splitLines(fs.readFileSync(seedPath, "utf8"));
const seedHeader = seedLines[0];
const seedData = seedLines.slice(1);

let header = seedHeader;
let masterData = [];
if (fs.existsSync(masterPath)) {
  const m = splitLines(fs.readFileSync(masterPath, "utf8"));
  if (m.length) { header = m[0]; masterData = m.slice(1); }
}

const present = new Set(masterData.map(indexOf).filter(Boolean));
let added = 0;
const merged = masterData.slice();
for (const line of seedData) {
  const idx = indexOf(line);
  if (idx && !present.has(idx)) { merged.push(line); present.add(idx); added++; }
}

fs.mkdirSync(path.dirname(masterPath), { recursive: true });
fs.writeFileSync(masterPath, [header, ...merged].join("\n") + "\n");
console.log(`Status merge: master had ${masterData.length} rows, seed added ${added}, total ${merged.length}.`);
