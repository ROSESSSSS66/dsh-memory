#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function normalizeRel(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function resolveNpmCli() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function runNpmPackDryRun() {
  const npmCli = resolveNpmCli();
  const res = npmCli
    ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
        cwd: projectRoot,
        encoding: 'utf8',
      })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: projectRoot,
        encoding: 'utf8',
      });

  if (res.error) {
    throw new Error(`Failed to execute npm pack --dry-run --json: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `npm pack --dry-run --json exited with code ${res.status}:\n${res.stderr || res.stdout}`
    );
  }

  const raw = (res.stdout || '').trim();
  const jsonStart = raw.indexOf('[');
  if (jsonStart < 0) {
    throw new Error(`Unexpected npm pack --dry-run --json output:\n${raw}`);
  }
  const parsed = JSON.parse(raw.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length === 0 || !Array.isArray(parsed[0].files)) {
    throw new Error('npm pack --dry-run --json returned no tarball entries');
  }
  return parsed[0];
}

function collectExportTargets(value, out) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      collectExportTargets(nested, out);
    }
  }
}

function main() {
  const errors = [];
  const pkgPath = path.join(projectRoot, 'package.json');
  const screenshotsPath = path.join(projectRoot, 'screenshots.json');

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const packInfo = runNpmPackDryRun();
  const packedPaths = new Set(packInfo.files.map((f) => normalizeRel(f.path)));

  // 1. Zero runtime dependencies
  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  if (runtimeDeps.length > 0) {
    errors.push(
      `Expected 0 runtime dependencies in package.json, found: ${runtimeDeps.join(', ')}`
    );
  }

  // 2. Zero sourcemap files in tarball
  const mapFiles = [...packedPaths].filter((p) => p.endsWith('.map'));
  if (mapFiles.length > 0) {
    errors.push(`Tarball must not contain .map sourcemaps, found: ${mapFiles.join(', ')}`);
  }

  // 3. Zero dev-only eval-cli artifacts in tarball
  const evalFiles = [...packedPaths].filter((p) => p.startsWith('dist/eval-cli'));
  if (evalFiles.length > 0) {
    errors.push(`Tarball must not contain dev-only eval-cli files, found: ${evalFiles.join(', ')}`);
  }

  // 4. Every file in screenshots.json must exist in tarball
  if (fs.existsSync(screenshotsPath)) {
    const screenshots = JSON.parse(fs.readFileSync(screenshotsPath, 'utf8'));
    if (!Array.isArray(screenshots) || screenshots.length === 0) {
      errors.push('screenshots.json must be a non-empty array');
    } else {
      for (const shot of screenshots) {
        const rel = normalizeRel(shot);
        if (!packedPaths.has(rel)) {
          errors.push(`Screenshot listed in screenshots.json missing from tarball: ${rel}`);
        }
      }
    }
  } else {
    errors.push('screenshots.json not found');
  }

  // 5. Every entry in package.json main, types, icon, dsh.bundle.patch, and exports must exist in tarball
  const singleTargets = [pkg.main, pkg.types, pkg.icon, pkg.dsh?.bundle?.patch].filter(Boolean);
  const exportTargets = [];
  collectExportTargets(pkg.exports, exportTargets);

  for (const target of [...singleTargets, ...exportTargets]) {
    const rel = normalizeRel(target);
    if (rel.includes('*')) {
      const prefix = rel.split('*')[0];
      const matched = [...packedPaths].filter((p) => p.startsWith(prefix));
      if (matched.length === 0) {
        errors.push(`Wildcard export "${target}" matched 0 files in tarball`);
      }
    } else if (!packedPaths.has(rel)) {
      errors.push(`Package manifest target missing from tarball: ${rel}`);
    }
  }

  // 6. Required SQL migrations and postinstall script
  const requiredFiles = [
    'src/core/migrations/001_init.sql',
    'src/core/migrations/002_session_owners.sql',
    'src/core/migrations/003_integrity_and_indexes.sql',
    'scripts/postinstall.mjs',
  ];
  for (const reqFile of requiredFiles) {
    if (!packedPaths.has(reqFile)) {
      errors.push(`Required runtime asset missing from tarball: ${reqFile}`);
    }
  }

  // 7. Ensure dist/index.d.ts does not reference unshipped chunk .d.ts files
  const dtsPath = path.join(projectRoot, 'dist', 'index.d.ts');
  if (fs.existsSync(dtsPath)) {
    const dtsText = fs.readFileSync(dtsPath, 'utf8');
    const relImportRe = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;
    let match = relImportRe.exec(dtsText);
    while (match !== null) {
      const target = match[1].replace(/\.js$/, '.d.ts');
      const resolvedRel = normalizeRel(path.posix.join('dist', target));
      if (!packedPaths.has(resolvedRel)) {
        errors.push(`dist/index.d.ts references unshipped declaration file: ${match[1]}`);
      }
      match = relImportRe.exec(dtsText);
    }
  }

  if (errors.length > 0) {
    console.error('[pack:check] FAILED:');
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  const sizeKb = (packInfo.size / 1024).toFixed(1);
  const unpackedKb = (packInfo.unpackedSize / 1024).toFixed(1);
  console.log(
    `[pack:check] PASSED: ${packInfo.entryCount} files (${sizeKb} kB packed / ${unpackedKb} kB unpacked), 0 .map files, 0 runtime deps.`
  );
}

try {
  main();
} catch (err) {
  console.error('[pack:check] ERROR:', err?.message || err);
  process.exit(1);
}
