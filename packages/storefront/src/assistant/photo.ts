export interface PreparedPhoto { blob: Blob; url: string; name: string }

export class PhotoError extends Error {}

const SUPPORTED = /^image\/(jpeg|png|webp|heic|heif)$/i;
const SUPPORTED_NAME = /\.(jpe?g|png|webp|heic|heif)$/i;

/** Validates and shrinks a room photo in the browser (max 1600px JPEG) before upload. Bytes never leave memory otherwise. */
export async function prepareRoomPhoto(file: File): Promise<PreparedPhoto> {
  if (!SUPPORTED.test(file.type) && !SUPPORTED_NAME.test(file.name)) throw new PhotoError("Please choose a JPG, PNG, WEBP or HEIC room photo.");
  if (file.size > 25 * 1024 * 1024) throw new PhotoError("Please choose a photo under 25 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new PhotoError("We couldn't read that photo. Please try another one."); }
  if (bitmap.width < 400 || bitmap.height < 300) {
    bitmap.close();
    throw new PhotoError("Please choose a larger room photo (at least 400 × 300 pixels).");
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new PhotoError("We couldn't read that photo. Please try another one.");
  return { blob, url: URL.createObjectURL(blob), name: file.name || "Room photo" };
}
