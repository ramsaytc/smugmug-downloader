import { mkdir, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import pLimit from "p-limit";
import type { SmugMugClient } from "./smugmugApi.js";
import { listGalleries, listImages, type GalleryNode, type ImageEntry } from "./gallery.js";

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

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "untitled";
}

async function fileMatches(dest: string, expectedSize?: number): Promise<boolean> {
  try {
    const info = await stat(dest);
    return !expectedSize || info.size === expectedSize;
  } catch {
    return false;
  }
}

async function downloadImage(image: ImageEntry, destDir: string, opts: DownloadOptions): Promise<void> {
  const dest = join(destDir, sanitize(image.filename));

  if (!opts.force && (await fileMatches(dest, image.fileSize))) {
    console.log(`  skip (already downloaded): ${image.filename}`);
    return;
  }
  if (opts.dryRun) {
    console.log(`  would download: ${image.filename}`);
    return;
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(image.downloadUrl);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
      console.log(`  downloaded: ${image.filename}`);
      return;
    } catch (err) {
      if (attempt === 4) {
        console.error(`  FAILED: ${image.filename} (${(err as Error).message})`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
}

function galleryLabel(gallery: GalleryNode): string {
  return [...gallery.path, gallery.name].join("/");
}

export async function runDownload(client: SmugMugClient, opts: DownloadOptions): Promise<void> {
  console.log("Fetching gallery list from SmugMug...");
  let galleries = await listGalleries(client);

  if (opts.onlyGalleries?.length) {
    const wanted = new Set(opts.onlyGalleries.map((s) => s.toLowerCase()));
    galleries = galleries.filter((g) => wanted.has(g.name.toLowerCase()));
  }
  if (opts.include) galleries = galleries.filter((g) => opts.include!.test(galleryLabel(g)));
  if (opts.exclude) galleries = galleries.filter((g) => !opts.exclude!.test(galleryLabel(g)));

  console.log(`Found ${galleries.length} galleries.`);

  const imageLimit = pLimit(opts.concurrency);
  const albumLimit = pLimit(opts.albumConcurrency);
  let imagesSeen = 0;

  await Promise.all(
    galleries.map((gallery) =>
      albumLimit(async () => {
        const destDir = join(opts.outDir, ...gallery.path.map(sanitize), sanitize(gallery.name));
        if (!opts.dryRun) await mkdir(destDir, { recursive: true });

        const images = await listImages(client, gallery.albumUri);
        imagesSeen += images.length;
        console.log(`\n[${galleryLabel(gallery)}] ${images.length} image(s)`);

        if (opts.metadata && !opts.dryRun) {
          await writeFile(
            join(destDir, "_metadata.json"),
            JSON.stringify({ gallery: gallery.name, path: gallery.path, images }, null, 2)
          );
        }

        await Promise.all(images.map((image) => imageLimit(() => downloadImage(image, destDir, opts))));
      })
    )
  );

  console.log(`\nDone. Processed ${galleries.length} galleries, ${imagesSeen} images.`);
}
