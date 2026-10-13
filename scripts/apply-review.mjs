#!/usr/bin/env node
/**
 * Applies a review file to catalog/environments.json.
 *
 *   node scripts/apply-review.mjs jukebox-review.json
 *
 * Review files come from the player page's Review mode, or from DnDocs (Jukebox page →
 * "Send your changes to the library"). They look like:
 *
 *   { "version": 1, "changes": [
 *       { "action": "remove", "env": "boss", "track": "danse-macabre" },
 *       { "action": "add",    "env": "horror", "level": "tense", "track": "danse-macabre" },
 *       { "action": "move",   "env": "city", "track": "sneaky-snitch", "to": "silly" } ] }
 *
 * Track ids are the ones in catalog.json. "level" (tense/danger) is optional. Prints what it did;
 * changes that don't apply (already done, unknown track) are skipped with a note.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, 'catalog/environments.json');

const name = (e) => (typeof e === 'string' ? e : (e.title ?? e.id ?? ''));
/** The id the build gives an entry (see build.mjs resolve()). */
function idOf(entry, extraIds) {
  const n = name(entry).trim();
  const base = extraIds.has(n) ? n : slug(n);
  return typeof entry === 'object' && entry.end ? `${base}-${entry.end}s` : base;
}

export function applyReview(file, review, extraIds = new Set()) {
  const envs = new Map(file.environments.map((e) => [e.id, e]));
  // Every entry we know, by id (to add a track to another environment we need its catalog entry).
  const entries = new Map();
  for (const e of file.environments) for (const t of [...e.tracks, ...Object.values(e.levels ?? {}).flat()]) entries.set(idOf(t, extraIds), t);
  for (const id of extraIds) if (!entries.has(id)) entries.set(id, id);

  const list = (env, level) => {
    if (!level) return env.tracks;
    env.levels ??= {};
    return (env.levels[level] ??= []);
  };
  const done = [], skipped = [];
  const remove = (env, track, level) => {
    let hit = false;
    for (const lv of level ? [level] : [null, ...Object.keys(env.levels ?? {})]) {
      const l = list(env, lv);
      const i = l.findIndex((t) => idOf(t, extraIds) === track);
      if (i >= 0) {
        l.splice(i, 1);
        hit = true;
      }
    }
    return hit;
  };
  const add = (env, track, level) => {
    const entry = entries.get(track);
    if (!entry) return 'unknown track';
    const l = list(env, level);
    if (l.some((t) => idOf(t, extraIds) === track)) return 'already there';
    l.push(entry);
    return null;
  };

  for (const c of review.changes ?? []) {
    const env = envs.get(c.env);
    const label = `${c.action} ${c.track} ${c.action === 'move' ? `${c.env} → ${c.to}` : `${c.action === 'add' ? 'to' : 'from'} ${c.env}`}${c.level ? ` (${c.level})` : ''}`;
    if (!env) {
      skipped.push(`${label}: no environment "${c.env}"`);
      continue;
    }
    if (c.action === 'remove') {
      (remove(env, c.track, c.level) ? done : skipped).push(label);
    } else if (c.action === 'add') {
      const err = add(env, c.track, c.level);
      (err ? skipped : done).push(err ? `${label}: ${err}` : label);
    } else if (c.action === 'move') {
      const to = envs.get(c.to);
      if (!to) {
        skipped.push(`${label}: no environment "${c.to}"`);
        continue;
      }
      const err = add(to, c.track, c.toLevel);
      remove(env, c.track, c.level);
      (err && err !== 'already there' ? skipped : done).push(err && err !== 'already there' ? `${label}: ${err}` : label);
    } else {
      skipped.push(`${label}: unknown action`);
    }
  }
  for (const e of file.environments) if (e.levels) for (const k of Object.keys(e.levels)) if (!e.levels[k].length) delete e.levels[k];
  return { done, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reviewPath = process.argv[2];
  if (!reviewPath) {
    console.error('Usage: node scripts/apply-review.mjs <review.json>');
    process.exit(1);
  }
  const file = JSON.parse(await readFile(ENV_FILE, 'utf8'));
  const extra = JSON.parse(await readFile(path.join(ROOT, 'catalog/extra-tracks.json'), 'utf8').catch(() => '{"tracks":[]}'));
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  const { done, skipped } = applyReview(file, review, new Set((extra.tracks ?? []).map((t) => t.id)));
  await writeFile(ENV_FILE, JSON.stringify(file, null, 2) + '\n');
  for (const d of done) console.log('✓', d);
  for (const s of skipped) console.log('–', s);
  console.log(`\n${done.length} change(s) applied to catalog/environments.json. Commit and push to publish them.`);
}
