"""The icon registry file: reading it, writing it, and the changes that touch only it."""
import json, os, re, threading, unicodedata
from config import ICONS_DIR, REGISTRY_FILE, REGISTRY_VARIABLE, WEB_ROOT
from images import decode_image

REGISTRY_LOCK = threading.Lock()
KEY_RE = re.compile(r'^[a-z0-9_]+\.[a-z0-9_]+$')
MAX_PICK = 24


def load_registry():
    with open(REGISTRY_FILE, encoding='utf-8') as f:
        text = f.read()
    # A .json registry is plain JSON; a .js one sets REGISTRY_VARIABLE to a JSON object.
    return json.loads(text if REGISTRY_FILE.endswith('.json') else text.split('=', 1)[1].strip().rstrip(';'))


def save_registry(registry):
    with open(REGISTRY_FILE, 'w', encoding='utf-8', newline='\n') as f:
        if REGISTRY_FILE.endswith('.json'):
            f.write(json.dumps(registry, indent=2, ensure_ascii=False) + '\n')
        else:
            # Same layout as JSON.stringify(x, null, 4).
            f.write(REGISTRY_VARIABLE + ' = ' + json.dumps(registry, indent=4, ensure_ascii=False) + ';\n')


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
            paths.append(os.path.relpath(os.path.join(ICONS_DIR, filename), WEB_ROOT).replace(os.sep, '/'))
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
