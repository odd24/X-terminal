import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Resolve only installed, locked packages; never include user runtime data.
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const rows = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location.includes('node_modules/') || entry.link) continue;
  const manifestPath = path.join(location, 'package.json');
  if (!fs.existsSync(manifestPath)) continue; // Optional packages for other platforms.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  rows.push({ ecosystem: 'npm', name: manifest.name, version: manifest.version,
    license: manifest.license ?? 'UNKNOWN', source: entry.resolved });
}
if (process.argv.includes('--cargo')) {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  for (const pkg of metadata.packages) {
    const localPath = path.relative(metadata.workspace_root, path.dirname(pkg.manifest_path)).replaceAll('\\', '/');
    rows.push({ ecosystem: 'cargo', name: pkg.name, version: pkg.version,
      license: pkg.license ?? 'UNKNOWN', source: pkg.source ?? (localPath.startsWith('vendor/') ? `vendored:${localPath}` : 'workspace') });
  }
}
rows.sort((a, b) => `${a.ecosystem}/${a.name}/${a.version}`.localeCompare(`${b.ecosystem}/${b.name}/${b.version}`));
fs.mkdirSync('docs/evidence', { recursive: true });
fs.writeFileSync('docs/evidence/dependency-licenses.json', JSON.stringify(rows, null, 2) + '\n');
console.log(`Recorded ${rows.length} installed dependency licenses.`);
