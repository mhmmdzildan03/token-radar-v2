// Token Radar v2 — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot (--input <file|dir>, default /input/snapshot.json), builds the
// radar with lib/model.ts, and writes the hand-in to the output directory
// (MAKEFUN_OUTPUT_DIR, default /output): board.json, data.js for the page, a copy of
// dashboard/ and screenshots/, and dossier.json from vendor/makefun-board.ts.
// The program is deterministic: the same snapshot writes the same bytes on both runs.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1]) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
}

const inputPath = flag('input', '/input');
const snapshotFile = inputPath.endsWith('.json') ? inputPath : join(inputPath, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(`token-radar-v2: no snapshot at ${snapshotFile}\n`);
  process.exit(2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const radar = buildRadar(snapshot);
const issue = boardIssue(radar.rows, snapshot);
if (issue !== null) {
  process.stderr.write(`token-radar-v2: board refused by the gate's rules: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: radar.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

function copyTree(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from, { withFileTypes: true })) {
    if (name.name.startsWith('.')) continue;
    const src = join(from, name.name);
    const dst = join(to, name.name);
    if (name.isDirectory()) copyTree(src, dst);
    else if (name.isFile()) copyFileSync(src, dst);
  }
}
copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));

const dossier = buildDossier(outDir, { text_max_bytes: 65_536 });
writeFileSync(join(outDir, 'dossier.json'), dossier);
process.stdout.write(
  `token-radar-v2: ${radar.rows.length} rows, watchlist ${radar.watchlistCount}/${radar.watchlistCount}, ` +
  `dossier ${dossier.length} bytes, checksum ${radar.checksum}\n`,
);
