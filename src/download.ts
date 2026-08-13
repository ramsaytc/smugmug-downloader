import { mkdir, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import pLimit from "p-limit";
import cliProgress from "cli-progress";
import type { SmugMugClient } from "./smugmugApi.js";
import { galleryLabel, listGalleries, listImages, type GalleryNode, type ImageEntry } from "./gallery.js";

export interface DownloadOptions {
  outDir: string;
  concurrency: number;
  albumConcurrency: number;
  force: boolean;
  dryRun: boolean;
  metadata: boolean;
  include?: RegExp;
  exclude?: RegExp;
  onlyGalleries?: string[];
}

interface DownloadOutcome {
  status: "downloaded" | "skipped" | "failed";
  filename: string;
  gallery: string;
  error?: string;
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

/** Lowercases and collapses " / " (as `list` used to render it) down to "/" so copy-pasted queries still match. */
function normalizeGalleryQuery(s: string): string {
  return s.trim().toLowerCase().replace(/\s*\/\s*/g, "/");
}

async function fileMatches(dest: string, expectedSize?: number): Promise<boolean> {
  try {
    const info = await stat(dest);
    return !expectedSize || info.size === expectedSize;
  } catch {
    return false;
  }
}

async function downloadImage(
  image: ImageEntry,
  destDir: string,
  gallery: string,
  force: boolean
): Promise<DownloadOutcome> {
  const dest = join(destDir, sanitize(image.filename));

  if (!force && (await fileMatches(dest, image.fileSize))) {
    return { status: "skipped", filename: image.filename, gallery };
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(image.downloadUrl);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
      return { status: "downloaded", filename: image.filename, gallery };
    } catch (err) {
      if (attempt === 4) {
        return { status: "failed", filename: image.filename, gallery, error: (err as Error).message };
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  /* istanbul ignore next: loop above always returns by attempt 4 */
  return { status: "failed", filename: image.filename, gallery, error: "unreachable" };
}

function albumKeyOf(gallery: GalleryNode): string {
  return gallery.albumUri.split("/").filter(Boolean).pop() ?? "";
}

/**
 * SmugMug allows two galleries to share the same folder + name (we've seen
 * this in practice — e.g. one populated gallery and one empty duplicate).
 * Left alone, both would resolve to the same output directory and silently
 * clobber each other's files and _metadata.json. Disambiguate by album key.
 */
function resolveDestDirs(galleries: GalleryNode[], outDir: string): Map<GalleryNode, string> {
  const labelCounts = new Map<string, number>();
  for (const g of galleries) {
    const label = galleryLabel(g);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const warned = new Set<string>();
  const dirs = new Map<GalleryNode, string>();
  for (const g of galleries) {
    const label = galleryLabel(g);
    let nameSegment = sanitize(g.name);
    if ((labelCounts.get(label) ?? 0) > 1) {
      nameSegment = `${nameSegment} (${albumKeyOf(g) || "?"})`;
      if (!warned.has(label)) {
        warned.add(label);
        console.warn(`warning: multiple galleries named "${label}" — writing each to its own suffixed folder.`);
      }
    }
    dirs.set(g, join(outDir, ...g.path.map(sanitize), nameSegment));
  }
  return dirs;
}

async function resolveGalleries(client: SmugMugClient, opts: DownloadOptions): Promise<GalleryNode[]> {
  let galleries = await listGalleries(client);

  if (opts.onlyGalleries?.length) {
    // Matches either the bare gallery name ("Exuma") or its full path
    // ("Picturelife Memories/Exuma") as shown by `smugmug-dl list`.
    const wanted = new Set(opts.onlyGalleries.map(normalizeGalleryQuery));
    galleries = galleries.filter(
      (g) => wanted.has(normalizeGalleryQuery(g.name)) || wanted.has(normalizeGalleryQuery(galleryLabel(g)))
    );
  }
  if (opts.include) galleries = galleries.filter((g) => opts.include!.test(galleryLabel(g)));
  if (opts.exclude) galleries = galleries.filter((g) => !opts.exclude!.test(galleryLabel(g)));

  return galleries;
}

async function runDryRun(client: SmugMugClient, galleries: GalleryNode[], outDir: string): Promise<void> {
  const destDirs = resolveDestDirs(galleries, outDir);
  let totalImages = 0;
  for (const gallery of galleries) {
    const images = await listImages(client, gallery.albumUri);
    totalImages += images.length;
    console.log(`\n[${galleryLabel(gallery)}] -> ${destDirs.get(gallery)} (${images.length} image(s))`);
    for (const image of images) console.log(`  would download: ${image.filename}`);
  }
  console.log(`\nDry run: ${galleries.length} galleries, ${totalImages} images would be processed.`);
}

export async function runDownload(client: SmugMugClient, opts: DownloadOptions): Promise<void> {
  console.log("Fetching gallery list from SmugMug...");
  const galleries = await resolveGalleries(client, opts);
  console.log(`Found ${galleries.length} galleries.`);

  if (opts.dryRun) {
    await runDryRun(client, galleries, opts.outDir);
    return;
  }

  const destDirs = resolveDestDirs(galleries, opts.outDir);
  const imageLimit = pLimit(opts.concurrency);
  const albumLimit = pLimit(opts.albumConcurrency);

  // Total grows as each gallery's image list comes back, since galleries are
  // discovered and downloaded concurrently rather than listed up front.
  const bar = new cliProgress.SingleBar(
    {
      format: "  {bar} {percentage}% | {value}/{total} images | {file}",
      hideCursor: true,
      clearOnComplete: false,
      barsize: 30,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(0, 0, { file: "" });

  const failures: DownloadOutcome[] = [];
  let downloaded = 0;
  let skipped = 0;

  await Promise.all(
    galleries.map((gallery) =>
      albumLimit(async () => {
        const label = galleryLabel(gallery);
        const destDir = destDirs.get(gallery)!;
        await mkdir(destDir, { recursive: true });

        const images = await listImages(client, gallery.albumUri);
        bar.setTotal(bar.getTotal() + images.length);

        if (opts.metadata) {
          await writeFile(
            join(destDir, "_metadata.json"),
            JSON.stringify({ gallery: gallery.name, path: gallery.path, images }, null, 2)
          );
        }

        await Promise.all(
          images.map((image) =>
            imageLimit(async () => {
              const outcome = await downloadImage(image, destDir, label, opts.force);
              if (outcome.status === "downloaded") downloaded += 1;
              else if (outcome.status === "skipped") skipped += 1;
              else failures.push(outcome);
              bar.increment(1, { file: `${label}/${image.filename}` });
            })
          )
        );
      })
    )
  );

  bar.stop();

  console.log(
    `\nDone. ${galleries.length} galleries — ${downloaded} downloaded, ${skipped} already up to date, ${failures.length} failed.`
  );
  if (failures.length > 0) {
    console.log("\nFailed:");
    for (const f of failures) console.log(`  ${f.gallery}/${f.filename}: ${f.error}`);
  }
}
