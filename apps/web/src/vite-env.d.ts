/// <reference types="vite/client" />

/** True when the public site is behind the header-tap gate. Set from SITE_GATE in config.env. */
declare const __SITE_GATE__: boolean;

/** Where Tesseract's engine and its English data are served, for reading pictures of statements. Set by vite.ocr.ts. */
declare const __OCR_CORE_PATH__: string;
declare const __OCR_LANG_PATH__: string;

/** Where pdf.js's WebAssembly decoders are served (a scanned PDF's pictures need them). Set by vite.ocr.ts. */
declare const __PDFJS_WASM_PATH__: string;
