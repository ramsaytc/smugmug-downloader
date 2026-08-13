# smugmug-downloader

A CLI that downloads every gallery in a SmugMug account, mirroring your
folder structure on disk, preserving original filenames, and writing a
`_metadata.json` per gallery (captions, keywords, capture dates).

Built with TypeScript, native `fetch`/streams (Node 20+), and bounded
concurrency (`p-limit`) so large libraries download quickly without hammering
SmugMug's API.

## Setup

```bash
cd tools/smugmug-downloader
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

Tip: run `npm link` (or add `tools/smugmug-downloader/dist` to your `PATH`)
to use the shorter `smugmug-dl` command shown below instead of
`node dist/cli.js`.

Alternatively, set `SMUGMUG_API_KEY` / `SMUGMUG_API_SECRET` /
`SMUGMUG_ACCESS_TOKEN` / `SMUGMUG_ACCESS_TOKEN_SECRET` env vars (see
`.env.example`) if you already have all four values — useful for CI or a
headless box where you generated tokens elsewhere.

## Usage

```bash
smugmug-dl whoami                 # confirm you're logged in
smugmug-dl list                   # print every gallery path
smugmug-dl download                       # download everything into ./smugmug-download
smugmug-dl download -o ~/Pictures/smugmug # choose an output directory
smugmug-dl download --dry-run             # preview without writing files
smugmug-dl download --gallery "Iceland 2025" --gallery "Portfolio"
smugmug-dl download --include "^Weddings/"
smugmug-dl download --force               # re-download even if a matching file exists
```

Re-running `download` is cheap: it skips any file already on disk whose size
matches what SmugMug reports, so an interrupted run can just be repeated.

### Image quality

For each photo the tool asks SmugMug for the largest size your account's
download permissions allow — "Original" if you've enabled original-size
downloads for that content, otherwise the largest rendered size SmugMug
offers. There's no `--size` flag; this always gets you the best available
without guessing which sizes are permitted per-gallery.

### Options

| Flag | Default | Description |
| --- | --- | --- |
| `-o, --out <dir>` | `./smugmug-download` | Output directory |
| `-c, --concurrency <n>` | `6` | Parallel image downloads |
| `--album-concurrency <n>` | `3` | Galleries processed in parallel |
| `--gallery <name...>` | — | Only these galleries (repeatable, exact name match) |
| `--include <regex>` | — | Only galleries whose `Folder/Sub/Gallery` path matches |
| `--exclude <regex>` | — | Skip galleries whose path matches |
| `--force` | off | Re-download even if a matching file exists |
| `--dry-run` | off | List what would happen, write nothing |
| `--no-metadata` | — | Skip writing `_metadata.json` per gallery |

## Development

```bash
npm run dev -- list          # run against source directly via tsx, no build step
```
