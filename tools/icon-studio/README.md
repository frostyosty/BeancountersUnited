# Icon Studio

Local-only tool for giving the web app's icon slots real images. Run `make icons` (or `./icon_studio.sh` at the
repo root) and open <http://localhost:8081>. Needs Python 3.8+ and Pillow (the script installs it).

## How it fits the web app

- The registry is `apps/web/src/icons/registry.json`; saved images go to `apps/web/public/icons/` (served at `/icons/`).
  `config.json` points the studio at both. Only this tool writes them; edit by hand only to remove a slot.
- In code use `<Icon name="nav.clients" />` for a slot or `<Emoji>💬</Emoji>` for a swappable emoji
  (`apps/web/src/lib/icons.tsx`). Keep a text label beside every icon.
- Add images by dragging files onto the studio; they wait in the gitignored `tray/` until assigned to a slot.
  There is no prompt generator here any more. Make images elsewhere (CLAUDE.md hard rule 3: our own icons, no MYOB
  assets; never put client data in a prompt).
- Also: pixel editor (wand, crop, recolour, ...), up to 4 swappable variants per slot, split and merge slots,
  and "Find emoji to replace", which scans `apps/web/src` and rewrites the code you tick.

## The registry

A JS file that sets a variable to a JSON object, written the way `JSON.stringify(x, null, 4)` does:

```js
window.OS_ICON_REGISTRY = {
    "emoji": {
        "1f680": { "type": "image", "value": "assets/icons/emoji_1f680_1_icon.png", "variants": [...] }
    }
};
```

- `emoji.<code points>`: an emoji given an image. The key is the emoji's code points in hex,
  joined by `_`, without U+FE0F (`1f4ac` for 💬).
- `<group>.<name>`: a named slot (`taskbar.network`) that the code looks up itself.
- `type` is `emoji` or `image`; `value` is the emoji, or an image path relative to the web root.
- `variants` lists every saved icon of a slot, so the page can swap between them.

## Showing the images

The studio only edits the registry and the PNGs. The codebase has to show them. For emoji,
`icon_swap.js` does it: it replaces the emoji in text with the saved image, including text added
later. Load it after the registry, on every page that should show the images:

```html
<script src="icon_registry.js"></script>
<script src="icon_swap.js"></script>
```

- If the variable isn't `window.OS_ICON_REGISTRY`, name it: `data-registry="window.MyIcons"`.
- Keep the script in the web root, or anywhere else as long as the registry's image paths are
  relative to the script's folder. It works from a page in any folder.
- Emoji in attributes (`title`, `placeholder`), `<option>`s and `<textarea>`s stay emoji.
  `data-keep-emoji` on an element leaves it alone.
- Named slots are looked up by the codebase's own code. In logOS that is `icon_manager.js`
  (`data-os-icon="taskbar.network"`).

## config.json

Paths are relative to the codebase, which is itself relative to this folder.

| Key | Meaning |
| --- | --- |
| `port` | the port the studio listens on |
| `codebase` | the codebase folder |
| `registry` | the registry file |
| `registry_variable` | the variable the registry file sets |
| `web_root` | the folder the registry's image paths are relative to |
| `icons_dir` | where saved icons go (inside `web_root`) |
| `scan.dirs` | the folders "Find emoji" reads |
| `scan.extensions` | the file types it reads |
| `scan.skip_dirs` | folders it skips (this folder is always skipped) |

## Files

- `server.py`, `config.py`, `registry.py`, `images.py`, `tray.py`, `codebase.py`: the server.
  `codebase.py` is the part that reads and rewrites the codebase's source.
- `walkthrough.py` and `page/setup.html`: the first-run walkthrough.
- `page/index.html`, `page/studio.css` and `page/js/`: the studio page.
- `icon_swap.js`: the script for other codebases.
- `tray/`: images dropped into the tray, kept until assigned. Not for version control.
