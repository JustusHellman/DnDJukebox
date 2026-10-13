# DnDocs Jukebox

The music library behind the jukebox in [DnDocs](https://github.com/JustusHellman/DnDocs): about
480 Creative Commons tracks (roughly 27 hours) in 28 environments, plus one-shot stingers. It's
served from GitHub Pages, so every player can stream it without an account.

It also works on its own as a music player. Open `https://justushellman.github.io/DnDJukebox/`,
pick an environment, and it keeps playing fitting tracks, shuffled, with crossfades.

- **Controls:** pause, skip, stop, play a specific track, see what's up next, set the volume.
- **Fade speed:** Quick, Smooth or Slow.
- **Intensity:** Calm, Tense or Danger, in environments that have levels.
- **Stingers:** short one-shot sounds over the music.
- **Keys:** Space pauses and N skips. Media keys and the phone lock screen work too.

Music on this page plays only on that device. For music the whole group hears in sync, use the
jukebox in DnDocs. DnDocs only reads `catalog.json` and the audio files, so changes to this page
don't affect it.

## Environments

| Group | Environments |
| --- | --- |
| Places | Tavern & Inn · Small Village · Bustling City · Forest & Wilds · Enchanted & Fey · Travel & Open Road · Sea & Sailing · Tropical Isles · Underwater · Desert & Distant Lands · Jungle & Tribal · Snow & Ice · Dungeon & Caves · Temple & Sacred · Castle & Nobility · Magic & Wizards · Haunted & Undead |
| Action | Intrigue & Sneaking · Tension & Danger · Chase · Skirmish · Battle · Boss Battle · Epic Finale |
| Moods | Rest & Campfire · Sorrow & Loss · Triumph & Celebration · Shenanigans |

**Levels.** These environments have **Tense** and **Danger** track lists besides their default
(Calm): Forest, Travel, City, Sea, Underwater (Tense only), Desert, Jungle, Snow & Ice, Dungeon and
Haunted. The DM switches level without changing scene, and the music crossfades.

**Starting at the action.** Chase, Skirmish, Battle, Boss Battle and Epic Finale (`hitStart`) skip
slow intros: each track starts where it gets going. The build finds that point itself. You can also
set it by hand with `{ "title": "...", "start": 118 }`.

**Stingers** (`catalog/stingers.json`) are short sounds the DM fires over the music, which dips
while they play: Roll initiative, Victory, Dramatic reveal, Something's wrong, Magic, A death,
Fanfare and Oops. Each picks one of a few variations.

## How the music is chosen

Every track is **measured** by `scripts/analyze.mjs`, which needs no packages:

- **Intensity, 0–100.** This mostly comes from the drum, cymbal and brass attacks, how full the
  orchestra is, and how little of the track is quiet. A solo lute ballad lands around 20, a battle
  theme around 80–100.
- **The hit.** This is how many seconds the track takes to reach its normal level.

Each environment also has rules that keep tracks that don't fit out, even ones added later:

- **Style.** Most environments use the `period` style (in `environments.json` → `styles`): no
  synths, electric guitars, drum kits, saxophones, banjos and the like in a medieval tavern or
  forest. An environment can `allow` some of them back: synth pads under water, in the Feywild and
  in fights; steel drums and ukuleles on tropical islands. Haunted & Undead and Shenanigans have no
  style, since odd instruments are part of the fun there. The instruments come from incompetech.com
  (or `instruments` in `extra-tracks.json`).
- **Energy.** `minIntensity` keeps the fights hard-hitting; `maxIntensity` keeps Rest, Sorrow,
  Temple, Underwater and Intrigue calm; `maxBpm` can cap the tempo. Energy rules only apply to the
  main list, and an environment always keeps at least 8 tracks.

The build log lists every track a rule left out.

## Set up (once)

1. Create the repo `DnDJukebox` on GitHub and upload this folder to `main`. Include the hidden
   `.github` folder.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. Go to **Actions → Build and deploy the music library → Run workflow**, or push any change.
   - The first run downloads, measures and converts every track, which takes a while (roughly
     30–60 minutes).
   - Later runs only handle new or changed tracks.

Then open `https://<your-user>.github.io/DnDJukebox/`. DnDocs uses that address by default. For a
different one, set `VITE_JUKEBOX_URL` when building DnDocs.

## How it works

- **`catalog/environments.json`** lists the environments. A track entry can be:
  - an **incompetech.com title** (Kevin MacLeod),
  - an id from `catalog/extra-tracks.json` (Scott Buckley's tracks and your own),
  - an object such as `{ "title": "...", "start": 26 }` or `{ "title": "...", "end": 20 }` to start
    later or cut it short.
- **Fields on an environment:**
  - `group`: `places`, `action` or `moods`.
  - `hitStart`: skip quiet intros.
  - `levels`: `{ "tense": [...], "danger": [...] }`.
  - `style` and `allow`: leave out tracks with instruments that don't fit (see above).
  - `minIntensity`, `maxIntensity`, `maxBpm`: leave out tracks with the wrong energy.
- **`scripts/build.mjs`** needs Node 18+ and ffmpeg, and no npm packages. It:
  1. downloads each track,
  2. evens out its loudness (so a quiet harp and a loud battle theme sit at the same level),
  3. converts it to a small AAC file (`.m4a`, 64 kbps),
  4. measures it,
  5. writes `catalog.json`, `index.html` and `CREDITS.md`. The catalog includes exact lengths,
     which DnDocs needs to keep everyone in sync, plus intensity and where the hit is.
- **The workflow** deploys with GitHub Actions, with no `gh-pages` branch.
  - Converted tracks are kept in the Actions cache between runs.
  - If the cache has expired (GitHub drops caches unused for a week), unchanged tracks are copied
    from the live site instead (`--reuse-from`), so nothing is converted twice.

GitHub Pages sites are limited to 1 GB. The library is about 770 MB, and the build warns above
900 MB. To fit more music, lower the bitrate (*Run workflow* → bitrate `56k`) or remove tracks.

## Reviewing and improving the selection

You can mark changes in two places:

- **On the player page, Review tab.** Pick an environment (and level). The page plays a 25-second
  sample of each track, starting where it gets going. Use **Remove** or **Move to…** on tracks that
  don't fit. Your marks stay in the browser until you **Download review.json**.
- **In DnDocs.** The DM's 👎 *Doesn't fit here* button and their edits to library environments are
  collected on the Jukebox page. **Download changes** gives the same kind of file.

Then apply the file in this repo, and commit and push. The build does the rest:

```sh
node scripts/apply-review.mjs review.json
```

## Adding music

**More Kevin MacLeod tracks.** Find the exact title on
[incompetech.com](https://incompetech.com/music/royalty-free/music.html), add it to an environment's
`tracks` or a level, and push.

**More Scott Buckley tracks.** All of [his library](https://www.scottbuckley.com.au/library/) is
CC BY 4.0. On a track's page, copy the `.mp3` link, then add an entry to
`catalog/extra-tracks.json` like the existing ones:

- `id`: `sb-…`
- `artist`: `Scott Buckley`
- `license`: `CC BY 4.0`
- `licenseUrl`
- `sourceUrl`: the track's page
- `url`: the mp3 link

**A new environment.** Add an entry to `environments.json`, for example:

```json
{
  "id": "volcano",
  "group": "places",
  "name": "Volcano",
  "emoji": "🌋",
  "description": "Lava, ash and fire giants.",
  "tracks": ["Firebrand", "Stormfront", "Unlight"],
  "levels": { "danger": ["Five Armies", "sb-juggernaut"] }
}
```

`id` uses only a–z, 0–9 and `-`. DMs see the new environment the next time DnDocs loads.

**Your own files.** Put them in `custom/` and describe them in `catalog/extra-tracks.json` with
`"file": "custom/your-file.mp3"` instead of `url`. Then use the id in any environment. Only add
music you're allowed to share publicly: your own, public domain or Creative Commons. Other good
sources:

- [FreePD](https://freepd.com) (public domain)
- [Free Music Archive](https://freemusicarchive.org) (check each track's licence)
- [OpenGameArt](https://opengameart.org) (check each track's licence)

**Just for one campaign.** DMs can also make environments and add tracks inside DnDocs (*Jukebox*
page → *New environment*, or the pencil on an environment). That needs no change here, and tracks
can be any direct link to an audio file. Tracks added here also get even loudness and smooth fades
on iPhones; links added in DnDocs may not.

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

The music is by:

- **Kevin MacLeod** ([incompetech.com](https://incompetech.com))
- **Scott Buckley** ([scottbuckley.com.au](https://www.scottbuckley.com.au))

Both are licensed under
[Creative Commons: By Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). The full list
is on the site's Credits tab and in `CREDITS.md`. DnDocs shows each track's credit while it plays.
