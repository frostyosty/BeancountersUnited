"""The drop tray: dropped images are kept in the studio's own folder (tray/) until they are assigned."""
import base64, json, os, threading, time
from config import STUDIO_DIR
from images import decode_image, make_icon, png_data_url

TRAY_DIR = os.path.join(STUDIO_DIR, 'tray')
INDEX_FILE = os.path.join(TRAY_DIR, 'index.json')
TRAY_LOCK = threading.Lock()


def load_index():
    try:
        with open(INDEX_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return []


def save_index(items):
    os.makedirs(TRAY_DIR, exist_ok=True)
    with open(INDEX_FILE, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False, indent=1)


def image_path(item_id):
    return os.path.join(TRAY_DIR, item_id + '.png')


def read_item(item):
    with open(image_path(item['id']), 'rb') as f:
        return {'id': item['id'], 'name': item.get('name', ''),
                'image': 'data:image/png;base64,' + base64.b64encode(f.read()).decode('ascii')}


def list_tray():
    """Everything in the tray, oldest first. An entry whose file has gone is dropped."""
    with TRAY_LOCK:
        items = load_index()
        kept, out = [], []
        for item in items:
            try:
                out.append(read_item(item))
                kept.append(item)
            except OSError:
                pass
        if len(kept) != len(items):
            save_index(kept)
    return 200, {'items': out}


def add(body):
    """Turns a dropped image file into an icon and keeps it in the tray."""
    try:
        data = base64.b64decode(str(body.get('image', '')).split(',', 1)[1])
        img = make_icon(data, bool(body.get('removeBg', False)))
    except (IndexError, ValueError, OSError):
        raise ValueError('That file is not an image Pillow can read')
    with TRAY_LOCK:
        os.makedirs(TRAY_DIR, exist_ok=True)
        item_id = f'{time.time_ns():x}'
        img.save(image_path(item_id), format='PNG')
        items = load_index()
        items.append({'id': item_id, 'name': str(body.get('name', ''))[:200]})
        save_index(items)
    return 200, {'id': item_id, 'image': png_data_url(img)}


def edit(body):
    """Replaces a tray image with its edited version."""
    item_id = str(body.get('id', ''))
    img = decode_image(body.get('image'))
    with TRAY_LOCK:
        if not any(i['id'] == item_id for i in load_index()):
            raise ValueError('That image is no longer in the tray')
        img.save(image_path(item_id), format='PNG')
    return 200, {}


def remove(body):
    """Takes the images with these ids out of the tray (assigned, or thrown away)."""
    ids = {str(i) for i in body.get('ids') or []}
    with TRAY_LOCK:
        items = load_index()
        for item in items:
            if item['id'] in ids:
                try:
                    os.remove(image_path(item['id']))
                except OSError:
                    pass
        save_index([i for i in items if i['id'] not in ids])
    return 200, {}
