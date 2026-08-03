import type { ImageAttachment } from "@thinkite/protocol";
import { Directory, File, Paths } from "expo-file-system";

/**
 * Materialize base64 ImageAttachments to on-disk files in the OS cache
 * directory and return `file://` URIs.
 *
 * Why: @nandorojo/galeria's native iOS fullscreen viewer loads images
 * via SDWebImage, which does NOT decode `data:image/...;base64,...`
 * URIs out of the box. Only the FIRST image works because its initial
 * frame comes from the shared-element transition's existing UIImage
 * (sourced from our BYOIC `expo-image` thumbnail which DOES handle
 * data URIs); subsequent images fall through to SDWebImage and render
 * as black screens. Writing to a temp file lets SDWebImage's file://
 * path handle them normally.
 *
 * Sync by design — the new expo-file-system 56 API exposes synchronous
 * File ops on the native side, and per-render cost is one cheap
 * `exists` check on cache hit (~1ms for 8 images). Cache-miss writes
 * are one-time per unique image; the iOS OS evicts cacheDirectory
 * under storage pressure so we don't need an LRU layer.
 *
 * Dedup key = `${length}-${head16}${tail16}` of the base64. Stable
 * across renders, robust enough for chat-scale uniqueness (8 images
 * per message, no collision risk in practice).
 */

const CACHE_DIR = new Directory(Paths.cache, "sidecode-images");
let dirEnsured = false;

function ensureDir() {
  if (dirEnsured) return;
  if (!CACHE_DIR.exists) {
    CACHE_DIR.create({ intermediates: true });
  }
  dirEnsured = true;
}

function cacheKey(base64: string): string {
  const head = base64.slice(0, 16);
  const tail = base64.slice(-16);
  return `${base64.length}-${head}${tail}`.replace(/[^a-zA-Z0-9]/g, "_");
}

export function materializeImagesSync(
  attachments: readonly ImageAttachment[],
): string[] {
  ensureDir();
  return attachments.map((img) => {
    const ext = img.mediaType === "image/png" ? "png" : "jpg";
    const file = new File(CACHE_DIR, `${cacheKey(img.data)}.${ext}`);
    if (!file.exists) {
      file.create();
      file.write(img.data, { encoding: "base64" });
    }
    return file.uri;
  });
}
