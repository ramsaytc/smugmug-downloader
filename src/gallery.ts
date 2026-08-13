import pLimit from "p-limit";
import type { SmugMugClient } from "./smugmugApi.js";

/** Default concurrency for metadata calls (folder listing, per-image size lookups) — cheap JSON requests, safe to run well ahead of the byte-download concurrency. */
const DEFAULT_METADATA_CONCURRENCY = 8;

export interface GalleryNode {
  /** Folder path leading to this gallery, e.g. ["2024", "Weddings"] */
  path: string[];
  name: string;
  albumUri: string;
}

export interface ImageEntry {
  filename: string;
  downloadUrl: string;
  fileSize?: number;
  md5?: string;
  caption?: string;
  keywords?: string;
  dateTimeOriginal?: string;
}

/** Canonical "Folder/Sub/Gallery" identifier for a gallery, used consistently by `list`, `--gallery`, `--include`, and `--exclude`. */
export function galleryLabel(gallery: GalleryNode): string {
  return [...gallery.path, gallery.name].join("/");
}

const PAGE_SIZE = 100;

async function paginateAll(client: SmugMugClient, uri: string, key: "Node" | "AlbumImage"): Promise<any[]> {
  const results: any[] = [];
  let start = 1;
  for (;;) {
    const data = await client.get<any>(uri, { start, count: PAGE_SIZE });
    const items = data?.Response?.[key] ?? [];
    const batch = Array.isArray(items) ? items : [items];
    results.push(...batch);

    const total = data?.Response?.Pages?.Total ?? results.length;
    if (batch.length === 0 || start + PAGE_SIZE > total) break;
    start += PAGE_SIZE;
  }
  return results;
}

async function walkNode(
  client: SmugMugClient,
  node: any,
  path: string[],
  out: GalleryNode[],
  limit: ReturnType<typeof pLimit>
): Promise<void> {
  if (node.Type === "Album" && node.Uris?.Album?.Uri) {
    out.push({ path, name: node.Name, albumUri: node.Uris.Album.Uri });
    return;
  }
  if (node.Uris?.ChildNodes?.Uri) {
    const childPath = node.Type === "Folder" ? [...path, node.Name] : path;
    // Only the actual network call goes through `limit` — recursing into
    // walkNode itself must stay unbounded. Wrapping the recursive call in
    // the same limiter would deadlock: a parent occupying one of N slots
    // would then need another slot from that same limiter for its own
    // child, which can never free up before the parent (still awaiting it)
    // releases its own.
    const children = await limit(() => paginateAll(client, node.Uris.ChildNodes.Uri, "Node"));
    // Sibling folders/albums don't depend on each other, so walk them
    // concurrently rather than one network round-trip at a time.
    await Promise.all(children.map((child) => walkNode(client, child, childPath, out, limit)));
  }
}

/** Recursively walks the authenticated user's folder tree and returns every gallery (album) found. */
export async function listGalleries(client: SmugMugClient): Promise<GalleryNode[]> {
  const authUser = await client.get<any>("/api/v2!authuser");
  const rootNodeUri: string = authUser.Response.User.Uris.Node.Uri;
  const root = await client.get<any>(rootNodeUri);

  const out: GalleryNode[] = [];
  if (root.Response.Node?.Uris?.ChildNodes?.Uri) {
    const limit = pLimit(DEFAULT_METADATA_CONCURRENCY);
    const children = await limit(() => paginateAll(client, root.Response.Node.Uris.ChildNodes.Uri, "Node"));
    await Promise.all(children.map((child) => walkNode(client, child, [], out, limit)));
  }
  return out;
}

export interface GalleryFilterOptions {
  include?: RegExp;
  exclude?: RegExp;
  onlyGalleries?: string[];
}

/** Lowercases and collapses " / " (as `list` used to render it pre-1.0) down to "/" so copy-pasted queries still match. */
function normalizeGalleryQuery(s: string): string {
  return s.trim().toLowerCase().replace(/\s*\/\s*/g, "/");
}

/** Fetches every gallery, then applies --gallery/--include/--exclude filtering shared by `download` and `size`. */
export async function resolveGalleries(client: SmugMugClient, opts: GalleryFilterOptions): Promise<GalleryNode[]> {
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

/** First non-empty (after trimming) string, since SmugMug returns "" rather than omitting the field for some older/imported photos. */
function firstNonBlank(...values: (string | undefined | null)[]): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Builds a filename for images with no usable FileName/Filename from
 * SmugMug (seen on some older or migrated-in photos) so they never collide
 * with each other under a generic name like "untitled.jpg".
 */
function fallbackFilename(img: any, details: any): string {
  const ext = firstNonBlank(details?.Format, img.Format)?.toLowerCase() || "jpg";
  const key =
    firstNonBlank(img.ImageKey) ??
    (typeof img.Uri === "string" ? img.Uri.split("/").filter(Boolean).pop() : undefined) ??
    "image";
  return `${key}.${ext}`;
}

async function resolveImageEntry(client: SmugMugClient, img: any): Promise<ImageEntry | undefined> {
  let downloadUrl: string | undefined;
  let fileSize: number | undefined;
  let md5: string | undefined;
  let details: any;

  const sizeDetailsUri: string | undefined = img?.Uris?.ImageSizeDetails?.Uri;
  if (sizeDetailsUri) {
    try {
      const res = await client.get<any>(sizeDetailsUri);
      details = res.Response.ImageSizeDetails;
      downloadUrl =
        details.OriginalImageUrl ??
        details.LargestImageUrl ??
        details.X5LargeImageUrl ??
        details.X4LargeImageUrl ??
        details.X3LargeImageUrl ??
        details.X2LargeImageUrl ??
        details.LargeImageUrl ??
        details.MediumImageUrl;
      fileSize = details.OriginalSize;
      md5 = details.MD5Sum;
    } catch {
      // fall through to ArchivedUri below
    }
  }

  if (!downloadUrl && img.ArchivedUri) {
    downloadUrl = img.ArchivedUri;
    fileSize = img.ArchivedSize;
    md5 = img.ArchivedMD5;
  }

  const filename = firstNonBlank(details?.Filename, img.FileName) ?? fallbackFilename(img, details);

  if (!downloadUrl) {
    console.warn(`  warning: no downloadable size found for "${filename}", skipping`);
    return undefined;
  }

  return {
    filename,
    downloadUrl,
    fileSize,
    md5,
    caption: img.Caption || undefined,
    keywords: Array.isArray(img.KeywordArray) ? img.KeywordArray.join(", ") : img.Keywords || undefined,
    dateTimeOriginal: img.DateTimeOriginal || undefined,
  };
}

/**
 * Fetches every image in an album along with its best available download
 * URL. Prefers the ImageSizeDetails sub-resource (Original if the account's
 * download permissions allow it, else the largest size available); falls
 * back to the AlbumImage's own ArchivedUri if present. Looks up each
 * image's size concurrently (bounded by `concurrency`) rather than one
 * request at a time — this is the dominant cost for large galleries.
 */
export async function listImages(
  client: SmugMugClient,
  albumUri: string,
  concurrency = DEFAULT_METADATA_CONCURRENCY
): Promise<ImageEntry[]> {
  const raw = await paginateAll(client, `${albumUri}!images`, "AlbumImage");
  const limit = pLimit(concurrency);

  const resolved = await Promise.all(raw.map((img) => limit(() => resolveImageEntry(client, img))));
  const out = resolved.filter((entry): entry is ImageEntry => entry !== undefined);

  dedupeFilenames(out);
  return out;
}

/** Guards against any remaining filename collisions within a gallery (e.g. two cameras both producing "IMG_0001.jpg"), regardless of cause. */
function dedupeFilenames(images: ImageEntry[]): void {
  const seen = new Map<string, number>();
  for (const image of images) {
    const count = (seen.get(image.filename) ?? 0) + 1;
    seen.set(image.filename, count);
    if (count > 1) {
      const dot = image.filename.lastIndexOf(".");
      const base = dot > 0 ? image.filename.slice(0, dot) : image.filename;
      const ext = dot > 0 ? image.filename.slice(dot) : "";
      image.filename = `${base} (${count})${ext}`;
    }
  }
}
