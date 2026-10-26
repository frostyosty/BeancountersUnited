// The invoice maker's page editor: drag, resize and edit blocks on an A4 page, with undo and PDF export.
// It drives plain DOM inside one element; the React page (pages/InvoiceMakerPage.tsx) owns the toolbar, the
// dialogs and templates, and the host's callbacks save the draft and upload images to the user's account.
// An invoice made here is a free-form document, not part of anyone's books.
import interact from "interactjs";
import { sanitizeInvoiceHtml } from "./invoices";

export type BlockKind = "text" | "image" | "items-table" | "line";

export type SaveState = "saved" | "saving" | "unsaved" | "failed";

export interface EditorHost {
  /** The A4 page the editor fills. */
  page: HTMLElement;
  /** The saved draft to start from, or null for the sample. Cleaned before it's shown. */
  initialHtml: string | null;
  /** Saves the draft to the user's account. `leaving`: the page is closing, so send it regardless. */
  saveDraft(html: string, leaving: boolean): Promise<void>;
  /** Uploads an image (a data URL) to the user's account; resolves to the URL to show it from. */
  uploadImage(dataUrl: string): Promise<string>;
  /** In place of window.alert. */
  notify(message: string, tone: "info" | "warn"): void;
  onHistoryChange(canUndo: boolean, canRedo: boolean): void;
  onSaveState(state: SaveState): void;
}

export interface InvoiceEditor {
  add(kind: BlockKind): void;
  undo(): void;
  redo(): void;
  /** The page as it would be saved. */
  html(): string;
  /** Replaces the page (a template, or the sample) as one step that can be undone. */
  replace(html: string): void;
  exportPdf(): Promise<void>;
  /** Saves anything unsaved and removes every listener. */
  destroy(): void;
}

const GRID = 15;
const MAX_HISTORY = 50;
// Uploaded images are shrunk first: the server takes up to 1 MB, and smaller pages export faster.
const MAX_IMAGE_DIMENSION = 1000;
const MAX_IMAGE_DATA_LENGTH = 500_000;
const MIN_PAGE_SCALE = 0.45;

// Fonts already on the viewer's machine, so the page makes no outside requests.
const FONTS = [
  "system-ui, 'Segoe UI', Roboto, sans-serif",
  "Georgia, 'Times New Roman', serif",
  "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif",
  "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', monospace",
];
const FONT_SIZES = ["12px", "14px", "16px", "18px", "24px", "36px"];
const CARD_STYLES = ["style-default", "style-shadow", "style-outline-dark", "style-inset"];
const LINE_STYLES = ["solid", "dashed", "dotted"];

/** How long the page has to sit still before the draft is saved. */
const SAVE_DELAY_MS = 2000;
const UPLOADABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// The last-used look for new blocks: a convenience for this browser only.
interface Prefs {
  font: number;
  fontSize: string;
  cardStyle: string;
}
const PREFS_KEY = "wla.invoice.prefs";

function formatDate(d: Date) {
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

/** Our own sample: a made-up NZ business's tax invoice. Every amount is plain text the user edits. */
export function sampleInvoice(today: Date): string {
  const due = new Date(today.getFullYear(), today.getMonth() + 1, 20);
  const text = (left: number, top: number, width: number | null, inner: string, style = "") =>
    `<div class="invoice-element style-default" style="position: absolute; left: ${left}px; top: ${top}px;${
      width ? ` width: ${width}px;` : ""
    }"><div contenteditable="true" class="invoice-text" style="${style}">${inner}</div></div>`;
  return [
    text(45, 45, null, "TAX INVOICE", `font-size: 36px; font-weight: bold; font-family: ${FONTS[2]};`),
    `<div class="invoice-element image-element style-default" style="position: absolute; left: 540px; top: 45px; width: 210px; height: 90px;"><div class="image-placeholder">Your logo<br>(click to upload)</div><input type="file" accept="image/*" hidden></div>`,
    text(
      450,
      150,
      300,
      "<b>Kōwhai Gardens Ltd</b><br>12 Example Road<br>Sampletown 0000<br>GST number: 000-000-000",
      "text-align: right;",
    ),
    text(45, 150, 330, "<b>Bill to:</b><br>Sample Customer<br>34 Placeholder Street<br>Exampleville 0000"),
    text(
      45,
      285,
      330,
      `<b>Invoice number:</b> INV-0001<br><b>Date:</b> ${formatDate(today)}<br><b>Due:</b> ${formatDate(due)}`,
    ),
    `<div class="invoice-element style-default" style="position: absolute; left: 45px; top: 390px; width: 705px;"><table class="invoice-items-table"><thead><tr><th contenteditable="true">Description</th><th contenteditable="true">Qty</th><th contenteditable="true">Unit price</th><th contenteditable="true">Amount</th></tr></thead><tbody><tr><td contenteditable="true">Garden design consultation</td><td contenteditable="true">2</td><td contenteditable="true">$90.00</td><td contenteditable="true">$180.00</td></tr><tr><td contenteditable="true">Native plants (assorted)</td><td contenteditable="true">10</td><td contenteditable="true">$12.00</td><td contenteditable="true">$120.00</td></tr></tbody></table><button type="button" class="add-row-btn">+ Add row</button></div>`,
    text(
      450,
      570,
      300,
      "Subtotal: $300.00<br>GST (15%): $45.00<br><b>Total (incl. GST): $345.00</b>",
      "text-align: right;",
    ),
    `<div class="invoice-element line-element style-default" style="position: absolute; left: 45px; top: 705px; width: 705px; height: 10px;"><div class="inner-line" style="border-top-style: solid;"></div></div>`,
    text(
      45,
      735,
      705,
      "<b>Payment:</b> please pay by the due date to 00-0000-0000000-00, using the invoice number as the reference.<br>Thank you for your business!",
    ),
  ].join("");
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** A PNG, JPEG, GIF or WebP data URL, small enough to upload. Anything else (an SVG) is redrawn as a PNG. */
async function prepareImage(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file);
  const img = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = original;
  });
  if (!loaded || !img.naturalWidth || !img.naturalHeight) throw new Error("The image can't be measured.");

  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && original.length <= MAX_IMAGE_DATA_LENGTH && UPLOADABLE.has(file.type)) return original;

  const scaled = document.createElement("canvas");
  scaled.width = Math.round(img.naturalWidth * scale);
  scaled.height = Math.round(img.naturalHeight * scale);
  const ctx = scaled.getContext("2d");
  if (!ctx) return original;
  ctx.drawImage(img, 0, 0, scaled.width, scaled.height);

  // PNG keeps a logo's transparency; photos are far smaller as JPEG.
  if (file.type !== "image/jpeg") {
    const png = scaled.toDataURL("image/png");
    if (png.length <= MAX_IMAGE_DATA_LENGTH) return png;
  }
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, scaled.width, scaled.height);
  return scaled.toDataURL("image/jpeg", 0.85);
}

export function mountInvoiceEditor(host: EditorHost): InvoiceEditor {
  const { page } = host;
  const wrapper = page.parentElement;
  let prefs: Prefs = readJson<Prefs>(PREFS_KEY, { font: 0, fontSize: "14px", cardStyle: "style-default" });

  let elementCounter = 0;
  let lastPosition = { x: 30, y: 30 };
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  let recordTimer: ReturnType<typeof setTimeout> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSaved = "";
  let saving: Promise<void> | null = null;
  let suppressNextClick = false;
  let destroyed = false;

  // --- Saving the draft ---------------------------------------------------------------------------------

  /** The page's markup without editor-only state: selection, drag highlight and the control bars. */
  function pageState(): string {
    const clone = page.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".invoice-element").forEach((el) => el.classList.remove("selected", "is-dragging"));
    clone.querySelectorAll(".element-controls, .font-cycler-icon").forEach((el) => el.remove());
    return clone.innerHTML;
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Only a convenience.
    }
  }

  /** Sends the draft if it changed since the last save. One request at a time; a change made meanwhile goes next. */
  function saveNow(leaving = false) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const html = pageState();
    if (html === lastSaved) {
      if (!saving) host.onSaveState("saved");
      return;
    }
    if (saving && !leaving) {
      // Try again once the request in flight is done.
      void saving.finally(() => autoSave());
      return;
    }
    host.onSaveState("saving");
    const request: Promise<void> = host
      .saveDraft(html, leaving)
      .then(
        () => {
          lastSaved = html;
          if (!destroyed) host.onSaveState(pageState() === lastSaved ? "saved" : "unsaved");
        },
        () => {
          if (!destroyed) host.onSaveState("failed");
        },
      )
      .finally(() => {
        if (saving === request) saving = null;
      });
    saving = request;
  }

  function autoSave() {
    if (destroyed) return;
    if (saveTimer) clearTimeout(saveTimer);
    host.onSaveState("unsaved");
    saveTimer = setTimeout(() => saveNow(), SAVE_DELAY_MS);
  }

  // --- Undo and redo -------------------------------------------------------------------------------------

  function reportHistory() {
    host.onHistoryChange(undoStack.length > 1, redoStack.length > 0);
  }

  function recordState() {
    if (recordTimer) clearTimeout(recordTimer);
    recordTimer = null;
    const state = pageState();
    // Nothing changed (a plain click): keep the history clean.
    if (undoStack[undoStack.length - 1] === state) return;
    redoStack = [];
    undoStack.push(state);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    reportHistory();
  }

  /** One undo step per burst of typing or arrow-key nudging. */
  function scheduleRecord() {
    if (recordTimer) clearTimeout(recordTimer);
    recordTimer = setTimeout(() => {
      recordState();
      autoSave();
    }, 500);
  }

  function flushPendingRecord() {
    if (recordTimer) recordState();
  }

  function changed() {
    recordState();
    autoSave();
    savePrefs();
  }

  function replacePage(html: string) {
    page.querySelectorAll<HTMLElement>(".invoice-element").forEach((el) => interact(el).unset());
    page.innerHTML = html;
    reinitializeElements();
  }

  function restoreState(state: string) {
    replacePage(state);
    autoSave();
    reportHistory();
  }

  function undo() {
    flushPendingRecord();
    if (undoStack.length <= 1) return;
    redoStack.push(undoStack.pop()!);
    restoreState(undoStack[undoStack.length - 1]!);
  }

  function redo() {
    flushPendingRecord();
    const next = redoStack.pop();
    if (next === undefined) return;
    undoStack.push(next);
    restoreState(next);
  }

  // --- Blocks --------------------------------------------------------------------------------------------

  function setSelected(target: Element | null) {
    page.querySelectorAll(".invoice-element.selected").forEach((el) => {
      if (el !== target) el.classList.remove("selected");
    });
    target?.classList.add("selected");
  }

  function control(className: string, label: string, title: string) {
    return `<button type="button" tabindex="-1" class="element-control-icon ${className}" title="${title}">${label}</button>`;
  }

  /** Every block gets a control bar. It isn't saved, so it's added again whenever the page is loaded. */
  function ensureControls(el: HTMLElement) {
    if (el.querySelector(":scope > .element-controls")) return;
    const controls = document.createElement("div");
    controls.className = "element-controls";
    let html = control("card-style-cycler-icon", "Style", "Change the box style");
    if (el.classList.contains("line-element")) {
      html += control("line-style-cycler-icon", "Dashes", "Change the line style");
    } else if (el.querySelector('[contenteditable="true"]')) {
      html += control("font-size-cycler-icon", "Size", "Change the text size");
    }
    html += control("delete-element-icon", "Delete", "Delete this block");
    controls.innerHTML = html;
    el.prepend(controls);
  }

  function addBlock(kind: BlockKind) {
    elementCounter++;
    const el = document.createElement("div");
    el.id = `invoice-element-${elementCounter}`;
    el.className = `invoice-element ${prefs.cardStyle}`;
    lastPosition = { x: ((lastPosition.x + 25) % 200) + 30, y: ((lastPosition.y + 25) % 300) + 30 };
    Object.assign(el.style, { position: "absolute", left: `${lastPosition.x}px`, top: `${lastPosition.y}px` });

    switch (kind) {
      case "text":
        el.style.minWidth = "250px";
        el.innerHTML = `<div contenteditable="true" class="invoice-text" style="font-family: ${FONTS[prefs.font] ?? FONTS[0]}; font-size: ${prefs.fontSize};">New text</div>`;
        break;
      case "image":
        el.classList.add("image-element");
        Object.assign(el.style, { width: "160px", height: "120px" });
        el.innerHTML = `<div class="image-placeholder">Image<br>(click to upload)</div><input type="file" accept="image/*" hidden>`;
        break;
      case "items-table":
        el.style.width = "705px";
        el.innerHTML = `<table class="invoice-items-table"><thead><tr><th contenteditable="true">Description</th><th contenteditable="true">Qty</th><th contenteditable="true">Amount</th></tr></thead><tbody><tr><td contenteditable="true">Item</td><td contenteditable="true">1</td><td contenteditable="true">$0.00</td></tr></tbody></table><button type="button" class="add-row-btn">+ Add row</button>`;
        break;
      case "line":
        el.classList.add("line-element");
        Object.assign(el.style, { height: "10px", width: "300px" });
        el.innerHTML = `<div class="inner-line" style="border-top-style: solid;"></div>`;
        break;
    }

    ensureControls(el);
    page.appendChild(el);
    if (kind === "image") setupImageUpload(el);
    makeInteractable(el);
    setSelected(el);
    changed();
  }

  function setupImageUpload(el: HTMLElement) {
    const input = el.querySelector<HTMLInputElement>('input[type="file"]');
    input?.addEventListener("change", () => {
      const file = input.files?.[0];
      input.value = ""; // so the same file can be picked again
      if (!file) return;
      el.classList.add("is-uploading");
      prepareImage(file)
        .then((dataUrl) => host.uploadImage(dataUrl))
        .then((url) => {
          Object.assign(el.style, {
            backgroundImage: `url("${url}")`,
            backgroundSize: "contain",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
          });
          el.classList.add("has-image");
          changed();
        })
        .catch(() =>
          host.notify("Sorry, that image couldn't be added. Try a PNG or JPEG under 1 MB.", "warn"),
        )
        .finally(() => el.classList.remove("is-uploading"));
    });
  }

  function addTableRow(el: Element) {
    const table = el.querySelector("table");
    const body = table?.querySelector("tbody");
    if (!table || !body) return;
    const columns = table.querySelector("tr")?.children.length || 3;
    const row = body.insertRow();
    row.innerHTML = Array.from({ length: columns }, (_, i) => `<td contenteditable="true">${i === 0 ? "Item" : ""}</td>`).join("");
    changed();
  }

  function deleteBlock(el: HTMLElement) {
    interact(el).unset();
    el.remove();
    changed();
  }

  function nudge(el: HTMLElement, key: string) {
    const x = parseFloat(el.style.left) || 0;
    const y = parseFloat(el.style.top) || 0;
    const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
    el.style.left = `${Math.max(0, x + dx)}px`;
    el.style.top = `${Math.max(0, y + dy)}px`;
    scheduleRecord();
  }

  function cycleCardStyle(el: HTMLElement) {
    const current = CARD_STYLES.findIndex((s) => el.classList.contains(s));
    const next = CARD_STYLES[(current + 1) % CARD_STYLES.length]!;
    el.classList.remove(...CARD_STYLES);
    el.classList.add(next);
    prefs.cardStyle = next;
    changed();
  }

  function textParts(el: HTMLElement) {
    return Array.from(el.querySelectorAll<HTMLElement>('[contenteditable="true"]'));
  }

  function cycleFont(el: HTMLElement) {
    const parts = textParts(el);
    if (!parts.length) return;
    const current = Number(el.dataset.font ?? -1);
    const next = (current + 1) % FONTS.length;
    el.dataset.font = String(next);
    parts.forEach((p) => (p.style.fontFamily = FONTS[next]!));
    prefs.font = next;
    changed();
  }

  function cycleFontSize(el: HTMLElement) {
    const parts = textParts(el);
    if (!parts.length) return;
    const current = FONT_SIZES.indexOf(parts[0]!.style.fontSize || getComputedStyle(parts[0]!).fontSize);
    const next = FONT_SIZES[(current === -1 ? 1 : current + 1) % FONT_SIZES.length]!;
    parts.forEach((p) => (p.style.fontSize = next));
    prefs.fontSize = next;
    changed();
  }

  function cycleLineStyle(el: HTMLElement) {
    const line = el.querySelector<HTMLElement>(".inner-line");
    if (!line) return;
    const current = LINE_STYLES.indexOf(line.style.borderTopStyle || "solid");
    line.style.borderTopStyle = LINE_STYLES[(current + 1) % LINE_STYLES.length]!;
    changed();
  }

  // --- Dragging and resizing -----------------------------------------------------------------------------

  /** The page is shrunk with a CSS transform on small screens; pointer distances are converted back. */
  function pageScale() {
    const width = page.offsetWidth;
    return width ? page.getBoundingClientRect().width / width : 1;
  }

  function endInteraction(el: HTMLElement) {
    el.classList.remove("is-dragging");
    suppressNextClick = true;
    setTimeout(() => (suppressNextClick = false), 50);
    changed();
  }

  function makeInteractable(el: HTMLElement) {
    const longPress = 400;
    const noDrag = ".element-controls, .element-control-icon, .add-row-btn, input";
    const isLine = el.classList.contains("line-element");
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let downPoint: { x: number; y: number } | null = null;
    let wasEditing = false;
    let pos = { x: 0, y: 0 };
    const interactable = interact(el);

    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
      downPoint = null;
    };

    // interact's pointer events carry the live interaction; only the parts used here are typed.
    type Interaction = {
      pointerIsDown: boolean;
      interacting(): boolean;
      prepared?: { name?: string | null };
      start(action: { name: "drag" }, target: typeof interactable, element: Element): unknown;
    };
    type PointerLike = { target: EventTarget | null; clientX: number; clientY: number; pointerType: string; interaction: Interaction };

    const startDrag = (interaction: Interaction) => {
      cancelPress();
      if (!interaction.pointerIsDown || interaction.interacting()) return;
      // An edge grab is a resize, which interact starts on its own.
      if (interaction.prepared?.name === "resize") return;
      // Dragging replaces text editing: drop focus and any half-made selection.
      if ((document.activeElement as HTMLElement | null)?.isContentEditable) (document.activeElement as HTMLElement).blur();
      window.getSelection()?.removeAllRanges();
      interaction.start({ name: "drag" }, interactable, el);
    };

    interactable
      .on("down", (event: PointerLike) => {
        cancelPress();
        if ((event.target as Element | null)?.closest?.(noDrag)) return;
        downPoint = { x: event.clientX, y: event.clientY };
        // While a text block is being edited, dragging inside it selects text instead.
        const active = document.activeElement as HTMLElement | null;
        wasEditing = !!active?.isContentEditable && el.contains(active);
        if (event.pointerType === "touch") {
          const interaction = event.interaction;
          pressTimer = setTimeout(() => startDrag(interaction), longPress);
        }
      })
      .on("move", (event: PointerLike) => {
        if (!downPoint || event.interaction.interacting()) return;
        if (event.interaction.prepared?.name === "resize") return;
        const distance = Math.hypot(event.clientX - downPoint.x, event.clientY - downPoint.y);
        if (event.pointerType === "touch") {
          // The finger moved before the long press: it's a scroll or a tap, not a drag.
          if (distance > 10) cancelPress();
        } else if (distance > 4 && !wasEditing) {
          startDrag(event.interaction);
        }
      })
      .on("up", cancelPress)
      .on("cancel", cancelPress)
      .draggable({
        manualStart: true,
        listeners: {
          start() {
            pos = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
            setSelected(el);
            el.classList.add("is-dragging");
          },
          move(event: { dx: number; dy: number }) {
            const scale = pageScale();
            pos.x += event.dx / scale;
            pos.y += event.dy / scale;
            el.style.left = `${Math.max(0, Math.round(pos.x / GRID) * GRID)}px`;
            el.style.top = `${Math.max(0, Math.round(pos.y / GRID) * GRID)}px`;
          },
          end() {
            endInteraction(el);
          },
        },
        modifiers: [interact.modifiers.restrictRect({ restriction: "parent" })],
      })
      .resizable({
        // A line is only 10px tall, so top and bottom edges would swallow every drag.
        edges: isLine ? { left: true, right: true } : { left: true, right: true, bottom: true, top: true },
        ignoreFrom: noDrag,
        listeners: {
          start() {
            cancelPress();
            setSelected(el);
          },
          move(event: { deltaRect: { left: number; top: number }; rect: { width: number; height: number } }) {
            const scale = pageScale();
            Object.assign(el.style, {
              left: `${(parseFloat(el.style.left) || 0) + event.deltaRect.left / scale}px`,
              top: `${(parseFloat(el.style.top) || 0) + event.deltaRect.top / scale}px`,
              width: `${event.rect.width / scale}px`,
            });
            if (!isLine) el.style.height = `${event.rect.height / scale}px`;
          },
          end() {
            endInteraction(el);
          },
        },
        modifiers: [
          interact.modifiers.restrictEdges({ outer: "parent" }),
          interact.modifiers.restrictSize({ min: { width: 40, height: 10 } }),
        ],
      });
  }

  function reinitializeElements() {
    page.querySelectorAll<HTMLElement>(".invoice-element").forEach((el) => {
      el.classList.remove("selected", "is-dragging");
      ensureControls(el);
      makeInteractable(el);
      if (el.querySelector('input[type="file"]')) {
        el.classList.add("image-element");
        setupImageUpload(el);
      }
    });
  }

  /** New ids stay ahead of every id already on the page. */
  function syncElementCounter() {
    page.querySelectorAll(".invoice-element").forEach((el) => {
      const n = parseInt(el.id.replace("invoice-element-", ""), 10);
      if (n > elementCounter) elementCounter = n;
    });
  }

  // --- Fitting the page to the screen --------------------------------------------------------------------

  /** Shrink the page to fit narrow screens; below MIN_PAGE_SCALE the wrapper scrolls sideways instead. */
  function fitPage() {
    if (!wrapper) return;
    const style = getComputedStyle(wrapper);
    const available = wrapper.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const full = page.offsetWidth;
    if (!full || available <= 0) return;
    const scale = Math.min(1, Math.max(available / full, MIN_PAGE_SCALE));
    Object.assign(page.style, {
      transformOrigin: "top left",
      transform: scale < 1 ? `scale(${scale})` : "",
      // A transform doesn't shrink the layout box; pull the leftover space back in.
      marginRight: scale < 1 ? `${-full * (1 - scale)}px` : "",
      marginBottom: scale < 1 ? `${-page.offsetHeight * (1 - scale)}px` : "",
    });
    wrapper.style.justifyContent = full * scale > available ? "flex-start" : "center";
  }

  // --- Listeners -----------------------------------------------------------------------------------------

  function onPageMouseDown(e: MouseEvent) {
    // Keep the text selection (and focus) alive when a control is pressed.
    if ((e.target as Element).closest(".element-control-icon")) e.preventDefault();
  }

  function onPageClick(e: MouseEvent) {
    // The click that ends a drag or resize isn't a real click.
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>(".invoice-element");
    setSelected(el);
    if (!el) return;
    if (target.closest(".card-style-cycler-icon")) cycleCardStyle(el);
    else if (target.closest(".delete-element-icon")) deleteBlock(el);
    else if (target.closest(".add-row-btn")) addTableRow(el);
    else if (target.closest(".font-cycler-icon")) cycleFont(el);
    else if (target.closest(".font-size-cycler-icon")) cycleFontSize(el);
    else if (target.closest(".line-style-cycler-icon")) cycleLineStyle(el);
    else if (el.classList.contains("image-element") && target.tagName !== "INPUT") {
      el.querySelector<HTMLInputElement>('input[type="file"]')?.click();
    }
  }

  function onWrapperClick(e: MouseEvent) {
    // Clicking the grey area around the page deselects, as clicking the page itself does.
    if (e.target === e.currentTarget) setSelected(null);
  }

  /** Only keys pressed on the page itself, or with nothing in particular focused, belong to the editor. */
  function ownsKey(e: KeyboardEvent) {
    const target = e.target as Node;
    return target === document.body || page.contains(target);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!ownsKey(e)) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
      return;
    }
    const selected = page.querySelector<HTMLElement>(".invoice-element.selected");
    const target = e.target as HTMLElement;
    const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    if (!selected || typing) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteBlock(selected);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      nudge(selected, e.key);
    }
  }

  /** While text is selected in a block, it gets a "Font" control. */
  function onSelectionChange() {
    const selection = window.getSelection();
    const active = document.activeElement as HTMLElement | null;
    const has = !!selection && selection.rangeCount > 0 && !selection.isCollapsed && !!active?.isContentEditable;
    const owner = has && active && page.contains(active) ? active.closest(".invoice-element") : null;
    page.querySelectorAll(".font-cycler-icon").forEach((icon) => {
      if (icon.parentElement?.parentElement !== owner) icon.remove();
    });
    const bar = owner?.querySelector(":scope > .element-controls");
    if (bar && !bar.querySelector(".font-cycler-icon")) {
      bar.insertAdjacentHTML("afterbegin", control("font-cycler-icon", "Font", "Change the font"));
    }
  }

  /** Pasting brings in plain text only, so nothing from another page (scripts, images, links) lands on this one. */
  function onPaste(e: ClipboardEvent) {
    if (!(e.target as HTMLElement).isContentEditable) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    document.execCommand("insertText", false, text);
  }

  function onDrop(e: DragEvent) {
    // Dropped content would bypass the paste rule above; images go in through an image block.
    e.preventDefault();
  }

  function saveIfPending() {
    flushPendingRecord();
    saveNow(true);
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") saveIfPending();
  }

  page.addEventListener("mousedown", onPageMouseDown);
  page.addEventListener("click", onPageClick);
  page.addEventListener("input", scheduleRecord);
  page.addEventListener("paste", onPaste);
  page.addEventListener("drop", onDrop);
  wrapper?.addEventListener("click", onWrapperClick);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", fitPage);
  // Don't lose the last couple of seconds of edits when the tab is closed.
  window.addEventListener("pagehide", saveIfPending);

  // --- Start ---------------------------------------------------------------------------------------------

  const initial = host.initialHtml && host.initialHtml.trim() !== "" ? sanitizeInvoiceHtml(host.initialHtml) : null;
  replacePage(initial ?? sampleInvoice(new Date()));
  syncElementCounter();
  undoStack = [pageState()];
  // Nothing to save until it changes: the draft is already saved, and the sample needn't be.
  lastSaved = undoStack[0]!;
  reportHistory();
  host.onSaveState("saved");
  fitPage();

  return {
    add: addBlock,
    undo,
    redo,
    html: () => {
      flushPendingRecord();
      return pageState();
    },

    replace(html) {
      flushPendingRecord();
      replacePage(sanitizeInvoiceHtml(html));
      syncElementCounter();
      recordState();
      autoSave();
    },

    async exportPdf() {
      flushPendingRecord();
      (document.activeElement as HTMLElement | null)?.blur?.();
      setSelected(null);
      page.classList.add("exporting");
      // Render at full size, whatever the screen's scaling.
      const { transform } = page.style;
      page.style.transform = "";
      try {
        // Loaded only when needed: together they're most of the invoice maker's size.
        const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas-pro")]);
        await document.fonts?.ready;
        const shot = await html2canvas(page, { scale: 3, useCORS: true });
        const pdf = new jsPDF({ orientation: "p", unit: "pt", format: "a4", compress: true });
        const width = pdf.internal.pageSize.getWidth();
        const height = (shot.height * width) / shot.width;
        // JPEG keeps the file to a few hundred KB; a PNG of the page can run to tens of MB.
        pdf.addImage(shot.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, width, height);
        pdf.save("invoice.pdf");
      } catch {
        host.notify("Sorry, the PDF couldn't be made. Try again, or use your browser's Print to save a PDF.", "warn");
      } finally {
        page.classList.remove("exporting");
        page.style.transform = transform;
      }
    },

    destroy() {
      if (destroyed) return;
      saveIfPending();
      destroyed = true;
      page.removeEventListener("mousedown", onPageMouseDown);
      page.removeEventListener("click", onPageClick);
      page.removeEventListener("input", scheduleRecord);
      page.removeEventListener("paste", onPaste);
      page.removeEventListener("drop", onDrop);
      wrapper?.removeEventListener("click", onWrapperClick);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", fitPage);
      window.removeEventListener("pagehide", saveIfPending);
      page.querySelectorAll<HTMLElement>(".invoice-element").forEach((el) => interact(el).unset());
    },
  };
}
