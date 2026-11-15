// Serves Tesseract (the OCR engine PDF to OFX reads pictures of statements with) and its English
// data beside the app, so nothing is fetched from anyone else and no picture leaves the device.
// Node-side only: vite.config.ts imports this, the app does not.
//
// Tesseract is given folders, and picks the files in them by name: the engine build that suits the
// browser from `corePath`, and `eng.traineddata.gz` from `langPath`. So these keep their own names
// in folders named for their versions, under `assets/`, which the server caches for good. The
// worker script is an ordinary `?url` import (see src/lib/pdfToOfx/ocr.ts).
//
// pdf.js is served the same way for the same tool: the decoders a scanned PDF's pictures often
// need (CCITT fax and JBIG2 for black-and-white scans, JPEG 2000, colour profiles) are WebAssembly
// files it fetches by name from `wasmUrl`. Without them a scan's pages draw blank.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/** The LSTM data Tesseract itself uses for English: small, and as accurate as the full model on print. */
const LANG_MODEL = "4.0.0_best_int";
/** pdf.js's decoders, and their licences. (Its QuickJS build only runs form scripts, which we don't.) */
const PDFJS_WASM_FILES = [
  "jbig2.wasm",
  "jbig2_nowasm_fallback.js",
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
  "LICENSE_JBIG2",
  "LICENSE_OPENJPEG",
  "LICENSE_PDFJS_JBIG2",
  "LICENSE_PDFJS_OPENJPEG",
  "LICENSE_PDFJS_QCMS",
  "LICENSE_QCMS",
];
/** The LSTM-only engine builds, with and without SIMD; each has its WebAssembly inside. */
const CORE_FILES = ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"];

function packageDir(name: string): { dir: string; version: string } {
  const pkg = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
  return { dir: dirname(pkg), version };
}

/** Each served path (from the site's root) and the file it comes from. */
function ocrFiles(): { corePath: string; langPath: string; pdfWasmPath: string; files: Map<string, string> } {
  const core = packageDir("tesseract.js-core");
  const lang = packageDir("@tesseract.js-data/eng");
  const pdfjs = packageDir("pdfjs-dist");
  const corePath = `/assets/ocr-core-${core.version}`;
  const langPath = `/assets/ocr-eng-${lang.version}-${LANG_MODEL}`;
  const pdfWasmPath = `/assets/pdfjs-wasm-${pdfjs.version}`;
  const files = new Map<string, string>();
  for (const f of CORE_FILES) files.set(`${corePath}/${f}`, join(core.dir, f));
  files.set(`${langPath}/eng.traineddata.gz`, join(lang.dir, LANG_MODEL, "eng.traineddata.gz"));
  for (const f of PDFJS_WASM_FILES) files.set(`${pdfWasmPath}/${f}`, join(pdfjs.dir, "wasm", f));
  return { corePath, langPath, pdfWasmPath, files };
}

function contentType(file: string): string {
  if (file.endsWith(".gz")) return "application/gzip";
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".js")) return "text/javascript";
  return "text/plain; charset=utf-8";
}

export function ocrPlugin(): Plugin {
  const { corePath, langPath, pdfWasmPath, files } = ocrFiles();
  return {
    name: "ocr-files",
    config: () => ({
      define: {
        __OCR_CORE_PATH__: JSON.stringify(corePath),
        __OCR_LANG_PATH__: JSON.stringify(langPath),
        __PDFJS_WASM_PATH__: JSON.stringify(pdfWasmPath),
      },
    }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const from = files.get(req.url?.split("?")[0] ?? "");
        if (!from) return next();
        res.setHeader("Content-Type", contentType(from));
        res.end(readFileSync(from));
      });
    },
    generateBundle() {
      for (const [path, from] of files) this.emitFile({ type: "asset", fileName: path.slice(1), source: readFileSync(from) });
    },
  };
}
