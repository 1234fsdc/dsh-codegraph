// Single source of truth for the plugin version.
//
// lib/mcp.js used to hardcode the clientInfo version and drifted from
// package.json once already; reading the manifest keeps them in lockstep.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached = null;

export function pluginVersion() {
  if (cached) return cached;
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    cached = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
