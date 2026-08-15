#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { describePigLink, invokePigLinkAction, runPigLinkTests } from './index.js';

function parse(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (key === 'json') { flags.json = true; continue; }
    flags[key] = argv[++i];
  }
  return { positionals, flags };
}

async function inputFrom(flags) {
  if (flags['input-file']) return JSON.parse(await fs.readFile(path.resolve(flags['input-file']), 'utf8'));
  if (flags.input) return JSON.parse(flags.input);
  return {};
}

function help() {
  console.log(`\n🐷 Wurster Headless 0.32.6 — PigLink developer/AI harness\n\nUsage:\n  wurster-headless describe <file.wurst|file.wrst> [--json]\n  wurster-headless invoke <file.wurst|file.wrst> <action> [--input '{"x":1}'] [--input-file input.json] [--json]\n  wurster-headless test <file.wurst|file.wrst> [--json]\n  wurster-headless stdio <file.wurst|file.wrst>\n\nThe 0.32.6 harness is for developer-controlled Wursts. It is not the production untrusted-code sandbox.\n`);
}

const { positionals, flags } = parse(process.argv.slice(2));
const [command, file, action] = positionals;

try {
  if (!command || !file) { help(); process.exitCode = command ? 1 : 0; }
  else if (command === 'describe') {
    const result = await describePigLink(file);
    if (flags.json) console.log(JSON.stringify(result));
    else {
      console.log(`🌭 ${result.info.name} ${result.info.version}`);
      console.log('   Two ends: visible UI <- Wurst -> PigLink');
      for (const [name, spec] of Object.entries(result.piglink.actions)) console.log(`   -> ${name}${spec.readOnly ? ' [read-only]' : ''}${spec.description ? ` - ${spec.description}` : ''}`);
      for (const [name, spec] of Object.entries(result.piglink.events ?? {})) console.log(`   <- ${name}${spec.description ? ` - ${spec.description}` : ''}`);
    }
  } else if (command === 'invoke') {
    if (!action) throw new Error('invoke requires an action name');
    const result = await invokePigLinkAction(file, action, await inputFrom(flags));
    if (flags.json) console.log(JSON.stringify({ ok: true, ...result }));
    else {
      console.log(`🐖 ${action}`);
      console.log(JSON.stringify(result.result, null, 2));
      if (result.events.length) console.log(`events: ${JSON.stringify(result.events)}`);
    }
  } else if (command === 'test') {
    const result = await runPigLinkTests(file);
    if (flags.json) console.log(JSON.stringify(result));
    else {
      console.log(`🌭 ${result.info.name} PigLink tests`);
      for (const test of result.tests) console.log(`${test.pass ? '✓' : '✗'} ${test.name}`);
      console.log(`${result.passed} passed / ${result.failed} failed`);
    }
    if (result.failed) process.exitCode = 2;
  } else if (command === 'stdio') {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let request;
      try { request = JSON.parse(trimmed); }
      catch { console.log(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON request' })); continue; }
      const id = request.id ?? null;
      try {
        if (request.method === 'piglink.describe') {
          const result = await describePigLink(file);
          console.log(JSON.stringify({ id, ok: true, result }));
        } else if (request.method === 'actions.invoke') {
          const name = request.params?.name;
          if (!name) throw new Error('actions.invoke requires params.name');
          const invoked = await invokePigLinkAction(file, String(name), request.params?.input ?? {});
          console.log(JSON.stringify({ id, ok: true, result: invoked.result, events: invoked.events }));
        } else if (request.method === 'tests.run') {
          const result = await runPigLinkTests(file);
          console.log(JSON.stringify({ id, ok: result.failed === 0, result }));
        } else {
          throw new Error(`Unknown method: ${request.method}`);
        }
      } catch (error) {
        console.log(JSON.stringify({ id, ok: false, error: error.message }));
      }
    }
  } else help();
} catch (error) {
  if (flags.json) console.log(JSON.stringify({ ok: false, error: error.message }));
  else console.error(`🥀 HEADLESS_WURST_ERROR: ${error.message}`);
  process.exitCode = 1;
}
