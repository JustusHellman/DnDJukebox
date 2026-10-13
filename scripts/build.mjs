#!/usr/bin/env node
/**
 * Builds the jukebox site: downloads every track the catalog mentions, converts it to a small
 * AAC (.m4a) file with even loudness, measures it (length, intensity, where "the hit" is; see
 * analyze.mjs) and writes catalog.json, the player page and the credits.
 *
 * Sources: catalog/environments.json (what plays where), catalog/stingers.json (one-shot sounds)
 * and catalog/extra-tracks.json (tracks that aren't on incompetech).
 *
 *   node scripts/build.mjs                 # build into ./dist (keeps files that are already there)
 *   node scripts/build.mjs --out site      # another output folder
 *   node scripts/build.mjs --catalog-only  # only check the catalog and write catalog.json (no audio)
 *   node scripts/build.mjs --limit 5       # only the first 5 tracks (quick test)
 *
 * Options: --bitrate 64k (default), --jobs 3 (parallel conversions), --no-normalize,
 *          --reuse-from <url of the published site> (copy unchanged tracks from it instead of rebuilding).
 * Needs Node 18+ and ffmpeg/ffprobe on the PATH. No npm packages.
 *
 * Re-running is cheap: a track is only converted again when its source or the bitrate changed
 * (see build-manifest.json, which is published with the site). Unchanged tracks are kept from the
 * output folder or copied from the live site (--reuse-from). Tracks that left the catalog are removed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { analyze, ANALYSIS_VERSION } from './analyze.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const OUT = path.resolve(ROOT, opt('out', 'dist'));
const BITRATE = opt('bitrate', '64k');
const JOBS = Math.max(1, Number(opt('jobs', '3')));
const LIMIT = Number(opt('limit', '0')) || Infinity;
const CATALOG_ONLY = flag('catalog-only');
/** A published copy of this site: tracks it already has (same source and settings) are copied, not rebuilt. */
const REUSE = (() => {
  const u = opt('reuse-from', '');
  return u ? (u.endsWith('/') ? u : u + '/') : '';
})();
const NORMALIZE = !flag('no-normalize');
/** Where incompetech keeps its list and files (overridable for offline tests). */
const INCOMPETECH = (process.env.INCOMPETECH_BASE || 'https://incompetech.com/music/royalty-free').replace(/\/$/, '');
/** GitHub Pages refuses sites above 1 GB; warn well before that. */
const SIZE_WARN = 900 * 1024 * 1024;

const KEVIN = {
  artist: 'Kevin MacLeod',
  license: 'CC BY 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};

// ---------------------------------------------------------------- helpers
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠', ...a);

export function slug(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path.relative(ROOT, file)}: ${e.message}`);
  }
}

async function fetchRetry(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'DnDJukebox build (github.com)' } });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(`${url}: ${last?.message ?? 'failed'}`);
}

async function download(url, file) {
  const res = await fetchRetry(url);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('could not read the length');
  return Math.round(d * 100) / 100;
}

async function convert(input, output, end) {
  const af = [];
  if (NORMALIZE) af.push('loudnorm=I=-19:TP=-1.5:LRA=11');
  if (end) af.push(`afade=t=out:st=${Math.max(0, end - 1.5)}:d=1.5`);
  await run(
    'ffmpeg',
    [
      '-y', '-v', 'error', '-i', input, '-vn', '-map_metadata', '-1',
      ...(end ? ['-t', String(end)] : []),
      ...(af.length ? ['-af', af.join(',')] : []),
      ...(NORMALIZE ? ['-ar', '44100'] : []),
      '-ac', '2', '-c:a', 'aac', '-b:a', BITRATE, '-movflags', '+faststart', output,
    ],
    { maxBuffer: 1 << 24 },
  );
}

/** Mono 22.05 kHz samples of an audio file (for analyze()). */
async function decodeMono(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length - (stdout.length % 4)));
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const fmtMB = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- catalog
const GROUPS = ['places', 'action', 'moods'];
const LEVELS = ['tense', 'danger'];
/** A track entry: "Incompetech title", "extra-track-id", or { title|id, start?, end? }. */
const entryName = (e) => (typeof e === 'string' ? e : (e?.title ?? e?.id ?? '')).trim();

async function loadSources() {
  const envFile = await readJson(path.join(ROOT, 'catalog/environments.json'));
  const extra = await readJson(path.join(ROOT, 'catalog/extra-tracks.json'), { tracks: [] });
  const stingFile = await readJson(path.join(ROOT, 'catalog/stingers.json'), { stingers: [] });
  const environments = envFile.environments ?? [];
  const styles = envFile.styles ?? {};
  const extraTracks = extra.tracks ?? [];
  const stingers = stingFile.stingers ?? [];

  const problems = [];
  for (const [kind, items] of [['environments', environments], ['stingers', stingers]]) {
    const ids = new Set();
    for (const e of items) {
      if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) problems.push(`"${e.name}" needs an id made of a-z, 0-9 and -`);
      if (ids.has(e.id)) problems.push(`two ${kind} have the id "${e.id}"`);
      ids.add(e.id);
    }
  }
  for (const e of [...environments, ...stingers]) {
    if (!e.name) problems.push(`"${e.id}" needs a name`);
    if (!Array.isArray(e.tracks)) problems.push(`"${e.id}" needs a tracks list`);
  }
  for (const e of environments) {
    if (e.group && !GROUPS.includes(e.group)) problems.push(`environment "${e.id}": group must be one of ${GROUPS.join(', ')}`);
    for (const k of Object.keys(e.levels ?? {})) if (!LEVELS.includes(k)) problems.push(`environment "${e.id}": levels can only be ${LEVELS.join(' and ')}`);
    if (e.style && !styles[e.style]) problems.push(`environment "${e.id}": no style "${e.style}" in "styles"`);
  }
  for (const t of extraTracks) {
    if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) problems.push(`extra track "${t.title}" needs an id made of a-z, 0-9 and -`);
    if (!t.title) problems.push(`extra track "${t.id}" needs a title`);
    if (!t.file && !t.url) problems.push(`extra track "${t.id}" needs "file" (in custom/) or "url"`);
    if (t.file && !existsSync(path.join(ROOT, t.file))) problems.push(`extra track "${t.id}": ${t.file} does not exist`);
    if (!t.artist || !t.license) problems.push(`extra track "${t.id}" needs "artist" and "license" (for the credits)`);
  }
  if (problems.length) throw new Error(`The catalog has problems:\n  - ${problems.join('\n  - ')}`);
  return { environments, extraTracks, stingers, styles };
}

async function loadIncompetech() {
  const cache = path.join(ROOT, '.cache/pieces.json');
  try {
    const res = await fetchRetry(`${INCOMPETECH}/pieces.json`);
    const pieces = await res.json();
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify(pieces));
    return pieces;
  } catch (e) {
    if (existsSync(cache)) {
      warn(`incompetech list not reachable (${e.message}); using the cached copy`);
      return readJson(cache);
    }
    throw e;
  }
}

/** Turns every entry in the environments and stingers into a track with a source. */
function makeResolver(extraTracks, pieces) {
  const extraById = new Map(extraTracks.map((t) => [t.id, t]));
  const extraByTitle = new Map(extraTracks.map((t) => [t.title.toLowerCase(), t]));
  const pieceByTitle = new Map();
  for (const p of pieces) if (p?.title && p?.filename && !pieceByTitle.has(p.title.toLowerCase())) pieceByTitle.set(p.title.toLowerCase(), p);

  const tracks = new Map(); // id -> track
  const unknown = [];
  /** @returns the track id, or null if the entry can't be found */
  function resolve(entry, where) {
    const key = entryName(entry);
    const end = typeof entry === 'object' && entry.end ? Number(entry.end) : 0;
    const start = typeof entry === 'object' && entry.start ? Number(entry.start) : 0;
    let base;
    const x = extraById.get(key) ?? extraByTitle.get(key.toLowerCase());
    if (x) {
      base = {
        id: x.id,
        title: x.title,
        artist: x.artist,
        license: x.license,
        licenseUrl: x.licenseUrl,
        sourceUrl: x.sourceUrl ?? x.url,
        src: x.file ? { file: path.join(ROOT, x.file) } : { url: x.url },
        instruments: x.instruments,
        bpm: x.bpm ? Number(x.bpm) : undefined,
      };
    } else {
      const p = pieceByTitle.get(key.toLowerCase());
      if (!p) {
        unknown.push(`${where}: "${key}"`);
        return null;
      }
      base = {
        id: slug(p.title),
        title: p.title,
        ...KEVIN,
        sourceUrl: 'https://incompetech.com/music/royalty-free/music.html',
        src: { url: `${INCOMPETECH}/mp3-royaltyfree/${encodeURIComponent(p.filename)}` },
        feel: p.feel ?? undefined,
        instruments: p.instruments || undefined,
        bpm: Number(p.bpm) || undefined,
      };
    }
    // A shortened version is its own file.
    const id = end ? `${base.id}-${end}s` : base.id;
    const t = tracks.get(id) ?? { ...base, id, end: end || undefined };
    if (start) t.start = start;
    tracks.set(id, t);
    return id;
  }
  return { resolve, tracks, unknown };
}

function resolveAll(environments, stingers, resolver) {
  const list = (entries, where) => {
    const ids = [];
    for (const e of entries ?? []) {
      const id = resolver.resolve(e, where);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const envOut = environments.map((e) => {
    const out = { id: e.id, name: e.name, emoji: e.emoji ?? '🎵', description: e.description ?? '', group: e.group ?? 'places', tracks: list(e.tracks, e.id) };
    if (e.hitStart) out.hitStart = true;
    out.rules = { style: e.style, allow: e.allow, minIntensity: e.minIntensity, maxIntensity: e.maxIntensity, maxBpm: e.maxBpm };
    const levels = {};
    for (const k of LEVELS) if (e.levels?.[k]?.length) levels[k] = list(e.levels[k], `${e.id} (${k})`);
    if (Object.keys(levels).length) out.levels = levels;
    return out;
  });
  const stingOut = stingers.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji ?? '🔔', tracks: list(s.tracks, `stinger ${s.id}`) }));
  if (resolver.unknown.length) warn(`${resolver.unknown.length} track name(s) not found (check the spelling):\n    ${resolver.unknown.join('\n    ')}`);
  return { envOut, stingOut };
}

/** Where to start a track in environments that skip quiet intros. */
function cueOf(t, b) {
  if (t.start) return t.start;
  const intro = b?.analysis?.intro ?? 0;
  return intro >= 6 && intro < (b?.duration ?? 0) * 0.5 ? intro - 1 : 0;
}

/**
 * An environment's quality rules (see "styles" and the rule fields in environments.json):
 *  - style: instruments that don't belong (e.g. drum kit or synths in a medieval tavern). Hard rule,
 *    for tracks whose instruments are known; "allow" lifts single words for one environment.
 *  - minIntensity / maxIntensity / maxBpm: the energy that fits. Soft rule: an environment keeps at
 *    least 8 tracks (the ones closest to the range).
 * Applied to the main list and to the Tense/Danger lists (energy rules only to the main list).
 * Returns what was left out, for the build log.
 */
export function applyRules(env, trackOut, tracks, styles) {
  const r = env.rules ?? {};
  const out = [];
  const allow = new Set((r.allow ?? []).map((w) => w.toLowerCase()));
  const banned = (styles[r.style] ?? []).map((w) => w.toLowerCase()).filter((w) => !allow.has(w));
  const instrumentsOf = (id) => (tracks.get(id)?.instruments ?? '').toLowerCase();
  const offStyle = (id) => banned.find((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(instrumentsOf(id)));
  const filterStyle = (ids, label) =>
    ids.filter((id) => {
      const w = banned.length ? offStyle(id) : null;
      if (w) out.push(`${trackOut[id].title} (${w}${label})`);
      return !w;
    });
  env.tracks = filterStyle(env.tracks, '');
  for (const k of Object.keys(env.levels ?? {})) env.levels[k] = filterStyle(env.levels[k], `, ${k}`);

  // Energy: how far outside the range a track is (0 = inside).
  const miss = (id) => {
    const t = trackOut[id];
    // A hand-picked start point skips the quiet part the measurement averages in, so trust it.
    if (tracks.get(id)?.start) return 0;
    let d = 0;
    if (t.intensity !== undefined && r.minIntensity) d += Math.max(0, r.minIntensity - t.intensity);
    if (t.intensity !== undefined && r.maxIntensity) d += Math.max(0, t.intensity - r.maxIntensity);
    const bpm = tracks.get(id)?.bpm;
    if (bpm && r.maxBpm) d += Math.max(0, bpm - r.maxBpm) / 2;
    return d;
  };
  if (r.minIntensity || r.maxIntensity || r.maxBpm) {
    const bad = env.tracks.filter((id) => miss(id) > 0);
    const keepBad = Math.max(0, 8 - (env.tracks.length - bad.length));
    const spared = new Set([...bad].sort((a, b) => miss(a) - miss(b)).slice(0, keepBad));
    env.tracks = env.tracks.filter((id) => {
      if (miss(id) > 0 && !spared.has(id)) {
        const t = trackOut[id];
        out.push(`${t.title} (intensity ${t.intensity ?? '?'}${tracks.get(id)?.bpm ? `, ${tracks.get(id).bpm} bpm` : ''})`);
        return false;
      }
      return true;
    });
  }
  return out;
}

// ---------------------------------------------------------------- build
async function main() {
  const started = Date.now();
  const { environments, extraTracks, stingers, styles } = await loadSources();
  const extraKeys = new Set(extraTracks.flatMap((x) => [x.id, x.title.toLowerCase()]));
  const needsIncompetech = [...environments, ...stingers].some((e) =>
    [...e.tracks, ...Object.values(e.levels ?? {}).flat()].some((t) => !extraKeys.has(entryName(t)) && !extraKeys.has(entryName(t).toLowerCase())),
  );
  const pieces = needsIncompetech ? await loadIncompetech() : [];
  const resolver = makeResolver(extraTracks, pieces);
  const { envOut, stingOut } = resolveAll(environments, stingers, resolver);
  const tracks = resolver.tracks;
  log(`${envOut.length} environments, ${stingOut.length} stingers, ${tracks.size} tracks`);

  await mkdir(path.join(OUT, 'audio'), { recursive: true });
  const manifestFile = path.join(OUT, 'build-manifest.json');
  const manifest = await readJson(manifestFile, {});
  let remoteManifest = {};
  let copied = 0;
  if (REUSE && !CATALOG_ONLY) {
    try {
      remoteManifest = await (await fetchRetry(`${REUSE}build-manifest.json`, 2)).json();
      log(`Reusing unchanged tracks from ${REUSE}`);
    } catch {
      log(`No published site at ${REUSE} yet: building every track.`);
    }
  }
  const tmp = path.join(tmpdir(), `jukebox-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  const list = [...tracks.values()].slice(0, LIMIT);
  const built = new Map();
  const failed = [];
  let done = 0;

  if (!CATALOG_ONLY) {
    await pool(list, JOBS, async (t) => {
      const file = `audio/${t.id}.m4a`;
      const target = path.join(OUT, file);
      let srcKey = t.src.url ?? '';
      if (t.src.file) {
        // Content, not modification time: a fresh checkout gives every file a new time.
        srcKey = `${path.relative(ROOT, t.src.file)}:${createHash('sha1').update(await readFile(t.src.file)).digest('hex')}`;
      }
      const key = hash(`${srcKey}|${BITRATE}|${NORMALIZE}|${t.end ?? ''}`);
      const prev = manifest[t.id];
      const remote = remoteManifest[t.id];
      let entry = null;
      if (prev?.key === key && existsSync(target)) {
        entry = prev;
      } else if (remote?.key === key) {
        try {
          await download(`${REUSE}${file}`, target);
          entry = { key, duration: remote.duration, bytes: (await stat(target)).size, analysis: remote.analysis };
          copied++;
        } catch {
          /* not there after all: build it */
        }
      }
      try {
        if (!entry) {
          const input = t.src.file ?? path.join(tmp, `${t.id}.src`);
          if (!t.src.file) await download(t.src.url, input);
          await convert(input, target, t.end);
          if (!t.src.file) await rm(input, { force: true });
          entry = { key, duration: await probeDuration(target), bytes: (await stat(target)).size };
          if (needsIncompetech && t.src.url?.startsWith(INCOMPETECH)) await new Promise((r) => setTimeout(r, 300)); // be gentle
        }
        if (entry.analysis?.v !== ANALYSIS_VERSION) entry = { ...entry, analysis: analyze(await decodeMono(target), 22050) };
        manifest[t.id] = entry;
        built.set(t.id, { ...entry, file });
      } catch (e) {
        failed.push(`${t.title}: ${e.message.split('\n')[0]}`);
      }
      done++;
      if (done % 10 === 0 || done === list.length) log(`  ${done}/${list.length}`);
    });
  }

  // Remove audio of tracks that left the catalog.
  if (!CATALOG_ONLY && LIMIT === Infinity) {
    for (const f of await readdir(path.join(OUT, 'audio'))) {
      const id = f.replace(/\.m4a$/, '');
      if (!tracks.has(id)) {
        await rm(path.join(OUT, 'audio', f), { force: true });
        delete manifest[id];
        log(`  removed ${f}`);
      }
    }
  }
  await writeFile(manifestFile, JSON.stringify(manifest, null, 1));
  await rm(tmp, { recursive: true, force: true });

  // catalog.json: only tracks that actually have audio (all of them with --catalog-only, length 0).
  const trackOut = {};
  for (const t of tracks.values()) {
    const b = built.get(t.id);
    if (!CATALOG_ONLY && !b) continue;
    const a = b?.analysis;
    const cue = cueOf(t, b);
    trackOut[t.id] = {
      title: t.title,
      artist: t.artist,
      license: t.license,
      ...(t.licenseUrl ? { licenseUrl: t.licenseUrl } : {}),
      ...(t.sourceUrl ? { sourceUrl: t.sourceUrl } : {}),
      ...(t.feel ? { feel: t.feel } : {}),
      file: b?.file ?? `audio/${t.id}.m4a`,
      duration: b?.duration ?? 0,
      bytes: b?.bytes ?? 0,
      ...(a ? { intensity: a.intensity, curve: a.curve } : {}),
      ...(cue ? { cue } : {}),
    };
  }
  const keep = (ids) => ids.filter((id) => trackOut[id]);
  const gated = [];
  const environmentsOut = envOut.map((e) => {
    const out = { ...e, tracks: keep(e.tracks) };
    if (out.levels) for (const k of Object.keys(out.levels)) out.levels[k] = keep(out.levels[k]);
    const dropped = applyRules(out, trackOut, tracks, styles);
    if (dropped.length) gated.push(`${e.name}: ${dropped.join(', ')}`);
    delete out.rules;
    if (out.levels) for (const k of Object.keys(out.levels)) if (!out.levels[k].length) delete out.levels[k];
    if (out.levels && !Object.keys(out.levels).length) delete out.levels;
    return out;
  });
  const catalog = {
    version: 2,
    generatedAt: new Date().toISOString(),
    environments: environmentsOut,
    stingers: stingOut.map((s) => ({ ...s, tracks: keep(s.tracks) })).filter((s) => s.tracks.length),
    tracks: trackOut,
  };
  await writeFile(path.join(OUT, 'catalog.json'), JSON.stringify(catalog));
  await copyFile(path.join(ROOT, 'site/index.html'), path.join(OUT, 'index.html'));
  await writeFile(path.join(OUT, '.nojekyll'), '');
  await writeFile(path.join(OUT, 'CREDITS.md'), credits(catalog));

  const total = Object.values(trackOut).reduce((a, t) => a + t.bytes, 0);
  const minutes = Object.values(trackOut).reduce((a, t) => a + t.duration, 0) / 60;
  log(`\n${Object.keys(trackOut).length} tracks, ${Math.round(minutes)} minutes, ${fmtMB(total)} of audio → ${path.relative(ROOT, OUT) || '.'}/`);
  if (gated.length) log(`Left out by the environments' rules (wrong instruments or energy):\n    ${gated.join('\n    ')}`);
  if (total > SIZE_WARN) warn(`The site is over ${fmtMB(SIZE_WARN)}; GitHub Pages stops at 1 GB. Lower --bitrate or remove tracks.`);
  for (const e of catalog.environments) if (e.tracks.length < 6) warn(`"${e.name}" only has ${e.tracks.length} track(s)`);
  if (failed.length) {
    warn(`${failed.length} track(s) could not be built (they are left out; the next build retries them):\n    ${failed.join('\n    ')}`);
    if (failed.length > list.length / 2) process.exitCode = 1;
  }
  if (copied) log(`${copied} unchanged track(s) copied from the published site.`);
  log(`Done in ${Math.round((Date.now() - started) / 1000)} s.`);
}

function credits(catalog) {
  const lines = ['# Music credits', '', 'All music used by the DnDocs jukebox, with its licence.', ''];
  const seen = new Set();
  const tracks = Object.values(catalog.tracks)
    .filter((t) => !seen.has(t.title + t.artist) && seen.add(t.title + t.artist))
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const t of tracks) {
    const lic = t.licenseUrl ? `[${t.license}](${t.licenseUrl})` : t.license;
    const by = t.artist === 'Kevin MacLeod' ? 'Kevin MacLeod ([incompetech.com](https://incompetech.com))' : t.artist === 'Scott Buckley' ? 'Scott Buckley ([scottbuckley.com.au](https://www.scottbuckley.com.au))' : t.artist;
    lines.push(`- “${t.title}” by ${by}, licensed under ${lic}`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\n✖ ${e.message}`);
    process.exit(1);
  });
}
