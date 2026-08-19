import pLimit from "p-limit";
import cliProgress from "cli-progress";
import type { SmugMugClient } from "./smugmugApi.js";
import { galleryLabel, listImages, resolveGalleries, type GalleryFilterOptions } from "./gallery.js";

export interface SizeOptions extends GalleryFilterOptions {
  byGallery: boolean;
}

const GALLERY_CONCURRENCY = 4;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

interface GallerySize {
  label: string;
  bytes: number;
  imageCount: number;
  unknownCount: number;
  originalCount: number;
}

/**
 * Sums the size of the same "best available" file `download` would fetch
 * for every image, without downloading anything. Still has to query every
 * image's size details (one API call each, same as `download`'s discovery
 * phase) — there's no cheaper aggregate SmugMug exposes — so this can take
 * a while on a large library.
 */
export async function runSizeEstimate(client: SmugMugClient, opts: SizeOptions): Promise<void> {
  console.log("Fetching gallery list from SmugMug...");
  const galleries = await resolveGalleries(client, opts);
  console.log(`Found ${galleries.length} galleries. Sizing each one (this queries every image, so large libraries take a while)...`);

  const bar = new cliProgress.SingleBar(
    { format: "  {bar} {percentage}% | {value}/{total} galleries", hideCursor: true, clearOnComplete: false, barsize: 30 },
    cliProgress.Presets.shades_classic
  );
  bar.start(galleries.length, 0);

  const limit = pLimit(GALLERY_CONCURRENCY);
  const sizes: GallerySize[] = [];

  await Promise.all(
    galleries.map((gallery) =>
      limit(async () => {
        const images = await listImages(client, gallery.albumUri);
        let bytes = 0;
        let unknownCount = 0;
        let originalCount = 0;
        for (const image of images) {
          if (typeof image.fileSize === "number") bytes += image.fileSize;
          else unknownCount++;
          if (image.isOriginal) originalCount++;
        }
        sizes.push({ label: galleryLabel(gallery), bytes, imageCount: images.length, unknownCount, originalCount });
        bar.increment();
      })
    )
  );

  bar.stop();
  sizes.sort((a, b) => a.label.localeCompare(b.label));

  if (opts.byGallery) {
    console.log("");
    for (const g of sizes) {
      const notes = [];
      if (g.unknownCount > 0) notes.push(`${g.unknownCount} unknown size`);
      if (g.originalCount < g.imageCount) notes.push(`${g.imageCount - g.originalCount} not original quality`);
      const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";
      console.log(`  ${g.label}: ${formatBytes(g.bytes)} across ${g.imageCount} image(s)${suffix}`);
    }
  }

  const totalBytes = sizes.reduce((sum, g) => sum + g.bytes, 0);
  const totalImages = sizes.reduce((sum, g) => sum + g.imageCount, 0);
  const totalUnknown = sizes.reduce((sum, g) => sum + g.unknownCount, 0);
  const totalOriginal = sizes.reduce((sum, g) => sum + g.originalCount, 0);

  console.log(`\n${galleries.length} galleries, ${totalImages} images, estimated total: ${formatBytes(totalBytes)}`);
  if (totalUnknown > 0) {
    console.log(
      `Note: ${totalUnknown} image(s) had no reported size (excluded from the total above) — actual size will be a bit higher.`
    );
  }
  console.log(`${totalOriginal} of ${totalImages} would download as the untouched original file (EXIF/GPS guaranteed intact).`);
  if (totalOriginal < totalImages) {
    console.log(
      `${totalImages - totalOriginal} would fall back to a rendered size — that account/gallery doesn't have "allow original downloads" enabled.`
    );
  }
}
