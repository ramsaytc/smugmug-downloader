import type { SmugMugClient } from "./smugmugApi.js";

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

async function walkNode(client: SmugMugClient, node: any, path: string[], out: GalleryNode[]): Promise<void> {
  if (node.Type === "Album" && node.Uris?.Album?.Uri) {
    out.push({ path, name: node.Name, albumUri: node.Uris.Album.Uri });
    return;
  }
  if (node.Uris?.ChildNodes?.Uri) {
    const childPath = node.Type === "Folder" ? [...path, node.Name] : path;
    const children = await paginateAll(client, node.Uris.ChildNodes.Uri, "Node");
    for (const child of children) {
      await walkNode(client, child, childPath, out);
    }
  }
}

/** Recursively walks the authenticated user's folder tree and returns every gallery (album) found. */
export async function listGalleries(client: SmugMugClient): Promise<GalleryNode[]> {
  const authUser = await client.get<any>("/api/v2!authuser");
  const rootNodeUri: string = authUser.Response.User.Uris.Node.Uri;
  const root = await client.get<any>(rootNodeUri);

  const out: GalleryNode[] = [];
  if (root.Response.Node?.Uris?.ChildNodes?.Uri) {
    const children = await paginateAll(client, root.Response.Node.Uris.ChildNodes.Uri, "Node");
    for (const child of children) {
      await walkNode(client, child, [], out);
    }
  }
  return out;
}

/**
 * Fetches every image in an album along with its best available download
 * URL. Prefers the ImageSizeDetails sub-resource (Original if the account's
 * download permissions allow it, else the largest size available); falls
 * back to the AlbumImage's own ArchivedUri if present.
 */
export async function listImages(client: SmugMugClient, albumUri: string): Promise<ImageEntry[]> {
  const raw = await paginateAll(client, `${albumUri}!images`, "AlbumImage");
  const out: ImageEntry[] = [];

  for (const img of raw) {
    let downloadUrl: string | undefined;
    let fileSize: number | undefined;
    let md5: string | undefined;
    let filename: string = img.FileName;

    const sizeDetailsUri: string | undefined = img?.Uris?.ImageSizeDetails?.Uri;
    if (sizeDetailsUri) {
      try {
        const details = await client.get<any>(sizeDetailsUri);
        const d = details.Response.ImageSizeDetails;
        downloadUrl =
          d.OriginalImageUrl ??
          d.LargestImageUrl ??
          d.X5LargeImageUrl ??
          d.X4LargeImageUrl ??
          d.X3LargeImageUrl ??
          d.X2LargeImageUrl ??
          d.LargeImageUrl ??
          d.MediumImageUrl;
        fileSize = d.OriginalSize;
        md5 = d.MD5Sum;
        filename = d.Filename ?? filename;
      } catch {
        // fall through to ArchivedUri below
      }
    }

    if (!downloadUrl && img.ArchivedUri) {
      downloadUrl = img.ArchivedUri;
      fileSize = img.ArchivedSize;
      md5 = img.ArchivedMD5;
    }

    if (!downloadUrl) {
      console.warn(`  warning: no downloadable size found for "${filename}", skipping`);
      continue;
    }

    out.push({
      filename,
      downloadUrl,
      fileSize,
      md5,
      caption: img.Caption || undefined,
      keywords: Array.isArray(img.KeywordArray) ? img.KeywordArray.join(", ") : img.Keywords || undefined,
      dateTimeOriginal: img.DateTimeOriginal || undefined,
    });
  }

  return out;
}
