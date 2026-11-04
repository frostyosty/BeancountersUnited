"""Turns dropped image files into square icons."""
import base64, io
from PIL import Image, ImageDraw

ICON_SIZE = 256


def soften_edge(img, before):
    """The pixels along an erased background are a blend of the background and the icon. Gives them
    the icon's colour at a matching transparency, so no fringe of the background is left. The same
    rule as the editor's eraseArea (page/js/selection.js)."""
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


def make_icon(data, remove_bg):
    img = Image.open(io.BytesIO(data)).convert('RGBA')
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
