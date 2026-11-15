/**
 * What kind of file was dropped in, from its first bytes rather than its name, and which of several
 * files to read together.
 */
import { looksLikePdf } from "./pdfText";

export type FileKind = "pdf" | "picture" | "bankFile" | "other";

/** Pictures browsers can open: PNG, JPEG, GIF, WebP, BMP, and HEIC/AVIF (which only some can). */
function looksLikePicture(b: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  return (
    (b[0] === 0x89 && ascii(1, 4) === "PNG") ||
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
    ascii(0, 4) === "GIF8" ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") ||
    ascii(0, 2) === "BM" ||
    (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|mif1|msf1|avif)$/.test(ascii(8, 12)))
  );
}

export function fileKind(bytes: Uint8Array, name: string): FileKind {
  if (looksLikePdf(bytes)) return "pdf";
  if (looksLikePicture(bytes)) return "picture";
  if (/\.(ofx|qfx|qif|csv)$/i.test(name)) return "bankFile";
  return "other";
}

/** The most pictures read as one statement. */
export const MAX_PICTURES = 20;

/** Pictures of pages in page order: by name, with numbers in order (`page 2` before `page 10`). */
export function inPageOrder<T extends { name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));
}
