// Serves Tesseract (the OCR engine PDF to OFX reads pictures of statements with) and its English
// data beside the app, so nothing is fetched from anyone else and no picture leaves the device.
// Node-side only: vite.config.ts imports this, the app does not.
//
// Tesseract is given folders, and picks the files in them by name: the engine build that suits the
// browser from `corePath`, and `eng.traineddata.gz` from `langPath`. So these keep their own names
// in folders named for their versions, under `assets/`, which the server caches for good. The
// worker script is an ordinary `?url` import (see src/lib/pdfToOfx/ocr.ts).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/** The LSTM data Tesseract itself uses for English: small, and as accurate as the full model on print. */
const LANG_MODEL = "4.0.0_best_int";
/** The LSTM-only engine builds, with and without SIMD; each has its WebAssembly inside. */
const CORE_FILES = ["tesseract-core-simd-lstm.wasm.js", "tesseract-core-lstm.wasm.js"];

function packageDir(name: string): { dir: string; version: string } {
  const pkg = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(pkg, "utf8")) as { version: string };
  return { dir: dirname(pkg), version };
}

/** Each served path (from the site's root) and the file it comes from. */
function ocrFiles(): { corePath: string; langPath: string; files: Map<string, string> } {
  const core = packageDir("tesseract.js-core");
  const lang = packageDir("@tesseract.js-data/eng");
  const corePath = `/assets/ocr-core-${core.version}`;
  const langPath = `/assets/ocr-eng-${lang.version}-${LANG_MODEL}`;
  const files = new Map<string, string>();
  for (const f of CORE_FILES) files.set(`${corePath}/${f}`, join(core.dir, f));
  files.set(`${langPath}/eng.traineddata.gz`, join(lang.dir, LANG_MODEL, "eng.traineddata.gz"));
  return { corePath, langPath, files };
}

export function ocrPlugin(): Plugin {
  const { corePath, langPath, files } = ocrFiles();
  return {
    name: "ocr-files",
    config: () => ({
      define: { __OCR_CORE_PATH__: JSON.stringify(corePath), __OCR_LANG_PATH__: JSON.stringify(langPath) },
    }),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const from = files.get(req.url?.split("?")[0] ?? "");
        if (!from) return next();
        res.setHeader("Content-Type", from.endsWith(".gz") ? "application/gzip" : "text/javascript");
        res.end(readFileSync(from));
      });
    },
    generateBundle() {
      for (const [path, from] of files) this.emitFile({ type: "asset", fileName: path.slice(1), source: readFileSync(from) });
    },
  };
}
