import { readFileSync, writeFileSync } from 'node:fs';
import { TriageInputSchema } from '../dist/policy.js';

const path = new URL('../openclaw.plugin.json', import.meta.url);
const current = readFileSync(path, 'utf8');
const manifest = JSON.parse(current);
manifest.configSchema.properties.triage = TriageInputSchema;
const updated = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(JSON.parse(updated))) throw new Error('Manifest schema differs: run npm run manifest:sync');
} else writeFileSync(path, updated);
