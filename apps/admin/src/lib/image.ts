import { env } from './env';

/** Public URL of a menu photo stored in Supabase Storage (bucket "menu"). */
export function menuImageUrl(path: string | null | undefined): string | undefined {
  return path ? `${env.supabaseUrl}/storage/v1/object/public/menu/${path}` : undefined;
}

/**
 * Resize a photo in the browser to WebP, max 800 px, ≤ 60 KB where possible
 * (Phase 5: images are resized before upload; Phase 6 §5 performance budget).
 */
export async function toMenuWebp(file: File, maxSide = 800): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG or WebP).');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.82, 0.72, 0.6, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    if (!blob) break;
    if (blob.size <= 60_000 || quality === 0.5) return blob;
  }
  throw new Error('This browser couldn’t convert the photo. Try a different photo or browser.');
}
