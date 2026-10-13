# DnDocs Jukebox

The music library behind the jukebox in [DnDocs](https://github.com/JustusHellman/DnDocs): about
390 Creative Commons tracks (roughly 22 hours) sorted into 25 environments, served from GitHub Pages
so every player can stream it without an account.

It also works on its own as a simple music player: open
`https://justushellman.github.io/DnDocs-Jukebox/`, pick an environment, and it keeps playing
fitting tracks, shuffled, with crossfades. You can pause, skip, stop, play a specific track, set the
fade speed (Quick, Smooth or Slow) and the volume, and see what's up next. Space pauses and N skips.
It also works with your keyboard's media keys and phone lock screen. Music on the page plays only on
that device; for music the whole group hears in sync, use the jukebox in DnDocs.

DnDocs only reads `catalog.json` and the audio files, so changes to this page don't affect it.

## Environments

Tavern & Inn · Small Village · Bustling City · Forest & Wilds · Enchanted & Fey · Travel & Open Road ·
Sea & Sailing · Tropical Isles · Underwater · Desert & Distant Lands · Jungle & Tribal · Snow & Ice ·
Dungeon & Caves · Intrigue & Sneaking · Tension & Danger · Haunted & Undead · Combat · Boss Battle ·
Magic & Wizards · Temple & Sacred · Castle & Nobility · Rest & Campfire · Sorrow & Loss ·
Triumph & Celebration · Shenanigans

Each one has 14–36 tracks. A track can be in several environments.

## Set up (once)

1. Create the repo `DnDocs-Jukebox` on GitHub and upload this folder to `main`, including the
   hidden `.github` folder.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → Build and deploy the music library → Run workflow** (or push any change). The first
   run downloads and converts every track, which takes a while (roughly 20–40 minutes). Later runs
   only convert new or changed tracks.

Then open `https://<your-user>.github.io/DnDocs-Jukebox/`. DnDocs uses that address by default. For
a different one, set `VITE_JUKEBOX_URL` when building DnDocs.

## How it works

- `catalog/environments.json` lists the environments. Their tracks are **incompetech.com titles**
  (Kevin MacLeod) or ids from `catalog/extra-tracks.json`.
- `scripts/build.mjs` (Node 18+, ffmpeg, no npm packages):
  1. reads the official track list (`pieces.json`) from incompetech,
  2. downloads each track,
  3. evens out its loudness (so a quiet harp and a loud battle theme sit at the same level),
  4. converts it to a small AAC file (`.m4a`, 64 kbps),
  5. writes `catalog.json` (with exact track lengths, which DnDocs needs to keep everyone in
     sync), `index.html` and `CREDITS.md`.
- The workflow deploys with GitHub Actions (no `gh-pages` branch). Converted tracks are kept in the
  Actions cache between runs. If the cache has expired (GitHub drops caches unused for a week), unchanged
  tracks are copied from the live site instead (`--reuse-from`), so nothing is converted twice.

GitHub Pages sites are limited to 1 GB. The full library is about 650 MB, and the build warns
above 900 MB. To fit more music, lower the bitrate (*Run workflow* → bitrate `48k`) or remove tracks.

## Adding music

**More Kevin MacLeod tracks:** find the exact title on
[incompetech.com](https://incompetech.com/music/royalty-free/music.html) and add it to an
environment's `tracks` in `catalog/environments.json`. Push, and the workflow does the rest.

**A new environment:** add an entry to `environments.json`, for example:

```json
{
  "id": "volcano",
  "name": "Volcano",
  "emoji": "🌋",
  "description": "Lava, ash and fire giants.",
  "tracks": ["Firebrand", "Stormfront", "Unlight"]
}
```

`id` uses only a–z, 0–9 and `-`. DMs see the new environment the next time DnDocs loads.

**Your own files:** put them in `custom/` and describe them in `catalog/extra-tracks.json`:

```json
{
  "tracks": [
    {
      "id": "dragon-lair",
      "title": "Dragon's Lair",
      "artist": "Someone",
      "license": "CC BY 4.0",
      "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
      "sourceUrl": "https://example.com/where-i-found-it",
      "file": "custom/dragon-lair.mp3"
    }
  ]
}
```

Then use `"dragon-lair"` in any environment. Instead of `file`, you can give a `url` to download from.
Only add music you're allowed to share publicly: your own, public domain or Creative Commons.
Good sources:

- [incompetech](https://incompetech.com)
- [FreePD](https://freepd.com) (public domain)
- [Tabletop Audio](https://tabletopaudio.com) (check their licence)
- [Free Music Archive](https://freemusicarchive.org)
- [OpenGameArt](https://opengameart.org)

**Just for one campaign:** DMs can also make environments and add tracks inside DnDocs (*Jukebox*
page → *New environment*, or the pencil on an environment). That needs no change here, and tracks can
be any direct link to an audio file. Tracks added here get even loudness and smooth fades on
iPhones; DnDocs links may not.

## Run locally

```sh
node scripts/build.mjs --limit 5   # quick test with 5 tracks → dist/
node scripts/build.mjs             # everything
node scripts/serve.mjs             # http://localhost:8787 (with CORS, for testing DnDocs)
npm run check                      # only check the catalog's spelling, no downloads
```

To try DnDocs against the local library, put `VITE_JUKEBOX_URL=http://localhost:8787/` in DnDocs'
`.env.local`.

## Credits

Most of the music is by Kevin MacLeod ([incompetech.com](https://incompetech.com)), licensed under
[Creative Commons: By Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The full list
is on the site and in `CREDITS.md` on the site. DnDocs shows each track's credit while
it plays.
