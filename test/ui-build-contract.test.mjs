import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);

test('the repository runtime and Vite build contract is reproducible', async () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(new URL('package-lock.json', root), 'utf8'));
  const nvmrc = fs.existsSync(new URL('.nvmrc', root))
    ? fs.readFileSync(new URL('.nvmrc', root), 'utf8').trim()
    : null;
  const failures = [];

  if (nvmrc !== '24') failures.push(`.nvmrc expected "24", received ${JSON.stringify(nvmrc)}`);
  if (pkg.engines?.node !== '24.x')
    failures.push(
      `package.json engines.node expected "24.x", received ${JSON.stringify(pkg.engines?.node)}`,
    );
  if (lock.packages?.['']?.engines?.node !== '24.x')
    failures.push(
      `lockfile engines.node expected "24.x", received ${JSON.stringify(lock.packages?.['']?.engines?.node)}`,
    );
  if (!/(?:^|\s)vite\s+build(?:\s|$)/.test(pkg.scripts?.build || ''))
    failures.push('package.json must expose a Vite build command');

  if (JSON.stringify(lock.packages?.['']?.devDependencies) !== JSON.stringify(pkg.devDependencies))
    failures.push('package-lock root devDependencies must match package.json');
  if (!(pkg.dependencies?.react || pkg.devDependencies?.react))
    failures.push('React must be declared');
  if (!(pkg.dependencies?.['@mui/material'] || pkg.devDependencies?.['@mui/material']))
    failures.push('MUI must be declared');
  if (!(pkg.dependencies?.vite || pkg.devDependencies?.vite))
    failures.push('Vite must be declared');
  const viteConfigPath = new URL('vite.config.js', root);
  if (!fs.existsSync(viteConfigPath)) failures.push('vite.config.js must be present');
  else if (
    !/outDir\s*:\s*(?:path\.resolve\(root,\s*['"]dist['"]\)|['"]dist['"])/.test(
      fs.readFileSync(viteConfigPath, 'utf8'),
    )
  )
    failures.push('Vite must emit to dist/');

  const buildCommand = pkg.scripts?.build;
  let viteAvailable = false;
  try {
    import.meta.resolve('vite');
    viteAvailable = true;
  } catch {}
  if (buildCommand && viteAvailable) {
    const buildRoot = fs.mkdtempSync(
      path.join(process.env.TMPDIR || '/tmp', `dev-dashboard-build-contract-${process.pid}-`),
    );
    try {
      const build = spawnSync('npm', ['run', 'build', '--', '--outDir', buildRoot], {
        cwd: fileURLToPath(root),
        encoding: 'utf8',
      });
      if (build.status !== 0)
        failures.push(
          `npm run build exited ${build.status}: ${(build.stderr || build.stdout).trim()}`,
        );

      if (build.status === 0 && !fs.existsSync(buildRoot))
        failures.push('successful build must emit its isolated output directory');
      if (build.status === 0 && fs.existsSync(buildRoot)) {
        const files = [];
        const collect = (directory) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) collect(filename);
            else files.push(filename);
          }
        };
        collect(buildRoot);
        if (!files.some((filename) => filename.endsWith('.js')))
          failures.push('build must emit a JavaScript asset');
        if (!files.some((filename) => filename.endsWith('.css')))
          failures.push('build must emit a CSS asset');
      }
    } finally {
      fs.rmSync(buildRoot, { recursive: true, force: true });
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
