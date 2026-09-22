/**
 * Client-side receipt image compression: camera JPEGs are commonly 3-8 MB and
 * would bounce off the 2 MB server cap, so the browser re-encodes them before
 * validation/submit. Zero-dep: createImageBitmap + canvas.toBlob only.
 */

/** Files at or under this size pass the 2 MB server cap as-is; skip the decode. */
const COMPRESS_OVER_BYTES = 1.2 * 1024 * 1024;
export const TARGET_LONGEST_SIDE = 1600;
const JPEG_QUALITY = 0.85;

/**
 * Scale factors for the longest side, never upscaling. Pure so it is unit
 * testable; the canvas drawing itself stays out of node.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxLongestSide: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest === 0 || longest <= maxLongestSide) return { width, height };
  const scale = maxLongestSide / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Keep the human-readable base name, force the .jpg extension of the re-encode. */
function outputName(originalName: string): string {
  const base = originalName.replace(/\.[^.]+$/, "").trim();
  return `${base || "receipt"}.jpg`;
}

// ponytail: ceiling is 1600px longest side / 0.85 quality, gated on size only
// (>1.2 MB). A dimension-only trigger (e.g. >2000px) would force decoding
// every small file just to measure it — files under the cap don't need it.
// Tune TARGET_LONGEST_SIDE / JPEG_QUALITY here if receipts come out
// unreadable or still oversize; the server cap stays the sole authority.

/**
 * Best-effort re-encode of an oversize image to ≤2 MB-friendly JPEG.
 * Never throws: on any failure (decode, encode, unsupported API) it returns
 * the ORIGINAL file so the server-side check reports the real problem
 * instead of failing silently.
 */
export async function compressReceiptImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size <= COMPRESS_OVER_BYTES) return file;
  try {
    // "from-image" bakes JPEG EXIF rotation into the pixels so the
    // re-encode keeps the camera orientation.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = targetDimensions(bitmap.width, bitmap.height, TARGET_LONGEST_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size === 0) return file;
    return new File([blob], outputName(file.name), { type: "image/jpeg" });
  } catch {
    return file;
  }
}
