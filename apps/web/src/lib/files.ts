/** A file's bytes as standard base64, which is how statement uploads travel in a command. */
export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** Bytes as standard base64. Built in chunks, so a large file doesn't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
