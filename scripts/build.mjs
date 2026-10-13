#!/usr/bin/env node
/**
 * Builds the jukebox site: downloads every track the catalog mentions, converts it to a small
 * AAC (.m4a) file with even loudness, measures its length and writes catalog.json, the index
 * page and the credits.
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
      const res = await fetch(url, { headers: { 'user-agent': 'DnDocs-Jukebox build (github.com)' } });
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

async function convert(input, output) {
  const filters = NORMALIZE ? ['-af', 'loudnorm=I=-19:TP=-1.5:LRA=11', '-ar', '44100'] : [];
  await run(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', input, '-vn', '-map_metadata', '-1', ...filters, '-ac', '2', '-c:a', 'aac', '-b:a', BITRATE, '-movflags', '+faststart', output],
    { maxBuffer: 1 << 24 },
  );
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
async function loadSources() {
  const envFile = await readJson(path.join(ROOT, 'catalog/environments.json'));
  const extra = await readJson(path.join(ROOT, 'catalog/extra-tracks.json'), { tracks: [] });
  const environments = envFile.environments ?? [];
  const extraTracks = extra.tracks ?? [];

  const problems = [];
  const envIds = new Set();
  for (const e of environments) {
    if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) problems.push(`environment "${e.name}" needs an id made of a-z, 0-9 and -`);
    if (envIds.has(e.id)) problems.push(`two environments have the id "${e.id}"`);
    envIds.add(e.id);
    if (!e.name) problems.push(`environment "${e.id}" needs a name`);
    if (!Array.isArray(e.tracks)) problems.push(`environment "${e.id}" needs a tracks list`);
  }
  for (const t of extraTracks) {
    if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) problems.push(`extra track "${t.title}" needs an id made of a-z, 0-9 and -`);
    if (!t.title) problems.push(`extra track "${t.id}" needs a title`);
    if (!t.file && !t.url) problems.push(`extra track "${t.id}" needs "file" (in custom/) or "url"`);
    if (t.file && !existsSync(path.join(ROOT, t.file))) problems.push(`extra track "${t.id}": ${t.file} does not exist`);
    if (!t.artist || !t.license) problems.push(`extra track "${t.id}" needs "artist" and "license" (for the credits)`);
  }
  if (problems.length) throw new Error(`The catalog has problems:\n  - ${problems.join('\n  - ')}`);
  return { environments, extraTracks };
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

/** Turns every name in the environments into a track with a source. */
function resolveTracks(environments, extraTracks, pieces) {
  const extraById = new Map(extraTracks.map((t) => [t.id, t]));
  const extraByTitle = new Map(extraTracks.map((t) => [t.title.toLowerCase(), t]));
  const pieceByTitle = new Map();
  for (const p of pieces) if (p?.title && p?.filename && !pieceByTitle.has(p.title.toLowerCase())) pieceByTitle.set(p.title.toLowerCase(), p);

  const tracks = new Map(); // id -> track
  const unknown = [];
  const envOut = environments.map((e) => {
    const ids = [];
    for (const name of e.tracks) {
      const key = String(name).trim();
      const x = extraById.get(key) ?? extraByTitle.get(key.toLowerCase());
      if (x) {
        if (!tracks.has(x.id)) {
          tracks.set(x.id, {
            id: x.id,
            title: x.title,
            artist: x.artist,
            license: x.license,
            licenseUrl: x.licenseUrl,
            sourceUrl: x.sourceUrl ?? x.url,
            src: x.file ? { file: path.join(ROOT, x.file) } : { url: x.url },
          });
        }
        if (!ids.includes(x.id)) ids.push(x.id);
        continue;
      }
      const p = pieceByTitle.get(key.toLowerCase());
      if (!p) {
        unknown.push(`${e.id}: "${key}"`);
        continue;
      }
      const id = slug(p.title);
      if (!tracks.has(id)) {
        tracks.set(id, {
          id,
          title: p.title,
          ...KEVIN,
          sourceUrl: 'https://incompetech.com/music/royalty-free/music.html',
          src: { url: `${INCOMPETECH}/mp3-royaltyfree/${encodeURIComponent(p.filename)}` },
          feel: p.feel ?? undefined,
        });
      }
      if (!ids.includes(id)) ids.push(id);
    }
    return { id: e.id, name: e.name, emoji: e.emoji ?? '🎵', description: e.description ?? '', tracks: ids };
  });
  if (unknown.length) warn(`${unknown.length} track name(s) not found (check the spelling):\n    ${unknown.join('\n    ')}`);
  return { envOut, tracks };
}

// ---------------------------------------------------------------- build
async function main() {
  const started = Date.now();
  const { environments, extraTracks } = await loadSources();
  const needsIncompetech = environments.some((e) => e.tracks.some((t) => !extraTracks.some((x) => x.id === t || x.title.toLowerCase() === String(t).toLowerCase())));
  const pieces = needsIncompetech ? await loadIncompetech() : [];
  const { envOut, tracks } = resolveTracks(environments, extraTracks, pieces);
  log(`${envOut.length} environments, ${tracks.size} tracks`);

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
      const key = hash(`${srcKey}|${BITRATE}|${NORMALIZE}`);
      const prev = manifest[t.id];
      const remote = remoteManifest[t.id];
      let reused = false;
      if (prev?.key === key && existsSync(target)) {
        built.set(t.id, { ...prev, file });
        reused = true;
      } else if (remote?.key === key) {
        try {
          await download(`${REUSE}${file}`, target);
          manifest[t.id] = { key, duration: remote.duration, bytes: (await stat(target)).size };
          built.set(t.id, { ...manifest[t.id], file });
          copied++;
          reused = true;
        } catch {
          /* not there after all: build it */
        }
      }
      if (!reused) {
        try {
          const input = t.src.file ?? path.join(tmp, `${t.id}.src`);
          if (!t.src.file) await download(t.src.url, input);
          await convert(input, target);
          if (!t.src.file) await rm(input, { force: true });
          const duration = await probeDuration(target);
          const bytes = (await stat(target)).size;
          manifest[t.id] = { key, duration, bytes };
          built.set(t.id, { key, duration, bytes, file });
          if (needsIncompetech && t.src.url?.startsWith(INCOMPETECH)) await new Promise((r) => setTimeout(r, 300)); // be gentle
        } catch (e) {
          failed.push(`${t.title}: ${e.message.split('\n')[0]}`);
        }
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
    };
  }
  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    environments: envOut.map((e) => ({ ...e, tracks: e.tracks.filter((id) => trackOut[id]) })),
    tracks: trackOut,
  };
  await writeFile(path.join(OUT, 'catalog.json'), JSON.stringify(catalog));
  await copyFile(path.join(ROOT, 'site/index.html'), path.join(OUT, 'index.html'));
  await writeFile(path.join(OUT, '.nojekyll'), '');
  await writeFile(path.join(OUT, 'CREDITS.md'), credits(catalog));

  const total = Object.values(trackOut).reduce((a, t) => a + t.bytes, 0);
  const minutes = Object.values(trackOut).reduce((a, t) => a + t.duration, 0) / 60;
  log(`\n${Object.keys(trackOut).length} tracks, ${Math.round(minutes)} minutes, ${fmtMB(total)} of audio → ${path.relative(ROOT, OUT) || '.'}/`);
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
  const tracks = Object.values(catalog.tracks).sort((a, b) => a.title.localeCompare(b.title));
  for (const t of tracks) {
    const lic = t.licenseUrl ? `[${t.license}](${t.licenseUrl})` : t.license;
    const by = t.artist === 'Kevin MacLeod' ? 'Kevin MacLeod ([incompetech.com](https://incompetech.com))' : t.artist;
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
