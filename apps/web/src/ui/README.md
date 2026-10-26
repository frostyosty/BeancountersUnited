# ui/ — the app's building blocks

One folder per component (`Name.tsx`, `Name.module.css`, `index.ts`). Import from the barrel:

```tsx
import { Button, Card, ConfirmDialog, PageHeader } from "../ui";
```

## The layers

| Where | What lives there |
| --- | --- |
| `styles/tokens.css` | Every colour, size, radius and shadow, each colour a `light-dark()` pair. **The only place raw hex belongs.** |
| `styles/base.css` | Element defaults: type, links, focus rings. |
| `styles/controls.css` | Buttons, inputs and `.table`. Plain markup and the components here share these. |
| `styles/utilities.css` | The older shared class names (`field`, `row`, `card`, `muted`, `crumbs`, `facts`…). |
| `ui/*` | Components. |
| `*.module.css` beside a page | Layout specific to that page, in tokens. |

## Rules of thumb

- **Every app page starts with `<PageHeader>`**: crumbs, title, an optional badge, actions.
- **Buttons:** `<Button variant="primary|secondary|ghost|danger" size="sm">`, or `<ButtonLink to=…>` for navigation.
  `busy` shows a spinner and disables the button while a command is in flight. Plain `<button className="primary">`
  looks identical, but new code uses `<Button>`.
- **Every modal is `<Modal>`, and every "are you sure?" is `<ConfirmDialog>` or `useConfirm()`.** Never use
  `window.confirm` or a hand-rolled overlay. Pass `busy` while the command runs. Close the dialog in `onSettled`,
  so a failure shows on the page rather than behind the backdrop.
- **Status:** use `<Badge tone=…>` for a word, `<Notice tone=…>` for a sentence, and `<EmptyState>` for an empty list.
- **Colours:** use tokens only (`var(--accent)`, `var(--warn-soft)`…), so dark mode and the `.env` theme reach the
  new screen for free. Missing a colour? Add a token, with both its light and dark values.
- **Icons:** use `<Icon name="group.slot" fallback="🧾" />` next to a text label, and add the slot to
  `icons/registry.json` (see CLAUDE.md).
- **Accounting output stays plain:** statements render as paper (`color-scheme: light`) in both themes, with no emoji.

## Dark mode

`<ThemeToggle>` cycles Auto → Light → Dark and sets `data-theme` on `<html>` (`lib/theme.ts`). Its choice is kept in
`localStorage`, as a per-browser convenience. `tokens.css` does everything else.
