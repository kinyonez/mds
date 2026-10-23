export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_EDGE = 2000;

/** 画像は長辺 2,000 px にリサイズしてから保存する（GIF / SVG はそのまま） */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  let blob: Blob = file;
  let name = file.name || 'image.png';
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale < 1 || file.size > MAX_ATTACHMENT_BYTES) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像の変換に失敗しました'))), type, 0.88));
      if (type === 'image/jpeg') name = name.replace(/\.\w+$/, '') + '.jpg';
    }
    bmp.close();
  }
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('添付ファイルは 1 ファイル 5 MB までです');
  return { blob, name };
}
