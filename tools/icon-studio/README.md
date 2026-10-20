# Icon Studio

A local-only tool for giving the web app's icon slots real images. Run `make icons` (or
`tools/icon-studio/icon_studio.sh`) and open <http://localhost:8081>. It needs Python 3.8+ and Pillow;
the script installs Pillow if it is missing.

## How it fits the web app

- **Slots** are names like `nav.clients` (`group.name`, lowercase). The registry,
  `apps/web/src/icons/registry.json`, says what each slot shows: an emoji, or an image.
- **Images** are saved to `apps/web/public/icons/` and served at `/icons/...` by Vite and by the acct server.
- **In code**, use `<Icon name="nav.clients" />` for a slot, or `<Emoji>💬</Emoji>` for an emoji the studio can
  swap for an image (`apps/web/src/lib/icons.tsx`). Both are decorative (`aria-hidden`), so always keep a text label.
- **Studio features:** generate 16 candidates from a prompt (or drop your own files), keep up to 4 per slot with
  swappable variants, edit pixels (wand, crop, recolor ...), merge slots, and "Find emoji to replace", which scans
  `apps/web/src` for emoji and rewrites the code you tick.

## Rules

- The registry and `public/icons/` are written only by this tool. Edit them by hand only to remove a slot.
- Candidates come from Pollinations (a public image service). Prompts go over the network, so describe the icon
  only: **never put client data in a prompt** (CLAUDE.md hard rule 1). Set `POLLINATIONS_KEY` for no watermark.
- Make our own icons (CLAUDE.md hard rule 3): don't ask for, or drop in, MYOB's icons or UI assets.
