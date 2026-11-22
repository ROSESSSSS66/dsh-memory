#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const evalCliPath = path.join(projectRoot, 'dist', 'eval-cli.js');
if (!fs.existsSync(evalCliPath)) {
  console.error('[dsh-memory] dist/eval-cli.js not found. Run "npm run build" first.');
  process.exit(1);
}

const res = spawnSync(process.execPath, [evalCliPath, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (res.error) {
  console.error('[dsh-memory] Failed to run eval CLI:', res.error.message);
  process.exit(1);
}

process.exit(res.status ?? 1);
