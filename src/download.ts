import { mkdir, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import pLimit from "p-limit";
import cliProgress from "cli-progress";
import type { SmugMugClient } from "./smugmugApi.js";
import {
  galleryLabel,
  listImages,
  resolveGalleries,
  type GalleryFilterOptions,
  type GalleryNode,
  type ImageEntry,
} from "./gallery.js";

export interface DownloadOptions extends GalleryFilterOptions {
  outDir: string;
  concurrency: number;
  albumConcurrency: number;
  force: boolean;
  dryRun: boolean;
  metadata: boolean;
}

interface DownloadOutcome {
  status: "downloaded" | "skipped" | "failed";
  filename: string;
  gallery: string;
  error?: string;
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!cleaned) return "untitled";
  // "." and ".." are the only segments path.join() treats as navigation
  // rather than a literal name — neutralize them so a SmugMug folder,
  // gallery, or filename that happens to be exactly ".." can't walk the
  // output path outside the intended directory.
  if (cleaned === "." || cleaned === "..") return `_${cleaned}`;
  return cleaned;
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
