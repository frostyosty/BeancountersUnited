"""Reading and rewriting the codebase's source: "Find emoji", where a slot is used, and the
changes that rewrite code (swap, split, merge)."""
import copy, os, re
from config import REGISTRY_FILE, REGISTRY_VARIABLE, REPO_DIR, SCAN_DIRS, SCAN_EXTS, SCAN_SKIP_DIRS
from registry import REGISTRY_LOCK, emoji_from_key, emoji_key, emoji_name, load_registry, parse_key, registry_response, save_registry

# "Find emoji" scans SCAN_DIRS for emoji the UI shows. An image saved for one goes in the registry's
# "emoji" group (emoji.1f4ac for 💬), and the codebase swaps it in (here <Emoji> in apps/web/src/lib/icons.tsx).
# Colour-emoji characters (Emoji_Presentation) below U+10000; other symbols there (✕ ▾ ⚙) are
# plain text glyphs unless U+FE0F follows them.
_EMOJI_BMP = '⌚⌛⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕'
_TEXT_SYMBOLS = '©®‼⁉™ℹ↔-⇿⌀-⏿Ⓜ■-◿☀-➿⤀-⥿⬀-⯿〰〽㊗㊙'
_EMOJI_ATOM = f'(?:[\U0001F000-\U0001FAFF{_EMOJI_BMP}]️?|[{_TEXT_SYMBOLS}]️)[\U0001F3FB-\U0001F3FF]?'
EMOJI_RE = re.compile(f'[\U0001F1E6-\U0001F1FF]{{2}}|[0-9#*]️?⃣|{_EMOJI_ATOM}(?:‍{_EMOJI_ATOM})*')
# Lines the user never sees: logging and comments.
SCAN_SKIP_LINE = re.compile(r'^\s*(//|/\*|\*|<!--)|console\.\w+\(|\b(e?println|print|info|warn|error|debug|trace)!\(|log::\w+!|\bLog\.[dewiv]\(')
REGISTRY_NAME = re.escape(REGISTRY_VARIABLE.split('.')[-1])


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
                if (not filename.endswith(SCAN_EXTS) or filename.endswith('.min.js') or 'bundle' in filename
                        or os.path.abspath(path) == os.path.abspath(REGISTRY_FILE)):
                    continue
                try:
                    with open(path, encoding='utf-8') as f:
                        text = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                if filename.endswith(('.rs', '.css', '.kt')):
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
    """How the code names a slot: "group.name" as a string (data-os-icon="system.network",
    'os:apps.browser', "os-icon:..."), or as OS_ICON_REGISTRY.group.name (the registry variable)."""
    g, n = re.escape(group), re.escape(name)
    return (re.compile(rf'''(?<=['"`:]){g}\.{n}(?![\w.])'''), re.compile(rf'({REGISTRY_NAME}\??\.){g}(\??\.){n}\b'))


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
