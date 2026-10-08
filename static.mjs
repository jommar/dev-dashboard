// static.mjs — serves the Vite build in ./dist and legacy UI files in ./ui.
import fs from 'node:fs';
import path from 'node:path';
import { DASHBOARD_DIR } from './config.mjs';

const DIST_DIR = path.join(DASHBOARD_DIR, 'dist');
const UI_DIR = path.join(DASHBOARD_DIR, 'ui');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function serveFile(res, root, relPath, cacheControl) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch {
    return false;
  }
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, decoded.replace(/^[/\\]+/, ''));
  if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) return false;
  try {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realFile = fs.realpathSync(file);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return false;
    if (!fs.statSync(realFile).isFile()) return false;
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(realFile)] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(fs.readFileSync(realFile));
    return true;
  } catch {
    return false;
  }
}

// Serve a Vite-generated root page or public asset; do not SPA-fallback missing assets.
export function serveBuiltUi(res, pathname) {
  if (!fs.existsSync(DIST_DIR)) return false;
  if (pathname === '/') return serveFile(res, DIST_DIR, 'index.html', 'no-store');
  if (!pathname.startsWith('/assets/') || pathname.includes('\\')) return false;
  return serveFile(res, DIST_DIR, pathname.slice(1), 'public, max-age=31536000, immutable');
}

export function hasBuiltUi() {
  return fs.existsSync(DIST_DIR);
}

// Serve legacy `ui/` files for compatibility while panels are migrated.
export function serveUi(res, relPath) {
  return serveFile(res, UI_DIR, relPath, 'no-store');
}
