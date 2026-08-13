# smugmug-downloader

A CLI that downloads every gallery in a SmugMug account, mirroring your
folder structure on disk, preserving original filenames, and writing a
`_metadata.json` per gallery (captions, keywords, capture dates).

Built with TypeScript, native `fetch`/streams (Node 20+), and bounded
concurrency (`p-limit`) so large libraries download quickly without hammering
SmugMug's API. Shows a live progress bar while it works.

## Setup

```bash
git clone https://github.com/ramsaytc/smugmug-downloader.git
cd smugmug-downloader
npm install
npm run build
```

### 1. Get a SmugMug API key

Apply for a free key at https://api.smugmug.com/api/developer/apply (choose
"Non-commercial"/personal use unless this is for a business account). You'll
get an **API key** and **API secret**.

### 2. Authorize the CLI

```bash
node dist/cli.js login --api-key <your-key> --api-secret <your-secret>
```

This runs SmugMug's OAuth 1.0a flow: it prints a URL to open in your browser,
you approve access, SmugMug shows you a 6-digit code, and you paste it back
into the terminal. The resulting access token is saved to
`~/.config/smugmug-dl/credentials.json` (mode `0600`) so you only do this
once.

Tip: run `npm link` (or add this repo's `dist` directory to your `PATH`) to
use the shorter `smugmug-dl` command shown below instead of `node dist/cli.js`.

Alternatively, set `SMUGMUG_API_KEY` / `SMUGMUG_API_SECRET` /
`SMUGMUG_ACCESS_TOKEN` / `SMUGMUG_ACCESS_TOKEN_SECRET` env vars (see
`.env.example`) if you already have all four values — useful for CI or a
headless box where you generated tokens elsewhere.

## Usage

```bash
smugmug-dl whoami                 # confirm you're logged in
smugmug-dl list                   # print every gallery path
smugmug-dl size                   # estimate total size of everything, no downloading
smugmug-dl size --by-gallery      # ...with a per-gallery breakdown
smugmug-dl size --gallery "Exuma" # scope the estimate the same way --gallery scopes a download
smugmug-dl download                       # download everything into ./smugmug-download
smugmug-dl download -o ~/Pictures/smugmug # choose an output directory
smugmug-dl download --dry-run             # preview without writing files
smugmug-dl download --gallery "Iceland 2025" --gallery "Portfolio"
smugmug-dl download --gallery "Picturelife Memories/Exuma"  # nested gallery: bare name or full path both work
smugmug-dl download --include "^Weddings/"
smugmug-dl download --force               # re-download even if a matching file exists
```

Re-running `download` is cheap: it skips any file already on disk whose size
matches what SmugMug reports, so an interrupted run can just be repeated.

Discovery (walking folders, looking up each image's size) runs concurrently
rather than one API call at a time — `-c`/`--concurrency` governs this the
same way it governs image downloads, so a larger library finds and sizes
its images noticeably faster, not just downloads them faster.

While it runs you'll see a live progress bar (total image count across all
galleries, updated as each gallery is discovered). Per-file detail is
skipped while the bar is up — a summary line and, if anything failed, a list
of exactly which files and why, print once the run finishes.

### Image quality

For each photo the tool asks SmugMug for the largest size your account's
download permissions allow — "Original" if you've enabled original-size
downloads for that content, otherwise the largest rendered size SmugMug
offers. There's no `--size` flag; this always gets you the best available
without guessing which sizes are permitted per-gallery.

### Size estimate

`smugmug-dl size` sums the same "best available" file size `download` would
actually fetch for every image (see above), without writing anything to
disk. It still has to query every image individually — there's no cheaper
aggregate SmugMug exposes — so a very large library can take a little while;
a progress bar tracks galleries as they're sized. If any image reports no
size at all, it's called out separately and excluded from the total (so the
real number is a floor, not an overestimate). Accepts the same
`--gallery`/`--include`/`--exclude` filters as `download`, so you can size
a subset before committing to downloading it.

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `./smugmug-download` | Output directory |
| `-c, --concurrency <n>` | `6` | Parallel image downloads |
| `--album-concurrency <n>` | `3` | Galleries processed in parallel |
| `--gallery <name...>` | — | Only these galleries (repeatable). Matches either the bare name ("Exuma") or the full "Folder/Sub/Gallery" path exactly as `list` prints it |
| `--include <regex>` | — | Only galleries whose `Folder/Sub/Gallery` path matches |
| `--exclude <regex>` | — | Skip galleries whose path matches |
| `--force` | off | Re-download even if a matching file exists |
| `--dry-run` | off | List what would happen, write nothing |
| `--no-metadata` | — | Skip writing `_metadata.json` per gallery |

`size` additionally takes `--by-gallery` (off by default) to print a
per-gallery breakdown alongside the total.

## Development

```bash
npm run dev -- list          # run against source directly via tsx, no build step
```
