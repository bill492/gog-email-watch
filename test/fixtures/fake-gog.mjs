#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const fixture = JSON.parse(readFileSync(process.env.GOG_TEST_FIXTURE, 'utf8'));
const args = process.argv.slice(2);
appendFileSync(process.env.GOG_TEST_CALLS, `${JSON.stringify(args)}\n`);

const command = args.slice(args.indexOf('gmail'));
if (fixture.probeWritableDb) {
  const db = new DatabaseSync(process.env.GOG_TEST_DB);
  try {
    db.exec('BEGIN IMMEDIATE; COMMIT');
  } finally {
    db.close();
  }
}
let result;
if (command[1] === 'messages' && command[2] === 'search') {
  result = fixture.search;
} else if (command[1] === 'thread' && command[2] === 'get') {
  result = fixture.threads?.[command[3]];
} else if (command[1] === 'send') {
  if (fixture.sendFailure) {
    process.stderr.write('controlled fake gog send failure\n');
    process.exit(1);
  }
  result = fixture.send ?? { id: 'sent-1' };
}

if (result === undefined) {
  process.stderr.write(`unsupported fake gog command: ${command.join(' ')}\n`);
  process.exit(2);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
