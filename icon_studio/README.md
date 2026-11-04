# Icon Studio

Makes icons for the emoji and named slots a codebase shows, and keeps them in an icon registry.
It runs on its own: a small Python server (needs Python 3.8+ and Pillow) and a page.

## Using it in another codebase

1. Copy this folder into the codebase. Leave out `config.json` and `tray/` if they came with it.
2. Start it: `python icon_studio/server.py` (in logOS, `./icon_studio.sh` from the repository root).
3. Open the address it prints. With no usable `config.json` the first-run walkthrough opens.
4. Answer the walkthrough:
   - the codebase folder (the default is the folder this one sits in);
   - the icon registry: a file it found, or a new `icon_registry.js` it makes;
   - the web root (the folder the registry's image paths are relative to) and the folder saved icons go in;
   - the folders to scan for emoji and the file types to read;
   - whether to copy `icon_swap.js` into the web root.
5. Save. The studio starts at once, and `config.json` is written next to this file.

To run the walkthrough again, open `/setup` (the studio needs a restart afterwards) or delete
`config.json`. A `config.json` whose registry file doesn't exist also starts the walkthrough.

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
