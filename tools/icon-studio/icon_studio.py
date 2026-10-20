import base64, copy, io, json, mimetypes, os, random, re, threading, unicodedata, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
try:
    from PIL import Image, ImageDraw
except ImportError:
    print('PIL is missing. Please run: pip install Pillow')
    exit(1)

PORT = 8081
REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB_DIR = os.path.join(REPO_DIR, 'apps', 'web')
# Saved images go in apps/web/public/icons, which Vite and the acct server serve at /icons/. A registry
# image value is the path below the site root ("icons/nav_clients_1_icon.png").
PUBLIC_DIR = os.path.join(WEB_DIR, 'public')
ICONS_DIR = os.path.join(PUBLIC_DIR, 'icons')
# The icon registry: slot ("group.name") -> the icon it shows. apps/web/src/lib/icons.tsx reads it.
REGISTRY_FILE = os.path.join(WEB_DIR, 'src', 'icons', 'registry.json')
REGISTRY_LOCK = threading.Lock()
KEY_RE = re.compile(r'^[a-z0-9_]+\.[a-z0-9_]+$')

# Optional key from https://enter.pollinations.ai: no watermark, better models and 4 images at a time.
# Without one, Pollinations allows one queued image per IP (roughly 10-40 s each) and stamps its logo.
POLLINATIONS_KEY = os.environ.get('POLLINATIONS_KEY', '').strip()
POLLINATIONS_MODEL = os.environ.get('POLLINATIONS_MODEL', 'zimage')
PROMPT_SUFFIX = ', app icon, single centered object with empty space around it, flat modern style, plain solid white background, no text'
GEN_SIZE = 512
ICON_SIZE = 256
CANDIDATES = 16
MAX_PICK = 4

# "Find emoji" scans these for emoji the UI shows. An image saved for one goes in the registry's
# "emoji" group (emoji.1f4ac for 💬), and the <Emoji> component swaps it in.
SCAN_DIRS = ['apps/web/src']
SCAN_EXTS = ('.tsx', '.ts', '.css', '.html')
SCAN_SKIP_DIRS = {'node_modules', 'dist', 'build', '.git'}
# Colour-emoji characters (Emoji_Presentation) below U+10000; other symbols there (✕ ▾ ⚙) are
# plain text glyphs unless U+FE0F follows them.
_EMOJI_BMP = '⌚⌛⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕'
_TEXT_SYMBOLS = '©®‼⁉™ℹ↔-⇿⌀-⏿Ⓜ■-◿☀-➿⤀-⥿⬀-⯿〰〽㊗㊙'
_EMOJI_ATOM = f'(?:[\U0001F000-\U0001FAFF{_EMOJI_BMP}]️?|[{_TEXT_SYMBOLS}]️)[\U0001F3FB-\U0001F3FF]?'
EMOJI_RE = re.compile(f'[\U0001F1E6-\U0001F1FF]{{2}}|[0-9#*]️?⃣|{_EMOJI_ATOM}(?:‍{_EMOJI_ATOM})*')
# Lines the user never sees: logging and comments.
SCAN_SKIP_LINE = re.compile(r'^\s*(//|/\*|\*|<!--)|console\.\w+\(|\b(e?println|print|info|warn|error|debug|trace)!\(|log::\w+!|\bLog\.[dewiv]\(')

HTML_DASHBOARD = """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>acct Icon Studio</title>
    <style>
        body { margin: 0; padding: 20px; background: #12121e; color: #fff; font-family: 'Segoe UI', sans-serif; display: flex; gap: 20px; height: 100vh; box-sizing: border-box; }
        h2 { margin: 0; font-size: 18px; color: #8ab4f8; }
        h3 { margin: 18px 0 8px; font-size: 12px; color: #8ab4f8; text-transform: uppercase; letter-spacing: 0.08em; }
        h3:first-child { margin-top: 0; }
        .panel { background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 15px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
        .left { flex: 0 0 400px; }
        .right { flex: 1; }
        .right-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 5px; }
        .right-head .hint { flex: 1; text-align: right; }
        .right-head button { width: auto; padding: 6px 12px; }
        input, textarea { background: #09090f; border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 8px; border-radius: 4px; font-family: inherit; width: 100%; box-sizing: border-box; outline: none; }
        input:focus, textarea:focus { border-color: #8ab4f8; }
        button { background: #0078d7; border: none; color: white; padding: 8px 15px; border-radius: 4px; cursor: pointer; font-weight: bold; width: 100%; transition: 0.2s; font-family: inherit; }
        button:hover { background: #0086f0; }
        button.secondary { background: #3a3a4e; flex: 0 0 90px; }
        button.save { background: #28a745; }
        button.save:hover { background: #2fbf50; }
        button:disabled, button:disabled:hover { background: #2a2a3a; color: #777; cursor: default; }
        .row { display: flex; gap: 8px; }
        .hint { font-size: 11px; color: #aaa; }
        .check { font-size: 12px; color: #ccc; display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .check input { width: auto; }
        .status { font-size: 12px; color: #28a745; text-align: center; min-height: 15px; font-weight: bold; }
        .status.error { color: #ff6b6b; }

        .slot-row { display: flex; gap: 8px; align-items: center; }
        .slot-preview { flex: 0 0 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-size: 26px; background: rgba(255,255,255,0.04); border-radius: 6px; }
        .slot-preview img { width: 30px; height: 30px; object-fit: contain; }
        .slot-preview .new { font-size: 10px; color: #8ab4f8; }
        .places { flex: 0 0 auto; max-height: 170px; overflow-y: auto; font-size: 11px; color: #aaa; background: rgba(0,0,0,0.25); border-radius: 4px; padding: 6px 8px; }
        .places[hidden], .swap-row[hidden] { display: none; }
        .places label { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
        .places label:hover { color: #fff; }
        .places input { width: auto; margin: 0 6px 0 0; vertical-align: middle; }
        .places b { color: #8ab4f8; font-weight: normal; }
        .swap-row button { flex: 0 0 140px; }

        /* Checkerboard so transparent backgrounds are visible. */
        .checker { background-color: #2a2a38; background-image: linear-gradient(45deg, #353545 25%, transparent 25%, transparent 75%, #353545 75%), linear-gradient(45deg, #353545 25%, transparent 25%, transparent 75%, #353545 75%); background-size: 12px 12px; background-position: 0 0, 6px 6px; }
        body.dropping .candidates { outline: 2px dashed #8ab4f8; outline-offset: 4px; min-height: 80px; border-radius: 8px; }
        .candidates { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .candidate { position: relative; aspect-ratio: 1; border-radius: 8px; border: 2px solid transparent; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .candidate img { width: 100%; height: 100%; object-fit: contain; }
        .candidate.ready { cursor: pointer; }
        .candidate.ready:hover { border-color: rgba(138,180,248,0.5); }
        .candidate.waiting { opacity: 0.35; }
        .candidate.loading { animation: pulse 1.2s ease-in-out infinite; }
        .candidate.failed { color: #ff6b6b; font-size: 20px; }
        .candidate.saved { opacity: 0.35; cursor: default; }
        .candidate.picked { border-color: #28a745; }
        .candidate.picked::after { content: attr(data-pick); position: absolute; top: 4px; left: 4px; width: 18px; height: 18px; border-radius: 50%; background: #28a745; font-size: 11px; font-weight: bold; display: flex; align-items: center; justify-content: center; }
        @keyframes pulse { 50% { opacity: 0.55; } }

        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 12px; }
        .icon-card { position: relative; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 10px; text-align: center; cursor: pointer; transition: all 0.2s; }
        .icon-card:hover { background: rgba(255,255,255,0.08); border-color: #8ab4f8; }
        .icon-card.targeted { border-color: #28a745; background: rgba(40,167,69,0.08); }
        .icon-card img, .icon-card .emoji { width: 56px; height: 56px; object-fit: contain; margin: 0 auto 8px; display: block; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.5)); }
        .icon-card .emoji { font-size: 44px; line-height: 56px; }
        .icon-card .label { display: block; font-size: 11px; word-break: break-all; color: #aaa; }
        .icon-card .label.words { word-break: normal; overflow-wrap: anywhere; }
        .icon-card .sub { display: block; font-size: 10px; color: #777; margin-top: 2px; }
        .needs-hint { margin: -2px 0 10px; }
        .keep-btn { position: absolute; top: 4px; right: 4px; width: auto; padding: 2px 6px; font-size: 10px; background: rgba(0,0,0,0.6); opacity: 0; }
        .icon-card:hover .keep-btn, .keep-btn:focus-visible { opacity: 1; }
        @media (hover: none) { .keep-btn { opacity: 1; } }
        .variant-arrow { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; border-radius: 4px; background: rgba(0,0,0,0.6); font-size: 13px; line-height: 22px; opacity: 0; }
        .icon-card:hover .variant-arrow, .variant-arrow:focus-visible, .variant-arrow.open { opacity: 1; }
        @media (hover: none) { .variant-arrow { opacity: 1; } }

        .variant-menu { position: fixed; z-index: 10; display: flex; flex-wrap: wrap; gap: 6px; max-width: 290px; padding: 8px; background: #1c1c2c; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
        .variant-menu[hidden] { display: none; }
        .variant { width: 64px; height: 64px; padding: 6px; border-radius: 6px; border: 2px solid transparent; display: flex; align-items: center; justify-content: center; }
        .variant:hover { border-color: #8ab4f8; background-color: #2a2a38; }
        .variant.active { border-color: #28a745; }
        .variant img { width: 100%; height: 100%; object-fit: contain; }
        .variant .emoji { font-size: 34px; }


        .edit-btn { position: absolute; bottom: 4px; right: 4px; width: auto; padding: 2px 6px; font-size: 10px; background: rgba(0,0,0,0.8); opacity: 0; z-index: 2; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; cursor: pointer; }
        .candidate:hover .edit-btn { opacity: 1; }
        .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 100; display: flex; align-items: center; justify-content: center; }
        .modal[hidden] { display: none; }
        .modal-content { background: #1c1c2c; padding: 16px 20px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); max-width: 96vw; max-height: 98vh; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; }
        .canvas-container { overflow: auto; border: 1px solid #444; width: min(92vw, 1100px); height: max(300px, calc(100vh - 300px)); display: flex; cursor: crosshair; }
        .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .toolbar button { width: auto; }
        .toolbar button.active { background: #8ab4f8; color: #000; }
        .toolbar input[type=range] { width: 100px; padding: 0; vertical-align: middle; }
        .toolbar input.num { width: 58px; padding: 3px 4px; margin: 0 3px 0 4px; font-size: 11px; }
        .toolbar input[type=color] { width: 36px; height: 30px; padding: 2px; cursor: pointer; }
        .tool-opts { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-height: 32px; }
        .tool-opts[hidden] { display: none; }
        .tool-opts button { padding: 6px 12px; background: #3a3a4e; }
        .tool-opts button:hover { background: #4a4a60; }
        .canvas-stack { position: relative; line-height: 0; margin: auto; flex: none; overflow: hidden; }
        #edit-canvas { height: auto; }
        .canvas-stack.pixels canvas { image-rendering: pixelated; }
        #edit-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
        #tool-hint { max-width: min(92vw, 1100px); }

        .usage-arrow { width: 16px; height: 16px; padding: 0; margin-left: 4px; border-radius: 3px; background: rgba(255,255,255,0.1); color: #ccc; font-size: 10px; line-height: 16px; vertical-align: middle; }
        .usage-arrow:hover, .usage-arrow.open { background: #8ab4f8; color: #000; }
        .usage-menu { position: fixed; z-index: 10; width: min(560px, 90vw); max-height: 60vh; overflow-y: auto; padding: 10px; background: #1c1c2c; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); font-size: 12px; color: #ccc; box-sizing: border-box; }
        .usage-menu[hidden] { display: none; }
        .usage { margin-top: 10px; }
        .usage-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
        .usage-head b { flex: 1; color: #8ab4f8; font-weight: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .usage-head button { width: auto; padding: 2px 10px; font-size: 11px; }
        .usage-code { font-family: Consolas, 'DejaVu Sans Mono', monospace; font-size: 11px; background: rgba(0,0,0,0.35); border-radius: 4px; padding: 4px 6px; color: #888; }
        .usage-code div { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
        .usage-code .hit { color: #fff; }
        .icon-card.merge-target { border-color: #f0b429; background: rgba(240,180,41,0.12); }
        .merge-choices { display: flex; gap: 12px; }
        .merge-choice { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 14px; border: 2px solid transparent; font-weight: normal; font-size: 12px; }
        .merge-choice:hover { border-color: #28a745; background-color: #2a2a38; }
        .merge-choice img, .merge-choice .emoji { width: 72px; height: 72px; object-fit: contain; font-size: 56px; line-height: 72px; }
        #merge-text { max-width: 440px; font-size: 13px; color: #ccc; }

        .preview-pane { border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
        .preview-pane h3 { margin: 0 0 2px; font-size: 12px; color: #8ab4f8; text-transform: uppercase; letter-spacing: 0.08em; }
        .mini-toolbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .mini-toolbar button { width: auto; padding: 4px 9px; font-size: 11px; }
        .preview-wrap { border-radius: 6px; min-height: 100px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .preview-wrap img { max-width: 100%; max-height: 200px; object-fit: contain; border-radius: 4px; cursor: pointer; }
        .preview-empty { color: #555; font-size: 12px; text-align: center; }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: #12121e; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 4px; }
    </style>
</head>
<body>
    <div class="panel left">
        <h2>🎨 Icon Generator</h2>
        <div class="slot-row">
            <div class="slot-preview" id="slot-preview"></div>
            <input id="slot" list="slot-list" placeholder="Icon slot, e.g. nav.clients" autocomplete="off">
            <datalist id="slot-list"></datalist>
        </div>
        <div class="places" id="places" hidden></div>
        <div class="row swap-row" id="swap-row" hidden>
            <input id="swap-to" list="swap-list" placeholder="Emoji for the ticked places, e.g. 🎧" autocomplete="off">
            <datalist id="swap-list"></datalist>
            <button id="swap-btn" onclick="swapPlaces()" disabled>Change ticked</button>
        </div>
        <textarea id="prompt" rows="3" placeholder="Describe the icon (e.g. 'a stack of ledger books')"></textarea>
        <label class="check"><input type="checkbox" id="remove-bg" checked> Remove background</label>
        <div class="row">
            <button id="gen-btn" onclick="generate()">Generate 16</button>
            <button id="stop-btn" class="secondary" onclick="stopRun()" disabled>Stop</button>
        </div>
        <div class="hint" id="progress"></div>
        <div class="candidates" id="candidates"></div>
        <div class="hint">Or drag and drop image files here to use your own icons.</div>
        <div class="hint">Click up to 4 icons to keep. The first one you pick becomes the slot's icon; all of them go in the slot's ▾ list so you can swap later.</div>
        <div class="row">
            <button id="save-btn" class="save" onclick="saveSelected()" disabled>Save selected</button>
            <button class="secondary" title="Unpick the icons and the slot, so nothing is selected" onclick="clearPicks()">Clear</button>
        </div>
        <div class="status" id="status"></div>
        <div class="preview-pane" id="preview-pane">
            <h3>Selected Icon</h3>
            <div class="mini-toolbar">
                <button id="mt-wand" title="Select areas to erase or recolor" onclick="openPreviewInEditor('wand')" disabled>🪄 Wand</button>
                <button id="mt-rect" title="Select a rectangle by dragging a box" onclick="openPreviewInEditor('rect')" disabled>⬚ Rect</button>
                <button id="mt-shape" title="Select an area by dropping points around it" onclick="openPreviewInEditor('shape')" disabled>📐 Shape</button>
                <button id="mt-crop" title="Crop to a region" onclick="openPreviewInEditor('crop')" disabled>✂️ Crop</button>
                <button id="mt-scale" title="Make the icon bigger or smaller" onclick="openPreviewInEditor('scale')" disabled>🔍 Scale</button>
                <button id="mt-stretch" title="Make the icon wider or taller" onclick="openPreviewInEditor('stretch')" disabled>↔️ Stretch</button>
                <button id="mt-move" title="Shift the icon inside its square" onclick="openPreviewInEditor('move')" disabled>✋ Move</button>
                <button id="mt-rotate" title="Turn the icon or a part of it" onclick="openPreviewInEditor('rotate')" disabled>🔄 Rotate</button>
                <button id="mt-sharpen" title="Sharpen the icon a little" onclick="openPreviewInEditor('sharpen')" disabled>✨ Sharpen</button>
                <button id="mt-recolor" title="Change the icon's colours" onclick="openPreviewInEditor('recolor')" disabled>🎨 Recolor</button>
            </div>
            <div class="preview-wrap checker" id="preview-wrap">
                <span class="preview-empty">Select a slot or pick a candidate</span>
            </div>
        </div>
    </div>

    <div class="panel right" id="registry-panel">
        <div class="right-head">
            <h2>📁 Icon Registry</h2>
            <button id="scan-btn" onclick="scanEmoji()">🔍 Find emoji to replace</button>
            <span class="hint">Click a slot to make icons for it. Hover and click ▾ to swap between its saved icons. The ▾ by a name lists where the code uses it. Drag one icon onto another to merge them.</span>
        </div>
        <div id="groups"></div>
    </div>

    <div class="variant-menu" id="variant-menu" hidden></div>
    <div class="usage-menu" id="usage-menu" hidden></div>

    <div id="merge-modal" class="modal" hidden>
        <div class="modal-content">
            <h3>Merge icons</h3>
            <div id="merge-text"></div>
            <div class="merge-choices" id="merge-choices"></div>
            <button class="secondary" id="merge-cancel" style="flex: none;">Cancel</button>
        </div>
    </div>


    <div id="editor-modal" class="modal" hidden>
        <div class="modal-content">
            <h3>🖌️ Edit Icon</h3>
            <div class="toolbar">
                <button id="tool-wand" class="active" data-tool="wand" title="Select areas by colour, to erase, recolor or move">🪄 Wand</button>
                <button id="tool-rect" data-tool="rect" title="Select a rectangle by dragging a box">⬚ Rect</button>
                <button id="tool-shape" data-tool="shape" title="Select an area by dropping points around it">📐 Shape</button>
                <button id="tool-crop" data-tool="crop" title="Drag a box around the part to keep">✂️ Crop</button>
                <button id="tool-scale" data-tool="scale" title="Make the icon bigger or smaller inside its square">🔍 Scale</button>
                <button id="tool-stretch" data-tool="stretch" title="Make the icon wider or taller">↔️ Stretch</button>
                <button id="tool-move" data-tool="move" title="Shift the icon inside its square">✋ Move</button>
                <button id="tool-rotate" data-tool="rotate" title="Turn the selected area, or the whole icon">🔄 Rotate</button>
                <button id="tool-sharpen" data-tool="sharpen" title="Click the icon to sharpen it a little">✨ Sharpen</button>
                <button id="tool-recolor" data-tool="recolor" title="Change the icon's colours">🎨 Recolor</button>
                <label class="hint" style="margin-left:auto;" title="Or turn the mouse wheel over the icon">Zoom <input type="range" id="edit-zoom" min="100" max="1600" step="25" value="100"><input type="number" class="num" min="100" max="1600" value="100">%</label>
                <button class="secondary" title="Copy the selected area, or the whole icon (Ctrl+C)" onclick="copySelection()">Copy</button>
                <button id="edit-paste" class="secondary" title="Paste on top of the icon, to drag into place (Ctrl+V)" onclick="pasteClip()" disabled>Paste</button>
                <button id="edit-undo" class="secondary" title="Undo (Ctrl+Z)" onclick="undoEdit()" disabled>↶ Undo</button>
            </div>
            <div class="toolbar">
                <div class="tool-opts" data-for="wand rect shape">
                    <label class="hint" id="tolerance-opt">Tolerance <input type="range" id="wand-tolerance" min="0" max="100" value="10"><input type="number" class="num" min="0" max="100" value="10">%</label>
                    <label class="hint">Feather <input type="range" id="wand-feather" min="0" max="12" value="0"><input type="number" class="num" min="0" max="12" value="0">px</label>
                    <button data-needs-sel title="Erase the selected area (Del)" onclick="eraseSelection()">Erase</button>
                    <button data-needs-sel title="Change the colour of the selected area" onclick="setTool('recolor')">Recolor…</button>
                    <button data-needs-sel title="Drag the selected area somewhere else" onclick="setTool('move')">Move…</button>
                    <button data-needs-sel title="Turn the selected area" onclick="setTool('rotate')">Rotate…</button>
                    <button title="Select everything that is not selected" onclick="invertSelection()">Invert</button>
                    <button data-needs-sel title="Drop the selection (Esc)" onclick="deselect()">Deselect</button>
                </div>
                <div class="tool-opts" data-for="crop" hidden></div>
                <div class="tool-opts" data-for="scale" hidden>
                    <label class="hint">Size <input type="range" id="scale-amount" min="20" max="300" value="100" data-reset="100"><input type="number" class="num" min="1" max="1000" value="100">%</label>
                    <label class="hint" title="How wide the icon itself is, without the empty space around it">= <input type="number" class="num" id="scale-px" min="1"> px wide</label>
                </div>
                <div class="tool-opts" data-for="stretch" hidden>
                    <label class="hint">Width <input type="range" id="stretch-w" min="20" max="300" value="100" data-reset="100"><input type="number" class="num" min="1" max="1000" value="100">% = <input type="number" class="num" id="stretch-w-px" min="1"> px</label>
                    <label class="hint">Height <input type="range" id="stretch-h" min="20" max="300" value="100" data-reset="100"><input type="number" class="num" min="1" max="1000" value="100">% = <input type="number" class="num" id="stretch-h-px" min="1"> px</label>
                </div>
                <div class="tool-opts" data-for="move" hidden>
                    <button title="Left 1 px" onclick="nudge(-1, 0)">←</button>
                    <button title="Right 1 px" onclick="nudge(1, 0)">→</button>
                    <button title="Up 1 px" onclick="nudge(0, -1)">↑</button>
                    <button title="Down 1 px" onclick="nudge(0, 1)">↓</button>
                    <button title="Put the icon (or the selected area) in the middle of the square" onclick="centreIcon()">Centre</button>
                </div>
                <div class="tool-opts" data-for="rotate" hidden>
                    <label class="hint">Angle <input type="range" id="rotate-angle" min="-180" max="180" value="0" data-reset="0"><input type="number" class="num" min="-180" max="180" value="0">°</label>
                    <button title="A quarter turn to the left" onclick="rotateQuarter(-1)">⟲ 90°</button>
                    <button title="A quarter turn to the right" onclick="rotateQuarter(1)">⟳ 90°</button>
                </div>
                <div class="tool-opts" data-for="sharpen" hidden></div>
                <div class="tool-opts" data-for="recolor" hidden>
                    <input type="color" id="recolor-colour" value="#3b82f6" title="Colour to fill with">
                    <button title="Give the icon this colour, keeping its shading" onclick="fillColour()">Fill</button>
                    <label class="hint">Hue <input type="range" id="recolor-hue" min="-180" max="180" value="0" data-reset="0"><input type="number" class="num" min="-180" max="180" value="0">°</label>
                    <label class="hint">Saturation <input type="range" id="recolor-sat" min="-100" max="100" value="0" data-reset="0"><input type="number" class="num" min="-100" max="100" value="0">%</label>
                    <label class="hint">Brightness <input type="range" id="recolor-bright" min="-100" max="100" value="0" data-reset="0"><input type="number" class="num" min="-100" max="100" value="0">%</label>
                </div>
            </div>
            <div class="hint" id="tool-hint"></div>
            <div class="canvas-container checker" id="canvas-container">
                <div class="canvas-stack" id="canvas-stack">
                    <canvas id="edit-canvas"></canvas>
                    <canvas id="edit-overlay"></canvas>
                </div>
            </div>
            <div class="row">
                <button class="save" id="edit-apply" onclick="saveEdit()">Apply Changes</button>
                <button class="secondary" onclick="closeEditor()">Cancel</button>
            </div>
        </div>
    </div>
    <script>
        const CANDIDATES = %CANDIDATES%, MAX_PICK = %MAX_PICK%;
        const KEY_RE = /^[a-z0-9_]+\\.[a-z0-9_]+$/;
        const SLOT_DRAG = 'application/x-acct-icon-slot';
        const $ = id => document.getElementById(id);
        let registry = {};
        let labels = {};       // "emoji.1f4ac" -> "💬 speech balloon"
        let scan = null;       // emoji found by "Find emoji": { key, emoji, name, places: [[file, line, text]] }
        let ticked = { key: null, places: new Set() }; // places ticked for the targeted emoji, as "file:line"
        let keyed = false;
        let autoPrompt = false; // the prompt was filled in from the slot, not typed
        let run = null;        // the generation in progress: { stopped, controllers }
        let candidates = [];   // { el, image, saved } per tile
        let picked = [];       // candidate indexes, in pick order


        // What the editor has open: { type: 'candidate', index } or { type: 'slot', key }. null when closed.
        let editing = null;
        const canvas = document.getElementById('edit-canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // The left-panel preview: the first picked candidate, or else the targeted slot's own image.
        let previewSrc = null; // { type: 'candidate', index, imageSrc } or { type: 'slot', key, imageSrc }

        function updatePreview() {
            const key = $('slot').value.trim();
            const entry = KEY_RE.test(key) && slotEntry(key);
            if (picked.length) previewSrc = { type: 'candidate', index: picked[0], imageSrc: candidates[picked[0]].image };
            else if (entry && entry.type === 'image' && entry.value) previewSrc = { type: 'slot', key, imageSrc: iconEl(entry).src };
            else previewSrc = null;
            const wrap = $('preview-wrap');
            wrap.innerHTML = '';
            if (previewSrc) {
                const img = document.createElement('img');
                img.src = previewSrc.imageSrc;
                img.title = 'Click to edit';
                img.onclick = () => openPreviewInEditor('wand');
                wrap.appendChild(img);
            } else {
                wrap.innerHTML = '<span class="preview-empty">Select a slot or pick a candidate</span>';
            }
            document.querySelectorAll('.mini-toolbar button').forEach(b => { b.disabled = !previewSrc; });
        }

        window.openPreviewInEditor = function(toolName) {
            if (!previewSrc) return;
            const target = previewSrc.type === 'candidate' ? { type: 'candidate', index: previewSrc.index } : { type: 'slot', key: previewSrc.key };
            startEdit(target, previewSrc.imageSrc, toolName);
        };

        // Editor tools. The wand selects areas (to erase or recolor), crop keeps a dragged box, scale
        // and stretch resize around the centre, move shifts the icon, sharpen and recolor change its
        // pixels (only the wand's selection, when there is one). Every change can be undone.
        const TOOL_HINTS = {
            wand: 'Click an area to select it. Hold and drag to add what you drag over, Ctrl+click to add areas that do not touch. Then Erase (Del), Recolor or Move it. Feather softens the edge of what you erase, recolor or move.',
            rect: 'Drag a box to select it. Hold Ctrl to add to the selection there is. Then Erase (Del), Recolor, Move or Rotate it.',
            rotate: 'Move the Angle slider or use the quarter-turn buttons. With a selection, only the selected area turns.',
            shape: 'Click to drop points around an area. Double-click, press Enter or click the first point to close the shape (Backspace removes the last point). Hold Ctrl on the first point to add to the selection there is. Then Erase (Del), Recolor or Move it.',
            crop: 'Drag a box around the part to keep. It is fitted back into the square.',
            scale: 'Move the Size slider, or type a percentage or the width in pixels. Below 100% adds a margin, above 100% zooms in. [ and ] step the slider (with Shift, 10 at a time).',
            stretch: 'Move the Width and Height sliders, or type a percentage or a size in pixels. [ and ] step the slider used last.',
            move: 'Drag the icon to where it should sit. With a selection, only the selected area moves. The arrow buttons and arrow keys move it 1 px (10 px with Shift).',
            sharpen: 'Click the icon to sharpen it a little. Click again for more.',
            recolor: 'Fill gives the icon one colour and keeps its shading. The sliders shift the colours it has. With a selection, only the selected area changes.',
        };
        const TOOL_CURSORS = { wand: 'crosshair', shape: 'crosshair', rect: 'crosshair', crop: 'crosshair', move: 'move', sharpen: 'pointer' };
        const KEEPS_SELECTION = ['wand', 'rect', 'shape', 'move', 'rotate', 'sharpen', 'recolor'];
        const overlay = $('edit-overlay');
        const octx = overlay.getContext('2d');
        let tool = 'wand';
        let history = [];       // { img, sel } before each change
        let zoom = 1;
        let poly = null;        // the shape being drawn: { points: [[x,y]], add, cursor }
        let rectStart = null;   // the Rect tool's drag: { x, y, add }
        let clip = null;        // what Copy took: a canvas the size of the icon it came from
        // A pasted piece that has not been let go yet: { rest: canvas (the icon under it), piece: canvas }.
        // While it floats, moving or turning it leaves the icon under it untouched.
        let floating = null;
        let lastSlider = null;  // the slider [ and ] step
        let baseBox = null;     // size of the icon itself (no empty space) before Scale or Stretch
        let live = null;        // what the sliders of scale, stretch and recolor work from: { canvas, img }
        // The wand's selection: { seeds: [pixel index], base: Uint8Array or null (kept from an Invert),
        // hard: Uint8Array (1 = selected), mask: Uint8Array (0-255, hard after feathering) }.
        let sel = null;
        let wandImg = null;     // the pixels the wand reads while the mouse button is down
        let moveStart = null, moveParts = null, moveBy = [0, 0];
        let cropStart = null, cropBox = null, cropSnap = null;

        document.querySelectorAll('.toolbar [data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
        // Every slider has a number box after it, to type an exact value. The tools read the box,
        // which for Scale and Stretch may go past the slider's range.
        const numOf = range => range.nextElementSibling;

        function val(id) {
            const n = numOf($(id));
            return Math.max(Number(n.min), Math.min(Number(n.max), Number(n.value) || 0));
        }

        function showValue(range) {
            numOf(range).value = range.value;
        }

        document.querySelectorAll('.toolbar input[type=range]').forEach(range => {
            range.addEventListener('input', e => {
                lastSlider = range;
                if (e.detail !== 'typed') showValue(range);
            });
            numOf(range).addEventListener('input', () => {
                if (numOf(range).value === '') return;
                range.value = numOf(range).value;
                range.dispatchEvent(new CustomEvent('input', { detail: 'typed' }));
            });
        });

        // [ and ] step the slider used last (or the tool's first one, or the zoom).
        function stepSlider(dir, big) {
            const shown = document.querySelector('.tool-opts:not([hidden]) label:not([hidden]) > input[type=range]');
            const range = lastSlider && lastSlider.offsetParent ? lastSlider : shown || $('edit-zoom');
            const n = numOf(range);
            n.value = val(range.id) + dir * (Number(range.step) || 1) * (big ? 10 : 1);
            n.value = val(range.id);
            n.dispatchEvent(new Event('input'));
        }

        // Scale and Stretch also show the icon's size in pixels, which can be typed.
        function contentBox() {
            if (!baseBox) {
                const d = (live ? live.img : ctx.getImageData(0, 0, canvas.width, canvas.height)).data, w = canvas.width;
                let x0 = w, y0 = canvas.height, x1 = -1, y1 = -1;
                for (let p = 3; p < d.length; p += 4) {
                    if (!d[p]) continue;
                    const x = (p >> 2) % w, y = Math.floor((p >> 2) / w);
                    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                }
                baseBox = { w: Math.max(0, x1 - x0 + 1), h: Math.max(0, y1 - y0 + 1) };
            }
            return baseBox;
        }

        const PX_BOXES = [['scale-px', 'scale-amount', 'w'], ['stretch-w-px', 'stretch-w', 'w'], ['stretch-h-px', 'stretch-h', 'h']];

        function showPx() {
            if (!editing || (tool !== 'scale' && tool !== 'stretch')) return;
            const size = contentBox();
            for (const [px, id, side] of PX_BOXES) {
                if (document.activeElement !== $(px)) $(px).value = Math.round(size[side] * val(id) / 100);
            }
        }

        PX_BOXES.forEach(([px, id, side]) => $(px).addEventListener('input', () => {
            const size = contentBox()[side];
            if (!size || $(px).value === '') return;
            const n = numOf($(id));
            n.value = Math.round($(px).value / size * 10000) / 100;
            n.dispatchEvent(new Event('input'));
        }));

        window.setTool = function(name) {
            endLive();
            tool = name;
            poly = lastSlider = null;
            if (!KEEPS_SELECTION.includes(name)) sel = floating = null;
            document.querySelectorAll('.toolbar [data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
            document.querySelectorAll('.tool-opts').forEach(o => { o.hidden = !o.dataset.for.split(' ').includes(name); });
            $('tolerance-opt').hidden = name !== 'wand';
            $('tool-hint').textContent = TOOL_HINTS[name];
            canvas.style.cursor = TOOL_CURSORS[name] || 'default';
            drawSelection();
            showPx();
        };

        function pushHistory() {
            const kept = sel && { ...sel, seeds: sel.seeds.slice(), hard: sel.hard.slice(), mask: sel.mask.slice() };
            history.push({ img: ctx.getImageData(0, 0, canvas.width, canvas.height), sel: kept, floating });
            if (history.length > 30) history.shift();
            $('edit-undo').disabled = false;
        }

        window.undoEdit = function() {
            const prev = history.pop();
            live = null;
            if (prev) {
                ctx.putImageData(prev.img, 0, 0);
                sel = prev.sel;
                floating = prev.floating;
                poly = null;
                drawSelection();
            }
            endLive();
            $('edit-undo').disabled = !history.length;
        };

        function copyCanvas() {
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            c.getContext('2d').drawImage(canvas, 0, 0);
            return c;
        }

        // Slider tools redraw from the picture as it was when the slider was first moved, so the whole
        // drag is one undo step.
        function beginLive() {
            if (live) return;
            pushHistory();
            live = { canvas: copyCanvas(), img: ctx.getImageData(0, 0, canvas.width, canvas.height) };
        }

        function endLive() {
            // A pasted piece that was turned stays afloat as it now looks.
            if (live && live.piece && floating) floating = { rest: floating.rest, piece: live.piece };
            live = baseBox = null;
            document.querySelectorAll('.toolbar input[data-reset]').forEach(i => { i.value = i.dataset.reset; showValue(i); });
            showPx();
        }

        function resizeLive(fx, fy) {
            if (!editing) return;
            floating = null;
            beginLive();
            const w = canvas.width * fx, h = canvas.height * fy;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(live.canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            showPx();
        }

        $('scale-amount').addEventListener('input', () => resizeLive(val('scale-amount') / 100, val('scale-amount') / 100));
        ['stretch-w', 'stretch-h'].forEach(id => $(id).addEventListener('input', () => resizeLive(val('stretch-w') / 100, val('stretch-h') / 100)));

        // Zoom: the icon is shown as large as the editor allows, times the zoom. The point under the
        // mouse (or the middle of the view) stays where it is.
        function setZoom(value, e) {
            const box = $('canvas-container'), view = box.getBoundingClientRect();
            const at = e ? [e.clientX, e.clientY] : [view.left + box.clientWidth / 2, view.top + box.clientHeight / 2];
            const before = canvas.getBoundingClientRect();
            const fx = (at[0] - before.left) / before.width, fy = (at[1] - before.top) / before.height;
            zoom = Math.max(1, Math.min(16, value));
            canvas.style.width = Math.round((Math.min(box.clientWidth, box.clientHeight) - 4) * zoom) + 'px';
            $('canvas-stack').classList.toggle('pixels', zoom >= 3);
            $('edit-zoom').value = Math.round(zoom * 100);
            if (document.activeElement !== numOf($('edit-zoom'))) showValue($('edit-zoom'));
            const after = canvas.getBoundingClientRect();
            box.scrollLeft += after.left + fx * after.width - at[0];
            box.scrollTop += after.top + fy * after.height - at[1];
        }

        $('edit-zoom').addEventListener('input', () => setZoom(val('edit-zoom') / 100));
        $('canvas-container').addEventListener('wheel', e => {
            e.preventDefault();
            setZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), e);
        }, { passive: false });
        window.addEventListener('resize', () => { if (editing) setZoom(zoom); });

        function canvasPoint(e) {
            const rect = canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) * canvas.width / rect.width);
            const y = Math.floor((e.clientY - rect.top) * canvas.height / rect.height);
            return [Math.max(0, Math.min(canvas.width, x)), Math.max(0, Math.min(canvas.height, y))];
        }

        // Wand: selects the area around a pixel whose colour is within the tolerance of it.
        function flood(seed) {
            const d = wandImg.data, w = canvas.width, n = w * canvas.height;
            const maxDiff = val('wand-tolerance') * 2.55;
            const s = seed * 4;
            const stack = [seed];
            const seen = new Uint8Array(n);
            while (stack.length) {
                const idx = stack.pop();
                if (seen[idx]) continue;
                seen[idx] = 1;
                const p = idx * 4;
                // A fully transparent pixel has no colour of its own, so only its transparency counts.
                const diff = !d[s + 3] || !d[p + 3] ? Math.abs(d[p + 3] - d[s + 3]) : Math.max(
                    Math.abs(d[p] - d[s]), Math.abs(d[p + 1] - d[s + 1]), Math.abs(d[p + 2] - d[s + 2]), Math.abs(d[p + 3] - d[s + 3]));
                if (diff > maxDiff) continue;
                sel.hard[idx] = 1;
                const x = idx % w;
                if (x > 0) stack.push(idx - 1);
                if (x + 1 < w) stack.push(idx + 1);
                if (idx >= w) stack.push(idx - w);
                if (idx + w < n) stack.push(idx + w);
            }
        }

        function addSeed(x, y) {
            const idx = y * canvas.width + x;
            if (sel.hard[idx]) return;
            sel.seeds.push(idx);
            flood(idx);
            featherSelection();
        }

        // Selects again from the same clicks, after the tolerance changed.
        function replayWand() {
            if (!sel || !sel.seeds.length) return;
            wandImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
            sel.hard = sel.base ? sel.base.slice() : new Uint8Array(canvas.width * canvas.height);
            for (const idx of sel.seeds) if (!sel.hard[idx]) flood(idx);
            wandImg = null;
            featherSelection();
        }

        function blurMask(mask, w, h, r) {
            let a = Float32Array.from(mask), b = new Float32Array(a.length);
            const span = 2 * r + 1;
            const pass = (step, count, lines) => {
                for (let line = 0; line < lines; line++) {
                    const at = i => (step === 1 ? line * w + i : i * w + line);
                    let sum = 0;
                    for (let i = -r; i <= r; i++) sum += a[at(Math.max(0, Math.min(count - 1, i)))];
                    for (let i = 0; i < count; i++) {
                        b[at(i)] = sum / span;
                        sum += a[at(Math.min(count - 1, i + r + 1))] - a[at(Math.max(0, i - r))];
                    }
                }
                [a, b] = [b, a];
            };
            for (let n = 0; n < 2; n++) { pass(1, w, h); pass(w, h, w); }
            return Uint8Array.from(a, v => Math.round(v));
        }

        function featherSelection() {
            const r = Math.round(val('wand-feather'));
            sel.mask = sel.hard.map(v => v * 255);
            if (r) sel.mask = blurMask(sel.mask, canvas.width, canvas.height, r);
            drawSelection();
        }

        // Draws the selection over the icon: a dashed outline, and a blue tint while selecting. The
        // shape being drawn goes on top.
        function drawSelection() {
            const w = overlay.width = canvas.width, h = overlay.height = canvas.height;
            document.querySelectorAll('[data-needs-sel]').forEach(b => { b.disabled = !sel; });
            if (sel) {
                const img = octx.createImageData(w, h), d = img.data, hard = sel.hard;
                const tint = tool === 'wand' || tool === 'shape' || tool === 'rect', dash = w > 300 ? 3 : 2;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const i = y * w + x, p = i * 4;
                        if (hard[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !hard[i - 1] || !hard[i + 1] || !hard[i - w] || !hard[i + w])) {
                            d[p] = d[p + 1] = d[p + 2] = ((x + y) >> dash) & 1 ? 255 : 0;
                            d[p + 3] = 255;
                        } else if (tint && sel.mask[i]) {
                            d[p] = 90; d[p + 1] = 160; d[p + 2] = 255;
                            d[p + 3] = sel.mask[i] * 0.4;
                        }
                    }
                }
                octx.putImageData(img, 0, 0);
            }
            if (!poly) return;
            const pts = poly.cursor ? poly.points.concat([poly.cursor]) : poly.points;
            const line = Math.max(1, w / 300);
            octx.beginPath();
            pts.forEach(([x, y], i) => (i ? octx.lineTo(x + 0.5, y + 0.5) : octx.moveTo(x + 0.5, y + 0.5)));
            octx.lineWidth = line;
            octx.strokeStyle = '#000';
            octx.stroke();
            octx.setLineDash([line * 3, line * 3]);
            octx.strokeStyle = '#fff';
            octx.stroke();
            octx.setLineDash([]);
            octx.fillStyle = '#8ab4f8';
            for (const [x, y] of poly.points) octx.fillRect(x + 0.5 - line * 1.5, y + 0.5 - line * 1.5, line * 3, line * 3);
        }

        // Shape: the dropped points become a selection when the shape is closed.
        function closeShape() {
            const shape = poly;
            poly = null;
            if (shape && shape.points.length > 2) {
                const c = document.createElement('canvas');
                c.width = canvas.width;
                c.height = canvas.height;
                const x = c.getContext('2d');
                x.beginPath();
                shape.points.forEach(([px, py], i) => (i ? x.lineTo(px + 0.5, py + 0.5) : x.moveTo(px + 0.5, py + 0.5)));
                x.fill();
                const a = x.getImageData(0, 0, c.width, c.height).data;
                const hard = shape.add && sel ? sel.hard.slice() : new Uint8Array(c.width * c.height);
                for (let i = 0; i < hard.length; i++) if (a[i * 4 + 3] > 127) hard[i] = 1;
                floating = null;
                sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: null } : null;
                if (sel) return featherSelection();
            }
            drawSelection();
        }

        window.deselect = function() {
            sel = floating = null;
            drawSelection();
        };

        window.invertSelection = function() {
            floating = null;
            const hard = sel ? sel.hard.map(v => 1 - v) : new Uint8Array(canvas.width * canvas.height).fill(1);
            sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: null } : null;
            if (sel) featherSelection();
            else drawSelection();
        };

        // Limits a change to the selection: unselected pixels go back to what they were.
        function blendSelection(d, before) {
            if (!sel) return;
            for (let i = 0; i < sel.mask.length; i++) {
                const m = sel.mask[i];
                if (m === 255) continue;
                for (let p = i * 4, end = p + 4; p < end; p++) d[p] = before[p] + (d[p] - before[p]) * m / 255;
            }
        }

        // Runs a change on the canvas pixels as one undo step.
        function changePixels(change) {
            endLive();
            floating = null;
            pushHistory();
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const before = new Uint8ClampedArray(img.data);
            change(img, before);
            ctx.putImageData(img, 0, 0);
        }

        window.eraseSelection = function() {
            if (!sel) return;
            if (floating) {
                // A pasted piece that still floats goes away whole; the icon under it is as it was.
                endLive();
                pushHistory();
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(floating.rest, 0, 0);
                return deselect();
            }
            const { hard, mask } = sel;
            const soft = val('wand-feather') > 0;
            changePixels(img => {
                if (soft) for (let i = 0; i < mask.length; i++) img.data[i * 4 + 3] *= (255 - mask[i]) / 255;
                else eraseArea(img, hard);
            });
            deselect();
        };

        // Erases an area. The pixels along its edge are a blend of the erased colour and the icon:
        // they are given the icon's colour at a matching transparency, so no fringe of the erased
        // colour is left. The same rule as soften_edge on the server.
        function eraseArea(img, erased) {
            const d = img.data, w = img.width, h = img.height;
            const src = new Uint8ClampedArray(d);
            for (let i = 0; i < erased.length; i++) if (erased[i]) d[i * 4 + 3] = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const p = (y * w + x) * 4;
                    if (erased[y * w + x] || src[p + 3] < 255) continue;
                    const y0 = Math.max(0, y - 2), y1 = Math.min(h - 1, y + 2), x0 = Math.max(0, x - 2), x1 = Math.min(w - 1, x + 2);
                    let bg = -1;
                    for (let ny = y0; ny <= y1 && bg < 0; ny++) {
                        for (let nx = x0; nx <= x1; nx++) {
                            const n = ny * w + nx;
                            if (erased[n] && src[n * 4 + 3]) { bg = n * 4; break; }
                        }
                    }
                    if (bg < 0) continue;
                    // The icon's colour here: the opaque pixel within 2 px that is least like the erased colour.
                    let far = 0, f = p;
                    for (let ny = y0; ny <= y1; ny++) {
                        for (let nx = x0; nx <= x1; nx++) {
                            const n = ny * w + nx, q = n * 4;
                            if (erased[n] || src[q + 3] < 255) continue;
                            const dist = (src[q] - src[bg]) ** 2 + (src[q + 1] - src[bg + 1]) ** 2 + (src[q + 2] - src[bg + 2]) ** 2;
                            if (dist > far) { far = dist; f = q; }
                        }
                    }
                    if (far < 256) continue;
                    // How far this pixel is from the erased colour towards the icon's colour (0 to 1).
                    let dot = 0;
                    for (let c = 0; c < 3; c++) dot += (src[p + c] - src[bg + c]) * (src[f + c] - src[bg + c]);
                    const alpha = Math.max(0, dot / far);
                    if (alpha >= 0.95) continue;
                    // A pixel that is not on the line between the two colours is its own colour, not a blend.
                    let off = 0;
                    for (let c = 0; c < 3; c++) off += (src[p + c] - src[bg + c] - alpha * (src[f + c] - src[bg + c])) ** 2;
                    if (off > 900) continue;
                    d[p] = src[f];
                    d[p + 1] = src[f + 1];
                    d[p + 2] = src[f + 2];
                    d[p + 3] = Math.round(alpha * 255);
                }
            }
        }

        // Sharpen: each pixel moves a little away from the average of its four neighbours.
        function sharpen() {
            const amount = 0.2;
            changePixels((img, src) => {
                const d = img.data, w = img.width, h = img.height;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const p = (y * w + x) * 4;
                        if (!src[p + 3]) continue;
                        const near = [x > 0 ? p - 4 : p, x + 1 < w ? p + 4 : p, y > 0 ? p - w * 4 : p, y + 1 < h ? p + w * 4 : p];
                        for (let c = 0; c < 3; c++) {
                            let sum = 0;
                            // A transparent neighbour has no colour to compare with.
                            for (const q of near) sum += src[q + 3] ? src[q + c] : src[p + c];
                            d[p + c] = src[p + c] * (1 + 4 * amount) - sum * amount;
                        }
                    }
                }
                blendSelection(d, src);
            });
        }

        const luma = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

        // Fill: gives the icon (or the selection) one colour. Its average brightness becomes that
        // colour; darker pixels go towards black and lighter ones towards white, so shading stays.
        window.fillColour = function() {
            const hex = $('recolor-colour').value;
            const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
            changePixels((img, src) => {
                const d = img.data;
                let total = 0, weight = 0;
                for (let i = 0, p = 0; p < d.length; i++, p += 4) {
                    const wgt = src[p + 3] * (sel ? sel.mask[i] : 255);
                    total += luma(src, p) * wgt;
                    weight += wgt;
                }
                const mean = weight ? total / weight : 128;
                for (let p = 0; p < d.length; p += 4) {
                    const l = luma(src, p);
                    for (let c = 0; c < 3; c++) {
                        d[p + c] = l <= mean ? rgb[c] * l / (mean || 1) : rgb[c] + (255 - rgb[c]) * (l - mean) / (255 - mean);
                    }
                }
                blendSelection(d, src);
            });
        };

        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
            if (!d) return [0, 0, l];
            const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
        }

        function hslToRgb(h, s, l) {
            const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
            const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
            return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
        }

        // The Hue, Saturation and Brightness sliders.
        function adjustColours() {
            if (!editing) return;
            floating = null;
            beginLive();
            const turn = val('recolor-hue'), sat = val('recolor-sat') / 100, bright = val('recolor-bright') / 100;
            const src = live.img.data;
            const img = new ImageData(new Uint8ClampedArray(src), canvas.width, canvas.height), d = img.data;
            for (let p = 0; p < d.length; p += 4) {
                if (!src[p + 3]) continue;
                let [h, s, l] = rgbToHsl(src[p], src[p + 1], src[p + 2]);
                h = (h + turn + 360) % 360;
                s = Math.min(1, s * (1 + sat));
                l = bright > 0 ? l + (1 - l) * bright : l * (1 + bright);
                [d[p], d[p + 1], d[p + 2]] = hslToRgb(h, s, l);
            }
            blendSelection(d, src);
            ctx.putImageData(img, 0, 0);
        }

        ['recolor-hue', 'recolor-sat', 'recolor-bright'].forEach(id => $(id).addEventListener('input', adjustColours));
        $('wand-tolerance').addEventListener('input', replayWand);
        $('wand-feather').addEventListener('input', () => { if (sel) featherSelection(); });

        // Move: shifts the whole icon, or only the selected area when there is a selection. What
        // leaves the square is cut off.
        function liftParts() {
            if (floating) return { rest: floating.rest, lifted: floating.piece };
            if (!sel) return { rest: null, lifted: copyCanvas() };
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const part = keep => {
                const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
                for (let i = 0; i < sel.mask.length; i++) out.data[i * 4 + 3] *= (keep ? 255 - sel.mask[i] : sel.mask[i]) / 255;
                const c = document.createElement('canvas');
                c.width = img.width;
                c.height = img.height;
                c.getContext('2d').putImageData(out, 0, 0);
                return c;
            };
            return { rest: part(true), lifted: part(false) };
        }

        function drawParts(parts, dx, dy) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (parts.rest) ctx.drawImage(parts.rest, 0, 0);
            ctx.drawImage(parts.lifted, dx, dy);
        }

        // The selection follows the pixels it moved.
        function shiftSelection(dx, dy) {
            if (!sel) return;
            const w = canvas.width, h = canvas.height;
            const shift = from => {
                const to = new Uint8Array(from.length);
                for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
                    for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) to[(y + dy) * w + x + dx] = from[y * w + x];
                }
                return to;
            };
            const hard = shift(sel.hard);
            sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: shift(sel.mask) } : null;
            drawSelection();
        }

        function newCanvas(draw) {
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            draw(c.getContext('2d'));
            return c;
        }

        // Puts the lifted part down dx, dy from where it was. A pasted piece stays afloat there.
        function placeParts(parts, dx, dy) {
            drawParts(parts, dx, dy);
            if (floating) floating = { rest: floating.rest, piece: newCanvas(x => x.drawImage(parts.lifted, dx, dy)) };
            shiftSelection(dx, dy);
        }

        window.nudge = function(dx, dy) {
            if (!editing || (!dx && !dy)) return;
            endLive();
            pushHistory();
            placeParts(liftParts(), dx, dy);
        };

        // Rotate: turns the selected area (or the whole icon) around its middle. The selection turns with it.
        function rotateLive(angle) {
            if (!editing) return;
            beginLive();
            if (!live.parts) {
                const w = canvas.width, h = canvas.height;
                let x0 = w, y0 = h, x1 = -1, y1 = -1;
                for (let i = 0; sel && i < sel.hard.length; i++) {
                    if (!sel.hard[i]) continue;
                    const x = i % w, y = Math.floor(i / w);
                    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                }
                if (x1 < 0) [x0, y0, x1, y1] = [0, 0, w - 1, h - 1];
                // Half a pixel off when the area is odd by even, so a quarter turn lands on whole pixels.
                live.centre = [(x0 + x1 + 1) / 2 + ((x1 - x0 + y1 - y0) % 2) / 2, (y0 + y1 + 1) / 2];
                live.parts = liftParts();
                live.sel = sel;
            }
            const [cx, cy] = live.centre;
            const turned = src => newCanvas(x => {
                x.translate(cx, cy);
                x.rotate(angle * Math.PI / 180);
                x.translate(-cx, -cy);
                x.imageSmoothingQuality = 'high';
                x.drawImage(src, 0, 0);
            });
            live.piece = turned(live.parts.lifted);
            drawParts({ rest: live.parts.rest, lifted: live.piece }, 0, 0);
            if (!live.sel) return;
            const mask = new ImageData(canvas.width, canvas.height);
            live.sel.mask.forEach((m, i) => { mask.data[i * 4 + 3] = m; });
            const a = turned(newCanvas(x => x.putImageData(mask, 0, 0))).getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const hard = live.sel.hard.map((v, i) => (a[i * 4 + 3] > 127 ? 1 : 0));
            sel = hard.includes(1) ? { seeds: [], base: hard.slice(), hard, mask: live.sel.mask.map((v, i) => a[i * 4 + 3]) } : null;
            drawSelection();
        }

        $('rotate-angle').addEventListener('input', () => rotateLive(val('rotate-angle')));

        window.rotateQuarter = function(dir) {
            endLive();
            rotateLive(dir * 90);
            endLive();
        };

        // Copy takes the selected area (or the whole icon). Paste puts it on top of the icon as a
        // floating piece: it can be dragged and turned without changing what is under it, until it is
        // let go (Deselect, a new selection, or any other change).
        window.copySelection = function() {
            if (!editing) return;
            endLive();
            clip = liftParts().lifted;
            $('edit-paste').disabled = false;
            $('tool-hint').textContent = 'Copied. Paste (Ctrl+V) puts it on top of the icon, here or in another icon.';
        };

        window.pasteClip = function() {
            if (!editing || !clip) return;
            endLive();
            pushHistory();
            const rest = copyCanvas();
            // A piece from an icon of another size goes in the middle.
            const piece = newCanvas(x => x.drawImage(clip, (canvas.width - clip.width) / 2, (canvas.height - clip.height) / 2));
            ctx.drawImage(piece, 0, 0);
            const a = piece.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const hard = new Uint8Array(canvas.width * canvas.height).map((v, i) => (a[i * 4 + 3] ? 1 : 0));
            sel = { seeds: [], base: hard.slice(), hard, mask: hard.map(v => v * 255) };
            floating = { rest, piece };
            setTool('move');
            $('tool-hint').textContent = 'Pasted on top of the icon. Drag it into place (or Rotate it): the icon under it stays whole. Deselect (Esc) lets it go where it is; Del takes it away again.';
        };

        window.centreIcon = function() {
            const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data, w = canvas.width, h = canvas.height;
            let x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (!d[(y * w + x) * 4 + 3] || (sel && !sel.hard[y * w + x])) continue;
                    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
                    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
                }
            }
            if (x1 >= 0) nudge(Math.round((w - 1 - x0 - x1) / 2), Math.round((h - 1 - y0 - y1) / 2));
        };

        function drawCropBox() {
            ctx.putImageData(cropSnap, 0, 0);
            if (!cropBox) return;
            const [x, y, w, h] = cropBox;
            ctx.save();
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.beginPath();
            ctx.rect(0, 0, canvas.width, canvas.height);
            ctx.rect(x, y, w, h);
            ctx.fill('evenodd');
            ctx.strokeStyle = '#8ab4f8';
            ctx.lineWidth = Math.max(1, canvas.width / 256);
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
            ctx.restore();
        }

        canvas.addEventListener('mousedown', e => {
            if (!editing || e.button) return;
            e.preventDefault();
            const [x, y] = canvasPoint(e);
            if (tool === 'crop') {
                cropStart = [x, y];
                cropBox = null;
                cropSnap = ctx.getImageData(0, 0, canvas.width, canvas.height);
            } else if (tool === 'rect') {
                rectStart = { x: Math.min(x, canvas.width - 1), y: Math.min(y, canvas.height - 1), add: e.ctrlKey || e.metaKey || e.shiftKey };
            } else if (tool === 'wand') {
                floating = null;
                // A plain click starts a new selection; Ctrl (or Shift) adds to the one there is.
                if (!sel || !(e.ctrlKey || e.metaKey || e.shiftKey)) sel = { seeds: [], base: null, hard: new Uint8Array(canvas.width * canvas.height), mask: null };
                wandImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
                addSeed(Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1));
            } else if (tool === 'shape') {
                if (!poly) poly = { points: [], add: e.ctrlKey || e.metaKey || e.shiftKey, cursor: null };
                const first = poly.points[0];
                const f = canvas.getBoundingClientRect().width / canvas.width;
                // A double-click or a click on the first point closes the shape.
                if (e.detail > 1 || (poly.points.length > 2 && Math.hypot(x - first[0], y - first[1]) * f < 8)) return closeShape();
                poly.points.push([x, y]);
                poly.cursor = null;
                drawSelection();
            } else if (tool === 'move') {
                endLive();
                pushHistory();
                moveStart = [e.clientX, e.clientY];
                moveParts = liftParts();
                moveBy = [0, 0];
            } else if (tool === 'sharpen') {
                sharpen();
            }
        });

        window.addEventListener('mousemove', e => {
            if (wandImg) {
                // Dragging adds every area the pointer passes over.
                const rect = canvas.getBoundingClientRect();
                if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return;
                const [x, y] = canvasPoint(e);
                addSeed(Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1));
                return;
            }
            if (rectStart) {
                const [x, y] = canvasPoint(e);
                rectStart.to = [Math.min(x, canvas.width - 1), Math.min(y, canvas.height - 1)];
                const { x: ax, y: ay, to: [bx, by] } = rectStart;
                poly = { points: [[ax, ay], [bx, ay], [bx, by], [ax, by], [ax, ay]], cursor: null };
                drawSelection();
                return;
            }
            if (poly && poly.points.length) {
                poly.cursor = canvasPoint(e);
                drawSelection();
                return;
            }
            if (moveStart) {
                const f = canvas.width / canvas.getBoundingClientRect().width;
                moveBy = [Math.round((e.clientX - moveStart[0]) * f), Math.round((e.clientY - moveStart[1]) * f)];
                drawParts(moveParts, moveBy[0], moveBy[1]);
                // The outline rides along until the mouse is let go.
                overlay.style.transform = 'translate(' + moveBy[0] * 100 / canvas.width + '%, ' + moveBy[1] * 100 / canvas.height + '%)';
                return;
            }
            if (!cropStart) return;
            const [x, y] = canvasPoint(e);
            let w = Math.abs(x - cropStart[0]), h = Math.abs(y - cropStart[1]);
            if (e.shiftKey) {
                // Shift keeps the box square, as large as fits between the start point and the edges.
                const roomX = x < cropStart[0] ? cropStart[0] : canvas.width - cropStart[0];
                const roomY = y < cropStart[1] ? cropStart[1] : canvas.height - cropStart[1];
                w = h = Math.min(Math.max(w, h), roomX, roomY);
            }
            const bx = x < cropStart[0] ? cropStart[0] - w : cropStart[0];
            const by = y < cropStart[1] ? cropStart[1] - h : cropStart[1];
            cropBox = [Math.max(0, bx), Math.max(0, by), w, h];
            drawCropBox();
        });

        window.addEventListener('mouseup', () => {
            wandImg = null;
            if (rectStart) {
                const r = rectStart;
                rectStart = poly = null;
                // A click without a drag selects nothing.
                if (!r.to) return r.add ? drawSelection() : deselect();
                const w = canvas.width;
                const hard = r.add && sel ? sel.hard.slice() : new Uint8Array(w * canvas.height);
                for (let y = Math.min(r.y, r.to[1]); y <= Math.max(r.y, r.to[1]); y++) {
                    hard.fill(1, y * w + Math.min(r.x, r.to[0]), y * w + Math.max(r.x, r.to[0]) + 1);
                }
                floating = null;
                sel = { seeds: [], base: hard.slice(), hard, mask: null };
                return featherSelection();
            }
            if (moveStart) {
                const parts = moveParts;
                moveStart = moveParts = null;
                overlay.style.transform = '';
                // A click without a drag changed nothing, so it is not an undo step.
                if (!moveBy[0] && !moveBy[1]) undoEdit();
                else placeParts(parts, moveBy[0], moveBy[1]);
                return;
            }
            if (!cropStart) return;
            cropStart = null;
            ctx.putImageData(cropSnap, 0, 0);
            const box = cropBox;
            cropBox = null;
            if (!box || box[2] < 4 || box[3] < 4) return;
            // Fit the kept box into the square canvas, centred, keeping its aspect ratio.
            floating = null;
            pushHistory();
            const src = copyCanvas();
            const [x, y, w, h] = box;
            const f = Math.min(canvas.width / w, canvas.height / h);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(src, x, y, w, h, (canvas.width - w * f) / 2, (canvas.height - h * f) / 2, w * f, h * f);
        });

        function startEdit(target, src, toolName) {
            const img = new Image();
            img.onload = () => {
                editing = target;
                // Icons are shown in a square, so a taller or wider image is centred in one.
                const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
                canvas.width = canvas.height = Math.max(iw, ih);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, (canvas.width - iw) / 2, (canvas.height - ih) / 2);
                history = [];
                sel = floating = null;
                $('edit-undo').disabled = true;
                $('edit-apply').textContent = target.type === 'slot' ? 'Save as the icon for ' + target.key : 'Apply Changes';
                setTool(toolName || 'wand');
                $('editor-modal').hidden = false;
                setZoom(1);
            };
            img.src = src;
        }

        window.openEditor = function(i, toolName) {
            startEdit({ type: 'candidate', index: i }, candidates[i].image, toolName);
        };

        window.closeEditor = function() {
            $('editor-modal').hidden = true;
            editing = null;
            sel = live = poly = floating = rectStart = null;
        };

        window.saveEdit = async function() {
            const target = editing;
            const dataUrl = canvas.toDataURL('image/png');
            const changed = history.length;
            closeEditor();
            if (!target || !changed) return;
            if (target.type === 'candidate') {
                const c = candidates[target.index];
                c.image = dataUrl;
                c.el.querySelector('img').src = dataUrl;
                // An edited copy of a saved icon can be picked and saved again.
                c.saved = false;
                c.el.classList.remove('saved');
                updatePreview();
                return;
            }
            // An edited slot icon becomes the slot's icon; the one before stays in its ▾ list.
            try {
                applyRegistry(await api('/save', { key: target.key, images: [dataUrl] }));
                renderRegistry();
                setStatus('✅ Saved the edited icon to ' + target.key + '. The one before is in its ▾ list. Reload the web app to see it.');
            } catch (e) {
                setStatus(e.message, true);
            }
        };

        const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        window.addEventListener('keydown', e => {
            if (!editing) return;
            // Keys typed into a number box belong to the box.
            if (e.target.matches && e.target.matches('input[type=number]') && e.key !== 'Escape') return;
            const ctrl = e.ctrlKey || e.metaKey;
            if (poly) {
                // Keys while a shape is being drawn.
                if (e.key === 'Enter') closeShape();
                else if (e.key === 'Escape') { poly = null; drawSelection(); }
                else if (e.key === 'Backspace') { poly.points.pop(); if (!poly.points.length) poly = null; drawSelection(); }
                else return;
                e.preventDefault();
            } else if (e.key === 'Escape') {
                if (sel) deselect();
                else closeEditor();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                undoEdit();
            } else if (ctrl && e.key.toLowerCase() === 'c') {
                e.preventDefault();
                copySelection();
            } else if (ctrl && e.key.toLowerCase() === 'v') {
                e.preventDefault();
                pasteClip();
            } else if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
                e.preventDefault();
                stepSlider(e.key === '[' || e.key === '{' ? -1 : 1, e.shiftKey);
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
                e.preventDefault();
                eraseSelection();
            } else if (tool === 'move' && ARROWS[e.key]) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                nudge(ARROWS[e.key][0] * step, ARROWS[e.key][1] * step);
            }
        });

        async function api(path, body, signal) {
            const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
            const res = await fetch(path, opts);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || res.statusText);
                err.status = res.status;
                throw err;
            }
            return data;
        }

        function setStatus(msg, isError) {
            $('status').textContent = msg;
            $('status').className = 'status' + (isError ? ' error' : '');
        }

        // An emoji or image for a registry entry ({ type, value }). Image paths are relative to the site root (apps/web/public).
        function iconEl(entry) {
            if (entry && entry.type === 'image' && entry.value) {
                const img = document.createElement('img');
                img.src = /^https?:/.test(entry.value) ? entry.value : '/' + entry.value;
                img.alt = entry.value;
                return img;
            }
            const span = document.createElement('span');
            span.className = 'emoji';
            span.textContent = (entry && entry.value) || '?';
            return span;
        }

        function slotEntry(key) {
            const [group, name] = key.split('.');
            return registry[group] && registry[group][name];
        }

        function applyRegistry(data) {
            registry = data.registry;
            labels = data.labels || {};
        }

        function renderRegistry() {
            closeMenus();
            const groups = $('groups');
            const list = $('slot-list');
            groups.innerHTML = '';
            list.innerHTML = '';
            if (scan) {
                renderNeedsIcon(groups);
                fillSwapList();
            }
            for (const [group, slots] of Object.entries(registry)) {
                const heading = document.createElement('h3');
                heading.textContent = group;
                const grid = document.createElement('div');
                grid.className = 'grid';
                for (const [name, entry] of Object.entries(slots)) {
                    if (!entry || !entry.type) continue;
                    const key = group + '.' + name;
                    const card = document.createElement('div');
                    card.className = 'icon-card';
                    card.dataset.key = key;
                    card.appendChild(iconEl(entry));
                    const label = document.createElement('span');
                    label.className = 'label' + (labels[key] ? ' words' : '');
                    label.textContent = labels[key] || key;
                    card.appendChild(label);
                    card.onclick = () => targetSlot(key);
                    wireCard(card, key, label);
                    const variants = entry.variants || [];
                    if (variants.length > 1) {
                        const arrow = document.createElement('button');
                        arrow.className = 'variant-arrow';
                        arrow.title = variants.length + ' saved icons';
                        arrow.textContent = '▾';
                        arrow.onclick = e => { e.stopPropagation(); toggleVariantMenu(key, arrow); };
                        card.appendChild(arrow);
                    }
                    grid.appendChild(card);
                    const opt = document.createElement('option');
                    opt.value = key;
                    list.appendChild(opt);
                }
                groups.appendChild(heading);
                groups.appendChild(grid);
            }
            slotChanged();
        }

        // Emoji found by "Find emoji" that have no registry.emoji entry yet.
        function renderNeedsIcon(groups) {
            const needs = scan.filter(item => !slotEntry(item.key));
            const heading = document.createElement('h3');
            heading.textContent = 'Needs icon (' + needs.length + ')';
            const hint = document.createElement('div');
            hint.className = 'hint needs-hint';
            hint.textContent = needs.length
                ? 'Emoji in the app that have no icon yet. Click one to make icons for it: the icon you save replaces that emoji on every page, desktop and Android. Emoji in tooltips, dropdown options, window titles and native menus stay emoji.'
                : 'Every emoji found has an icon or was kept as an emoji.';
            const grid = document.createElement('div');
            grid.className = 'grid';
            for (const item of needs) {
                const card = document.createElement('div');
                card.className = 'icon-card';
                card.dataset.key = item.key;
                card.appendChild(iconEl({ type: 'emoji', value: item.emoji }));
                const label = document.createElement('span');
                label.className = 'label words';
                label.textContent = item.name || item.key;
                const sub = document.createElement('span');
                sub.className = 'sub';
                sub.textContent = item.places.length + (item.places.length === 1 ? ' place' : ' places');
                card.append(label, sub);
                card.onclick = () => targetSlot(item.key);
                wireCard(card, item.key, label);
                const keep = document.createElement('button');
                keep.className = 'keep-btn';
                keep.textContent = 'Keep emoji';
                keep.title = 'Leave this emoji as it is and take it off this list';
                keep.onclick = e => { e.stopPropagation(); keepEmoji(item.key); };
                card.appendChild(keep);
                grid.appendChild(card);
            }
            groups.append(heading, hint, grid);
        }

        async function scanEmoji() {
            $('scan-btn').disabled = true;
            try {
                scan = (await api('/scan_emoji')).emoji;
                renderRegistry();
                $('registry-panel').scrollTop = 0;
                setStatus('Found ' + scan.length + ' different emoji, ' + scan.filter(item => !slotEntry(item.key)).length + ' without an icon.');
            } catch (e) {
                setStatus('Scan failed: ' + e.message, true);
            }
            $('scan-btn').disabled = false;
        }

        async function keepEmoji(key) {
            try {
                applyRegistry(await api('/keep_emoji', { key }));
                renderRegistry();
            } catch (e) {
                setStatus(e.message, true);
            }
        }

        function targetSlot(key) {
            $('slot').value = key;
            if (autoPrompt || !$('prompt').value.trim()) {
                $('prompt').value = slotPrompt(key);
                autoPrompt = true;
            }
            slotChanged();
        }

        // A starting prompt for a slot: the emoji's name ("speech balloon") or the slot name.
        function slotPrompt(key) {
            const found = scan && scan.find(item => item.key === key);
            if (found && found.name) return found.name;
            const name = labels[key] && labels[key].split(' ').slice(1).join(' ');
            return name || key.split('.')[1].replace(/_/g, ' ');
        }

        // Where the targeted emoji appears in the code, after a scan. Ticked places can be changed to
        // another emoji, which then has its own icon.
        function showPlaces(key) {
            const found = scan && scan.find(item => item.key === key);
            const places = $('places');
            places.hidden = $('swap-row').hidden = !found;
            places.innerHTML = '';
            if (ticked.key !== key) ticked = { key, places: new Set() };
            if (!found) return;
            const ids = found.places.map(([file, line]) => file + ':' + line);
            const head = document.createElement('label');
            const all = document.createElement('input');
            all.type = 'checkbox';
            all.title = 'Tick or untick every place';
            all.onchange = () => {
                ticked.places = new Set(all.checked ? ids : []);
                showPlaces(key);
            };
            head.append(all, found.emoji + ' is used in ' + ids.length + (ids.length === 1 ? ' place.' : ' places.') + ' Tick the ones to change:');
            places.appendChild(head);
            found.places.forEach(([file, line, text], i) => {
                const row = document.createElement('label');
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = ticked.places.has(ids[i]);
                box.onchange = () => {
                    if (box.checked) ticked.places.add(ids[i]);
                    else ticked.places.delete(ids[i]);
                    updateSwap(found);
                };
                const loc = document.createElement('b');
                loc.textContent = file.replace(/^apps\\/web\\//, '') + ':' + line;
                row.append(box, loc, ' ' + text);
                row.title = file + ':' + line + '\\n' + text;
                places.appendChild(row);
            });
            updateSwap(found);
        }

        function updateSwap(found) {
            const n = ticked.places.size;
            const all = $('places').querySelector('input');
            all.checked = n === found.places.length;
            all.indeterminate = n > 0 && !all.checked;
            $('swap-btn').disabled = !n || !$('swap-to').value.trim();
            $('swap-btn').textContent = n ? 'Change ' + n + (n === 1 ? ' place' : ' places') : 'Change ticked';
        }

        // Emoji the scan found or the registry holds, to pick the replacement from by name.
        function fillSwapList() {
            const known = new Map(scan.map(item => [item.emoji, item.name]));
            for (const label of Object.values(labels)) {
                const [emoji, ...name] = label.split(' ');
                if (!known.has(emoji)) known.set(emoji, name.join(' '));
            }
            $('swap-list').innerHTML = '';
            for (const [emoji, name] of known) {
                const opt = document.createElement('option');
                opt.value = emoji;
                opt.label = name;
                $('swap-list').appendChild(opt);
            }
        }

        // Rewrites the ticked lines of the source to use another emoji, then targets that emoji.
        async function swapPlaces() {
            const found = scan && scan.find(item => item.key === ticked.key);
            if (!found) return;
            const places = found.places.filter(([file, line]) => ticked.places.has(file + ':' + line)).map(([file, line]) => [file, line]);
            $('swap-btn').disabled = true;
            try {
                const data = await api('/swap_emoji', { key: found.key, to: $('swap-to').value.trim(), places });
                applyRegistry(data);
                scan = data.emoji;
                $('swap-to').value = '';
                renderRegistry();
                targetSlot(data.to_key);
                const to = scan.find(item => item.key === data.to_key);
                setStatus('✅ Changed ' + data.changed + (data.changed === 1 ? ' place' : ' places') + ' from ' + found.emoji + ' to ' + (to ? to.emoji : data.to_key) +
                    (data.skipped ? ' (' + data.skipped + ' had changed since the scan and were left alone)' : '') + '. Reload the web app to see it.');
            } catch (e) {
                setStatus(e.message, true);
                updateSwap(found);
            }
        }

        function slotChanged() {
            const key = $('slot').value.trim();
            const preview = $('slot-preview');
            preview.innerHTML = '';
            if (KEY_RE.test(key)) {
                const entry = slotEntry(key);
                if (entry) preview.appendChild(iconEl(entry));
                else preview.innerHTML = '<span class="new">new</span>';
            }
            document.querySelectorAll('.icon-card').forEach(c => c.classList.toggle('targeted', c.dataset.key === key));
            showPlaces(key);
            updatePicks();
        }

        function toggleVariantMenu(key, anchor) {
            const menu = $('variant-menu');
            const wasOpen = !menu.hidden && menu.dataset.key === key;
            closeMenus();
            if (wasOpen) return;
            const entry = slotEntry(key);
            menu.dataset.key = key;
            for (const v of entry.variants) {
                const opt = document.createElement('button');
                opt.className = 'variant checker' + (v.type === entry.type && v.value === entry.value ? ' active' : '');
                opt.title = v.value;
                opt.appendChild(iconEl(v));
                opt.onclick = () => setActive(key, v);
                menu.appendChild(opt);
            }
            menu.hidden = false;
            anchor.classList.add('open');
            placeMenu(menu, anchor);
        }

        function closeVariantMenu() {
            $('variant-menu').hidden = true;
            $('variant-menu').innerHTML = '';
            document.querySelectorAll('.variant-arrow.open').forEach(a => a.classList.remove('open'));
        }

        function placeMenu(menu, anchor) {
            const r = anchor.getBoundingClientRect();
            menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
            menu.style.top = Math.max(8, r.bottom + menu.offsetHeight + 4 > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4) + 'px';
        }

        function closeMenus() {
            closeVariantMenu();
            $('usage-menu').hidden = true;
            $('usage-menu').innerHTML = '';
            document.querySelectorAll('.usage-arrow.open').forEach(a => a.classList.remove('open'));
        }

        // The entry a card shows: the slot's, or the emoji itself for one the scan found.
        function cardEntry(key) {
            const found = scan && scan.find(item => item.key === key);
            return slotEntry(key) || (found && { type: 'emoji', value: found.emoji });
        }

        // "💬 speech balloon" for an emoji slot, the key for a named one.
        function slotName(key) {
            const found = scan && scan.find(item => item.key === key);
            return labels[key] || (found ? found.emoji + ' ' + found.name : key);
        }

        // Every card gets a ▾ next to its name (where the code uses the icon) and can be dragged onto
        // another card to merge the two.
        function wireCard(card, key, label) {
            const arrow = document.createElement('button');
            arrow.className = 'usage-arrow';
            arrow.title = 'Where the code uses this icon';
            arrow.textContent = '▾';
            arrow.onclick = e => { e.stopPropagation(); toggleUsageMenu(key, arrow); };
            label.appendChild(arrow);
            card.querySelectorAll('img').forEach(img => { img.draggable = false; });
            card.draggable = true;
            card.addEventListener('dragstart', e => {
                e.dataTransfer.setData(SLOT_DRAG, key);
                e.dataTransfer.effectAllowed = 'move';
            });
            card.addEventListener('dragover', e => {
                if (!e.dataTransfer.types.includes(SLOT_DRAG)) return;
                e.preventDefault();
                card.classList.add('merge-target');
            });
            card.addEventListener('dragleave', () => card.classList.remove('merge-target'));
            card.addEventListener('drop', e => {
                if (!e.dataTransfer.types.includes(SLOT_DRAG)) return;
                e.preventDefault();
                card.classList.remove('merge-target');
                const from = e.dataTransfer.getData(SLOT_DRAG);
                if (from && from !== key) mergeSlots(from, key);
            });
        }

        async function toggleUsageMenu(key, anchor) {
            const menu = $('usage-menu');
            const wasOpen = !menu.hidden && menu.dataset.key === key;
            closeMenus();
            if (wasOpen) return;
            menu.dataset.key = key;
            menu.textContent = 'Looking through the code…';
            menu.hidden = false;
            anchor.classList.add('open');
            placeMenu(menu, anchor);
            let places;
            try {
                places = (await api('/usages?key=' + encodeURIComponent(key))).places;
            } catch (e) {
                places = e.message;
            }
            if (menu.hidden || menu.dataset.key !== key) return;
            menu.innerHTML = '';
            const head = document.createElement('div');
            head.className = 'usage-title';
            const name = slotName(key);
            if (typeof places === 'string') head.textContent = places;
            else if (!places.length) head.textContent = name + ' is not named anywhere in the code. It may be an unused slot, or its name is put together while the app runs.';
            else head.textContent = name + ' is used in ' + places.length + (places.length === 1 ? ' place.' : ' places. Split gives one place its own icon.');
            menu.appendChild(head);
            for (const place of typeof places === 'string' ? [] : places) {
                const row = document.createElement('div');
                row.className = 'usage';
                const top = document.createElement('div');
                top.className = 'usage-head';
                const loc = document.createElement('b');
                loc.textContent = place.file.replace('apps/web/', '') + ':' + place.line;
                loc.title = place.file + ':' + place.line;
                const split = document.createElement('button');
                split.textContent = 'Split';
                split.title = 'Give this place its own icon, apart from the other places';
                split.onclick = () => splitPlace(key, place);
                top.append(loc, split);
                const code = document.createElement('div');
                code.className = 'usage-code';
                for (const [number, text] of place.context) {
                    const line = document.createElement('div');
                    if (number === place.line) line.className = 'hit';
                    line.textContent = number + '  ' + text;
                    code.appendChild(line);
                }
                row.append(top, code);
                menu.appendChild(row);
            }
            placeMenu(menu, anchor);
        }

        // Split: one place in the code gets its own slot, a copy of this one, to restyle on its own.
        // An emoji is its own name, so an emoji place has to change to another emoji instead.
        async function splitPlace(key, place) {
            let to;
            if (key.startsWith('emoji.')) {
                to = (prompt('An emoji gets its icon by which emoji it is, so this place needs a different emoji to have its own icon. Emoji to use here:') || '').trim();
                if (!to) return;
            }
            try {
                const data = await api('/split', { key, file: place.file, line: place.line, to });
                applyRegistry(data);
                if (data.emoji) scan = data.emoji;
                renderRegistry();
                targetSlot(data.new_key);
                setStatus('✅ ' + place.file.split('/').pop() + ':' + place.line + ' now uses ' + slotName(data.new_key) + '. Make or pick an icon for it.');
            } catch (e) {
                setStatus(e.message, true);
            }
        }

        // Asks which of two different icons the merged slot shows. Resolves to 'from', 'into' or null.
        function askKeep(from, a, into, b, mixed) {
            return new Promise(resolve => {
                const choices = $('merge-choices');
                choices.innerHTML = '';
                $('merge-text').textContent = (mixed ? slotName(from) + ' and ' + slotName(into) + ' will show the same icon.' : 'Merging ' + slotName(from) + ' into ' + slotName(into) + '.') +
                    ' Every place in the code that uses either will show one icon. Which one?';
                const done = answer => { $('merge-modal').hidden = true; resolve(answer); };
                for (const [answer, key, entry] of [['from', from, a], ['into', into, b]]) {
                    const btn = document.createElement('button');
                    btn.className = 'merge-choice checker';
                    btn.appendChild(iconEl(entry));
                    const name = document.createElement('span');
                    name.textContent = 'Keep ' + (entry.type === 'emoji' ? entry.value : 'the icon of ' + slotName(key));
                    btn.appendChild(name);
                    btn.onclick = () => done(answer);
                    choices.appendChild(btn);
                }
                $('merge-cancel').onclick = () => done(null);
                $('merge-modal').hidden = false;
            });
        }

        // Merge: dragging one card onto another makes every place that used the dragged icon use the
        // other one, and joins their ▾ lists.
        async function mergeSlots(from, into) {
            // The code names an emoji and a slot in different ways, so those two stay apart and share an icon.
            const mixed = from.startsWith('emoji.') !== into.startsWith('emoji.');
            const a = cardEntry(from), b = cardEntry(into);
            if (!a || !b) return;
            const names = [slotName(from), slotName(into)];
            let keep = 'into';
            if (a.type !== b.type || a.value !== b.value) {
                keep = await askKeep(from, a, into, b, mixed);
                if (!keep) return;
            }
            try {
                const data = await api('/merge', { from, into, keep });
                applyRegistry(data);
                if (data.emoji) scan = data.emoji;
                renderRegistry();
                targetSlot(data.key);
                if (mixed) return setStatus('✅ ' + names[0] + ' and ' + names[1] + ' now show the same icon, and each has the other in its ▾ list. Reload the web app to see it.');
                setStatus('✅ Merged ' + names[0] + ' and ' + names[1] + ' into ' + slotName(data.key) + ': changed ' + data.changed + (data.changed === 1 ? ' place' : ' places') + ' in the code. Reload the web app to see it.');
            } catch (e) {
                setStatus(e.message, true);
            }
        }

        async function setActive(key, variant) {
            try {
                applyRegistry(await api('/set_active', { key, value: variant.value }));
                renderRegistry();
                setStatus('✅ ' + key + ' now uses ' + variant.value.split('/').pop());
            } catch (e) {
                setStatus(e.message, true);
            }
        }

        async function generate() {
            const prompt = $('prompt').value.trim();
            if (!prompt) return setStatus('Describe the icon first.', true);
            stopRun();
            const thisRun = run = { stopped: false, controllers: new Set() };
            picked = [];
            $('candidates').innerHTML = '';
            candidates = Array.from({ length: CANDIDATES }, (_, i) => {
                const el = document.createElement('div');
                el.className = 'candidate checker waiting';
                el.onclick = () => togglePick(i);
                $('candidates').appendChild(el);
                return { el, image: null, saved: false };
            });
            updatePicks();
            setStatus('');
            setRunning(true);

            const removeBg = $('remove-bg').checked;
            const baseSeed = Math.floor(Math.random() * 900000) + 1;
            let next = 0, done = 0;
            const showProgress = () => {
                if (run === thisRun) $('progress').textContent = 'Generating ' + done + ' / ' + CANDIDATES + (keyed ? '' : ' (free tier: one at a time)');
            };
            showProgress();
            const worker = async () => {
                while (!thisRun.stopped && next < CANDIDATES) {
                    await fillCandidate(thisRun, next++, prompt, baseSeed, removeBg);
                    done++;
                    showProgress();
                }
            };
            await Promise.all(Array.from({ length: keyed ? 4 : 1 }, worker));
            if (run === thisRun) {
                run = null;
                setRunning(false);
                $('progress').textContent = done + ' icons generated. Pick up to ' + MAX_PICK + '.';
            }
        }

        async function fillCandidate(thisRun, i, prompt, baseSeed, removeBg) {
            const c = candidates[i];
            c.el.className = 'candidate checker loading';
            for (let attempt = 0; attempt < 12 && !thisRun.stopped; attempt++) {
                const ctrl = new AbortController();
                thisRun.controllers.add(ctrl);
                try {
                    const data = await api('/generate', { prompt, seed: baseSeed + i, removeBg }, ctrl.signal);
                    c.image = data.image;
                    c.el.className = 'candidate checker ready';
                    c.el.innerHTML = '<img src="' + data.image + '"><button class="edit-btn" onclick="event.stopPropagation(); window.openEditor(' + i + ')">✏️ Edit</button>';
                    return;
                } catch (e) {
                    if (thisRun.stopped) break;
                    // 429: Pollinations still has an earlier image queued for this IP (e.g. after Stop). Wait and retry.
                    if (e.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
                    c.el.className = 'candidate checker failed';
                    c.el.textContent = '✕';
                    c.el.title = e.message;
                    return;
                } finally {
                    thisRun.controllers.delete(ctrl);
                }
            }
            if (thisRun.stopped) {
                c.el.className = 'candidate checker waiting';
            } else {
                c.el.className = 'candidate checker failed';
                c.el.textContent = '✕';
                c.el.title = 'Pollinations stayed busy';
            }
        }

        // Drag and drop: dropped image files become extra candidate tiles, already picked.
        let dragDepth = 0;
        const hasFiles = e => e.dataTransfer.types.includes('Files');
        window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dropping'); });
        window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
        window.addEventListener('dragover', e => e.preventDefault());
        window.addEventListener('drop', e => {
            e.preventDefault();
            dragDepth = 0;
            document.body.classList.remove('dropping');
            if (!hasFiles(e)) return;
            // .jfif, .pjpeg and friends often arrive with an empty type; the server checks the bytes.
            const files = Array.from(e.dataTransfer.files).filter(f =>
                f.type.startsWith('image/') || (!f.type && /\\.(jfif|pjpeg|pjp|jpe|jpg|jpeg|png|webp|gif|bmp|ico|tiff?)$/i.test(f.name)));
            if (!files.length) return setStatus('Drop image files (PNG, JPG, JFIF, WebP…).', true);
            files.forEach(addDroppedFile);
        });

        function addDroppedFile(file) {
            const i = candidates.length;
            const el = document.createElement('div');
            el.className = 'candidate checker loading';
            el.title = file.name;
            el.onclick = () => togglePick(i);
            $('candidates').appendChild(el);
            const c = { el, image: null, saved: false };
            candidates.push(c);
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const data = await api('/upload', { image: reader.result, removeBg: $('remove-bg').checked });
                    // A new Generate replaced the tiles while this one was loading.
                    if (candidates[i] !== c) return;
                    c.image = data.image;
                    el.className = 'candidate checker ready';
                    el.innerHTML = '<img src="' + data.image + '"><button class="edit-btn" onclick="event.stopPropagation(); window.openEditor(' + i + ')">✏️ Edit</button>';
                    if (picked.length < MAX_PICK) { picked.push(i); updatePicks(); }
                } catch (err) {
                    el.className = 'candidate checker failed';
                    el.textContent = '✕';
                    el.title = err.message;
                }
            };
            reader.readAsDataURL(file);
        }

        function stopRun() {
            if (!run) return;
            run.stopped = true;
            run.controllers.forEach(c => c.abort());
            run = null;
            setRunning(false);
            $('progress').textContent = 'Stopped.';
        }

        function setRunning(on) {
            $('gen-btn').disabled = on;
            $('stop-btn').disabled = !on;
        }

        function togglePick(i) {
            const c = candidates[i];
            if (!c.image || c.saved) return;
            const at = picked.indexOf(i);
            if (at >= 0) picked.splice(at, 1);
            else if (picked.length < MAX_PICK) picked.push(i);
            else return setStatus('You can keep up to ' + MAX_PICK + '. Unpick one first.', true);
            setStatus('');
            updatePicks();
        }

        function updatePicks() {
            candidates.forEach((c, i) => {
                const n = picked.indexOf(i);
                c.el.classList.toggle('picked', n >= 0);
                c.el.dataset.pick = n >= 0 ? n + 1 : '';
            });
            const key = $('slot').value.trim();
            $('save-btn').disabled = !picked.length;
            $('save-btn').textContent = picked.length ? 'Save ' + picked.length + ' to ' + (key || '…') : 'Save selected';
            updatePreview();
        }

        // Nothing picked and no slot targeted: the Selected Icon box goes back to empty.
        function clearPicks() {
            picked = [];
            $('slot').value = '';
            setStatus('');
            slotChanged();
        }

        async function saveSelected() {
            const key = $('slot').value.trim();
            if (!KEY_RE.test(key)) return setStatus('Choose an icon slot like nav.clients (lowercase, one dot).', true);
            const chosen = picked.slice();
            try {
                const data = await api('/save', { key, images: chosen.map(i => candidates[i].image) });
                applyRegistry(data);
                chosen.forEach(i => { candidates[i].saved = true; candidates[i].el.classList.add('saved'); });
                picked = [];
                renderRegistry();
                setStatus('✅ Saved ' + data.files.length + ' to ' + key + '. Reload the web app to see it.');
            } catch (e) {
                setStatus(e.message, true);
            }
        }

        $('slot').addEventListener('input', slotChanged);
        $('swap-to').addEventListener('input', () => showPlaces($('slot').value.trim()));
        $('prompt').addEventListener('input', () => { autoPrompt = false; });
        $('registry-panel').addEventListener('scroll', closeMenus);
        window.addEventListener('resize', closeMenus);
        document.addEventListener('click', e => {
            if (!e.target.closest('#variant-menu, .variant-arrow, #usage-menu, .usage-arrow')) closeMenus();
        });

        api('/registry').then(data => {
            applyRegistry(data);
            keyed = data.keyed;
            if (!keyed) $('progress').textContent = 'Free Pollinations tier: one image at a time, about 10-40 s each. Set POLLINATIONS_KEY for faster, watermark-free icons.';
            renderRegistry();
        }).catch(e => setStatus('Could not load the icon registry: ' + e.message, true));
    </script>
</body>
</html>""".replace('%CANDIDATES%', str(CANDIDATES)).replace('%MAX_PICK%', str(MAX_PICK))


def load_registry():
    with open(REGISTRY_FILE, encoding='utf-8') as f:
        return json.loads(f.read())


def save_registry(registry):
    with open(REGISTRY_FILE, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(registry, indent=2, ensure_ascii=False) + '\n')


def parse_key(key):
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise ValueError('Icon slot must look like group.name (lowercase letters, digits, _)')
    return key.split('.')


def emoji_key(emoji):
    """The registry name for an emoji: its code points without U+FE0F, as icons.tsx reads them."""
    return '_'.join(f'{ord(c):x}' for c in emoji if c != '️')


def emoji_from_key(name):
    try:
        chars = [chr(int(h, 16)) for h in name.split('_')]
    except ValueError:
        raise ValueError(f'emoji.{name} is not a list of code points')
    # A lone character below U+10000 (☁, ✈) needs U+FE0F to be drawn as an emoji.
    return ''.join(chars) + ('️' if len(chars) == 1 and ord(chars[0]) < 0x10000 else '')


def emoji_name(emoji):
    chars = [c for c in emoji if c not in '️‍⃣' and not '\U0001F3FB' <= c <= '\U0001F3FF']
    if chars and all('\U0001F1E6' <= c <= '\U0001F1FF' for c in chars):
        return 'flag ' + ''.join(chr(ord(c) - 0x1F1E6 + ord('A')) for c in chars)
    return ' + '.join(unicodedata.name(c, '').lower() for c in chars if unicodedata.name(c, ''))


def registry_response(registry):
    """The registry plus readable labels for its emoji slots ("💬 speech balloon")."""
    labels = {}
    for name in registry.get('emoji', {}):
        try:
            emoji = emoji_from_key(name)
        except ValueError:
            continue
        labels['emoji.' + name] = (emoji + ' ' + emoji_name(emoji)).strip()
    return {'registry': registry, 'labels': labels}


def blank_out(pattern, text):
    """Removes block comments but keeps their newlines, so line numbers stay right."""
    return re.sub(pattern, lambda m: '\n' * m.group().count('\n'), text, flags=re.S)


def source_files():
    """(repo path, lines) of every file in SCAN_DIRS the scans read, block comments blanked."""
    for top in SCAN_DIRS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(REPO_DIR, top)):
            dirnames[:] = sorted(d for d in dirnames if d not in SCAN_SKIP_DIRS)
            for filename in sorted(filenames):
                path = os.path.join(dirpath, filename)
                if (not filename.endswith(SCAN_EXTS) or '.test.' in filename or 'bundle' in filename
                        or os.path.abspath(path) == os.path.abspath(REGISTRY_FILE)):
                    continue
                try:
                    with open(path, encoding='utf-8') as f:
                        text = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                if filename.endswith('.css'):
                    text = blank_out(r'/\*.*?\*/', text)
                elif filename.endswith('.html'):
                    text = blank_out(r'<!--.*?-->', text)
                yield os.path.relpath(path, REPO_DIR).replace(os.sep, '/'), text.split('\n')


def scan_emoji():
    """Every emoji in SCAN_DIRS outside comments and logging, most used first."""
    found = {}
    for rel, lines in source_files():
        for number, line in enumerate(lines, 1):
            if SCAN_SKIP_LINE.search(line):
                continue
            for m in EMOJI_RE.finditer(line):
                key = 'emoji.' + emoji_key(m.group())
                item = found.setdefault(key, {'key': key, 'emoji': m.group(), 'name': emoji_name(m.group()), 'places': []})
                if not item['places'] or item['places'][-1][:2] != [rel, number]:
                    item['places'].append([rel, number, line.strip()[:160]])
    return sorted(found.values(), key=lambda item: -len(item['places']))


def slot_patterns(group, name):
    """How the code names a slot: "group.name" as a string (<Icon name="nav.clients" />), or as
    ICONS.group.name."""
    g, n = re.escape(group), re.escape(name)
    return (re.compile(rf'''(?<=['"`:]){g}\.{n}(?![\w.])'''), re.compile(rf'(ICONS\??\.){g}(\??\.){n}\b'))


def rewrite_slot(line, old, new):
    quoted, prop = slot_patterns(*old)
    line = quoted.sub('.'.join(new), line)
    return prop.sub(lambda m: m.group(1) + new[0] + m.group(2) + new[1], line)


def rewrite_emoji(line, name, to):
    return EMOJI_RE.sub(lambda m: to if emoji_key(m.group()) == name else m.group(), line)


def find_places(group, name):
    """[file, line number] of every place in the code that uses a slot (or, for emoji.*, the emoji)."""
    if group == 'emoji':
        item = next((i for i in scan_emoji() if i['key'] == 'emoji.' + name), None)
        return [place[:2] for place in item['places']] if item else []
    patterns = slot_patterns(group, name)
    return [[rel, number] for rel, lines in source_files() for number, line in enumerate(lines, 1)
            if name in line and any(p.search(line) for p in patterns)]


def usages(key):
    """Where the code uses a slot, each place with the line above and below it."""
    places, files = [], {}
    for rel, number in find_places(*parse_key(key)):
        if rel not in files:
            with open(os.path.join(REPO_DIR, rel), encoding='utf-8') as f:
                files[rel] = f.read().split('\n')
        lines = files[rel]
        context = [[n, lines[n - 1].strip()[:200]] for n in range(max(1, number - 1), min(len(lines), number + 1) + 1)]
        places.append({'file': rel, 'line': number, 'context': context})
    return {'key': key, 'places': places}


def fetch_image(prompt, seed):
    params = {'width': GEN_SIZE, 'height': GEN_SIZE, 'seed': seed, 'nologo': 'true'}
    headers = {'User-Agent': 'Mozilla/5.0'}
    if POLLINATIONS_KEY:
        base = 'https://gen.pollinations.ai/image/'
        params['model'] = POLLINATIONS_MODEL
        headers['Authorization'] = 'Bearer ' + POLLINATIONS_KEY
    else:
        base = 'https://image.pollinations.ai/prompt/'
    url = base + urllib.parse.quote(prompt + PROMPT_SUFFIX, safe='') + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as response:
        return response.read()


def soften_edge(img, before):
    """The pixels along an erased background are a blend of the background and the icon. Gives them
    the icon's colour at a matching transparency, so no fringe of the background is left. The same
    rule as the editor's wand (floodFill in the page)."""
    w, h = img.size
    src, out = before.load(), img.load()
    erased = [[out[x, y][3] == 0 and src[x, y][3] != 0 for x in range(w)] for y in range(h)]
    for y in range(h):
        for x in range(w):
            p = src[x, y]
            if erased[y][x] or p[3] < 255:
                continue
            ys, xs = range(max(0, y - 2), min(h, y + 3)), range(max(0, x - 2), min(w, x + 3))
            bg = next((src[nx, ny] for ny in ys for nx in xs if erased[ny][nx]), None)
            if not bg:
                continue
            # The icon's colour here: the opaque pixel within 2 px that is least like the background.
            far, icon = 0, p
            for ny in ys:
                for nx in xs:
                    q = src[nx, ny]
                    if erased[ny][nx] or q[3] < 255:
                        continue
                    d = sum((q[c] - bg[c]) ** 2 for c in range(3))
                    if d > far:
                        far, icon = d, q
            if far < 256:
                continue
            # How far this pixel is from the background towards the icon's colour (0 to 1).
            alpha = max(0, sum((p[c] - bg[c]) * (icon[c] - bg[c]) for c in range(3)) / far)
            if alpha >= 0.95:
                continue
            # A pixel that is not on the line between the two colours is its own colour, not a blend.
            if sum((p[c] - bg[c] - alpha * (icon[c] - bg[c])) ** 2 for c in range(3)) > 900:
                continue
            out[x, y] = (icon[0], icon[1], icon[2], round(alpha * 255))


def make_icon(data, remove_bg, watermark=False):
    img = Image.open(io.BytesIO(data)).convert('RGBA')
    if watermark:
        # Anonymous images carry a "pollinations.ai" mark along the bottom edge. Cut that strip off,
        # then pad back to a square with the corner colour instead of cropping into the icon.
        img = img.crop((0, 0, img.width, img.height - img.height * 3 // 40))
    if img.width != img.height:
        side = max(img.width, img.height)
        square = Image.new('RGBA', (side, side), img.getpixel((0, 0)))
        square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        img = square
    img = img.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    if remove_bg:
        # Flood-fill from the corners so light areas inside the icon stay opaque.
        w, h = img.size
        before = img.copy()
        for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
            if img.getpixel(xy)[3]:
                ImageDraw.floodfill(img, xy, (0, 0, 0, 0), thresh=60)
        soften_edge(img, before)
        # Trim to the icon and re-centre it with a small margin, so nothing touches an edge.
        box = img.getchannel('A').getbbox()
        if box:
            obj = img.crop(box)
            side = int(max(obj.size) * 1.08)
            square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
            square.paste(obj, ((side - obj.width) // 2, (side - obj.height) // 2))
            img = square.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
    return img


def upload(body):
    """Turns a dropped image file into a candidate icon."""
    try:
        data = base64.b64decode(str(body.get('image', '')).split(',', 1)[1])
        img = make_icon(data, bool(body.get('removeBg', False)))
    except (IndexError, ValueError, OSError):
        raise ValueError('That file is not an image Pillow can read')
    return 200, {'image': png_data_url(img)}


def png_data_url(img):
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def decode_image(data_url):
    try:
        img = Image.open(io.BytesIO(base64.b64decode(str(data_url).split(',', 1)[1])))
        img.load()
    except (IndexError, ValueError, OSError):
        raise ValueError('One of the selected icons is not a valid image')
    return img


def generate(body):
    prompt = str(body.get('prompt', '')).strip()
    if not prompt:
        raise ValueError('Enter a prompt')
    seed = int(body.get('seed') or random.randint(1, 999999))
    try:
        data = fetch_image(prompt, seed)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return 429, {'error': 'Pollinations is still busy with an earlier image'}
        return 502, {'error': f'Pollinations returned HTTP {e.code}'}
    except OSError as e:
        return 502, {'error': f'Could not reach Pollinations: {e}'}
    try:
        img = make_icon(data, bool(body.get('removeBg', True)), watermark=not POLLINATIONS_KEY)
    except OSError:
        return 502, {'error': 'Pollinations did not return an image'}
    return 200, {'image': png_data_url(img)}


def save(body):
    """Saves 1-4 picked icons for a slot. The first becomes the slot's icon; all are added to its variants."""
    group, name = parse_key(body.get('key'))
    images = body.get('images') or []
    if not 1 <= len(images) <= MAX_PICK:
        raise ValueError(f'Pick 1 to {MAX_PICK} icons')
    images = [decode_image(i) for i in images]
    os.makedirs(ICONS_DIR, exist_ok=True)
    with REGISTRY_LOCK:
        registry = load_registry()
        slots = registry.setdefault(group, {})
        entry = slots.get(name) or {}
        variants = list(entry.get('variants') or [])
        if not variants and entry.get('value'):
            # Keep the icon being replaced so it can be swapped back.
            variants.append({'type': entry.get('type', 'image'), 'value': entry['value']})
        elif not variants and group == 'emoji':
            # A new emoji slot starts with the emoji itself, so it can be swapped back.
            variants.append({'type': 'emoji', 'value': emoji_from_key(name)})
        paths, n = [], 1
        for img in images:
            while os.path.exists(os.path.join(ICONS_DIR, f'{group}_{name}_{n}_icon.png')):
                n += 1
            filename = f'{group}_{name}_{n}_icon.png'
            img.save(os.path.join(ICONS_DIR, filename), format='PNG')
            paths.append('icons/' + filename)
        variants += [{'type': 'image', 'value': p} for p in paths]
        entry.update(type='image', value=paths[0], variants=variants)
        slots[name] = entry
        save_registry(registry)
    return 200, {**registry_response(registry), 'files': [os.path.basename(p) for p in paths]}


def set_active(body):
    group, name = parse_key(body.get('key'))
    value = body.get('value')
    with REGISTRY_LOCK:
        registry = load_registry()
        entry = registry.get(group, {}).get(name) or {}
        variant = next((v for v in entry.get('variants', []) if v.get('value') == value), None)
        if not variant:
            raise ValueError(f'{group}.{name} has no saved icon {value}')
        entry['type'], entry['value'] = variant['type'], variant['value']
        save_registry(registry)
    return 200, registry_response(registry)


def keep_emoji(body):
    """Marks a found emoji as fine as it is, so it leaves the Needs icon list."""
    group, name = parse_key(body.get('key'))
    if group != 'emoji':
        raise ValueError('Only emoji.* slots can be kept as emoji')
    emoji = emoji_from_key(name)
    with REGISTRY_LOCK:
        registry = load_registry()
        registry.setdefault('emoji', {}).setdefault(name, {'type': 'emoji', 'value': emoji})
        save_registry(registry)
    return 200, registry_response(registry)


def scanned_file(rel):
    """The full path of a file "Find emoji" reads, so only those can be rewritten."""
    path = os.path.realpath(os.path.join(REPO_DIR, str(rel)))
    tops = [os.path.realpath(os.path.join(REPO_DIR, top)) + os.sep for top in SCAN_DIRS]
    if (not path.startswith(tuple(tops)) or not path.endswith(SCAN_EXTS) or not os.path.isfile(path)
            or path == os.path.realpath(REGISTRY_FILE)):
        raise ValueError(f'{rel} is not a file the emoji scan covers')
    return path


def rewrite_lines(by_file, rewrite):
    """Runs rewrite(line) on the given line numbers of each file. Returns how many lines changed and
    how many did not (the file changed since it was scanned)."""
    changed = skipped = 0
    for path, numbers in by_file.items():
        # newline='' keeps the file's own line endings.
        with open(path, encoding='utf-8', newline='') as f:
            lines = f.read().split('\n')
        before = changed
        for number in numbers:
            old = lines[number - 1] if 1 <= number <= len(lines) else ''
            new = rewrite(old)
            if new == old:
                skipped += 1
            else:
                lines[number - 1] = new
                changed += 1
        if changed > before:
            with open(path, 'w', encoding='utf-8', newline='') as f:
                f.write('\n'.join(lines))
    return changed, skipped


def swap_emoji(body):
    """Changes an emoji to another one on the picked source lines, so those places get the other emoji's icon."""
    group, name = parse_key(body.get('key'))
    if group != 'emoji':
        raise ValueError('Only emoji.* slots can be changed in the code')
    to = str(body.get('to', '')).strip()
    if not EMOJI_RE.fullmatch(to):
        raise ValueError('Enter one emoji to use in the ticked places')
    if emoji_key(to) == name:
        raise ValueError('That is the emoji those places already use')
    by_file = {}
    for place in body.get('places') or []:
        try:
            rel, number = place[0], int(place[1])
        except (TypeError, ValueError, IndexError, KeyError):
            raise ValueError('Places must be [file, line] pairs')
        by_file.setdefault(scanned_file(rel), set()).add(number)
    if not by_file:
        raise ValueError('Tick at least one place')
    changed, skipped = rewrite_lines(by_file, lambda line: rewrite_emoji(line, name, to))
    if not changed:
        raise ValueError('Those lines no longer have that emoji. Run "Find emoji to replace" again.')
    return 200, {**registry_response(load_registry()), 'emoji': scan_emoji(), 'to_key': 'emoji.' + emoji_key(to),
                 'changed': changed, 'skipped': skipped}


def split(body):
    """Gives one place in the code its own slot: a copy of the slot it used, under a new name."""
    group, name = parse_key(body.get('key'))
    try:
        rel, number = str(body['file']), int(body['line'])
    except (KeyError, TypeError, ValueError):
        raise ValueError('Split needs a file and a line')
    if group == 'emoji':
        # An emoji is its own name, so the place changes to another emoji, which has its own icon.
        status, result = swap_emoji({'key': body.get('key'), 'to': body.get('to') or '', 'places': [[rel, number]]})
        return status, {**result, 'new_key': result['to_key']}
    path = scanned_file(rel)
    with REGISTRY_LOCK:
        registry = load_registry()
        slots = registry.get(group, {})
        if name not in slots:
            raise ValueError(f'There is no slot {group}.{name}')
        n = 2
        while f'{name}_{n}' in slots:
            n += 1
        new = f'{name}_{n}'
        changed, _ = rewrite_lines({path: {number}}, lambda line: rewrite_slot(line, (group, name), (group, new)))
        if not changed:
            raise ValueError(f'That line no longer uses {group}.{name}. Open the list again.')
        # The copy goes right after the slot it came from.
        registry[group] = {k: v for old, entry in slots.items()
                           for k, v in ([(old, entry), (new, copy.deepcopy(entry))] if old == name else [(old, entry)])}
        save_registry(registry)
    return 200, {**registry_response(registry), 'new_key': f'{group}.{new}'}


def share_icon(src, dst, keep_src):
    """An emoji and a named slot cannot become one slot (the code names them in different ways), so
    dropping one on the other gives both the same icon and each other's saved icons."""
    named, emo = (src, dst) if dst[0] == 'emoji' else (dst, src)
    own = {'type': 'emoji', 'value': emoji_from_key(emo[1])}
    plain = lambda entry: [{'type': v['type'], 'value': v['value']} for v in entry.get('variants') or [entry]]
    with REGISTRY_LOCK:
        registry = load_registry()
        slot = registry.get(named[0], {}).get(named[1])
        if not slot:
            raise ValueError(f'There is no slot {".".join(named)}')
        emoji = registry.setdefault('emoji', {}).get(emo[1]) or dict(own)
        active = plain({k: v for k, v in (slot if (src == named) == keep_src else emoji).items() if k != 'variants'})[0]
        if active['type'] == 'emoji' and active != own:
            raise ValueError(f'{own["value"]} in the code can only show itself or an image. Keep the other icon.')
        slot_icons, emoji_icons = plain(slot), plain(emoji)
        if own not in emoji_icons:
            emoji_icons.insert(0, own)
        for v in plain(slot):
            if v['type'] == 'image' and v not in emoji_icons:
                emoji_icons.append(v)
        for v in emoji_icons:
            if v not in slot_icons:
                slot_icons.append(v)
        slot.update(active, variants=slot_icons)
        emoji.update(active, variants=emoji_icons)
        registry['emoji'][emo[1]] = emoji
        save_registry(registry)
    return 200, {**registry_response(registry), 'key': '.'.join(dst), 'changed': 0}


def merge(body):
    """Merges slot "from" into slot "into": every place in the code that used the first uses the
    second, their saved icons become one list, and "keep" says whose icon the merged slot shows."""
    src, dst = parse_key(body.get('from')), parse_key(body.get('into'))
    is_emoji = src[0] == 'emoji'
    if src == dst:
        raise ValueError('Drop the icon on a different one to merge them')
    if is_emoji != (dst[0] == 'emoji'):
        return share_icon(src, dst, body.get('keep') == 'from')
    own = lambda key: {'type': 'emoji', 'value': emoji_from_key(key[1])}
    with REGISTRY_LOCK:
        registry = load_registry()
        a, b = (registry.get(group, {}).get(name) for group, name in (src, dst))
        if not is_emoji and not (a and b):
            raise ValueError(f'There is no slot {".".join(dst if a else src)}')
        if is_emoji and body.get('keep') == 'from' and (a or own(src))['type'] == 'emoji':
            # Keeping the dragged emoji as an emoji: it is the one the code goes on using.
            src, dst, a, b = dst, src, b, a
            active = own(dst)
        else:
            active = (a or own(src)) if body.get('keep') == 'from' else (b or own(dst))
        variants = [own(dst)] if is_emoji else []
        for key, entry in ((dst, b), (src, a)):
            for v in (entry or {}).get('variants') or ([entry] if entry else []):
                v = {'type': v['type'], 'value': v['value']}
                # The emoji that goes away cannot be swapped back to.
                if v not in variants and not (is_emoji and v['type'] == 'emoji'):
                    variants.append(v)
        by_file = {}
        for rel, number in find_places(*src):
            by_file.setdefault(scanned_file(rel), set()).add(number)
        if is_emoji:
            to = emoji_from_key(dst[1])
            changed, _ = rewrite_lines(by_file, lambda line: rewrite_emoji(line, src[1], to))
        else:
            changed, _ = rewrite_lines(by_file, lambda line: rewrite_slot(line, src, dst))
        if a or b:
            merged = dict(b or {})
            merged.update(type=active['type'], value=active['value'])
            if len(variants) > 1 or 'variants' in merged:
                merged['variants'] = variants
            registry.setdefault(dst[0], {})[dst[1]] = merged
            registry.get(src[0], {}).pop(src[1], None)
            save_registry(registry)
    result = {**registry_response(registry), 'key': '.'.join(dst), 'changed': changed}
    if is_emoji:
        result['emoji'] = scan_emoji()
    return 200, result


POST_ROUTES = {'/generate': generate, '/save': save, '/set_active': set_active, '/keep_emoji': keep_emoji, '/upload': upload,
               '/swap_emoji': swap_emoji, '/split': split, '/merge': merge}


class StudioHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_body(self, status, content_type, body):
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the page aborted the request (Stop)

    def send_json(self, status, obj):
        self.send_body(status, 'application/json', json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path in ('/', '/studio'):
            self.send_body(200, 'text/html; charset=utf-8', HTML_DASHBOARD.encode('utf-8'))
        elif path == '/registry':
            self.send_json(200, {**registry_response(load_registry()), 'keyed': bool(POLLINATIONS_KEY)})
        elif path == '/scan_emoji':
            self.send_json(200, {'emoji': scan_emoji()})
        elif path == '/usages':
            try:
                self.send_json(200, usages(urllib.parse.parse_qs(url.query).get('key', [''])[0]))
            except ValueError as e:
                self.send_json(400, {'error': str(e)})
        elif path.startswith('/icons/'):
            file_path = os.path.realpath(os.path.join(PUBLIC_DIR, path.lstrip('/')))
            if file_path.startswith(os.path.realpath(ICONS_DIR) + os.sep) and os.path.isfile(file_path):
                with open(file_path, 'rb') as f:
                    self.send_body(200, mimetypes.guess_type(file_path)[0] or 'application/octet-stream', f.read())
            else:
                self.send_json(404, {'error': 'Not found'})
        else:
            self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        route = POST_ROUTES.get(urllib.parse.urlsplit(self.path).path)
        if not route:
            return self.send_json(404, {'error': 'Not found'})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            status, result = route(body)
        except ValueError as e:
            status, result = 400, {'error': str(e)}
        self.send_json(status, result)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('', PORT), StudioHandler)
    print(f"🎨 acct Icon Studio running at http://localhost:{PORT}")
    if not POLLINATIONS_KEY:
        print('   Free Pollinations tier: one image at a time. Set POLLINATIONS_KEY for faster, watermark-free icons.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
