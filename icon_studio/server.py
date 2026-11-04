"""Icon Studio's server: the page in page/, the codebase's icons, and the routes that change them."""
import json, mimetypes, os, sys, urllib.parse
sys.dont_write_bytecode = True  # no __pycache__ in a folder meant to be copied into other codebases
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
try:
    import PIL  # noqa: F401
except ImportError:
    print('PIL is missing. Please run: pip install Pillow')
    exit(1)

import importlib
import config
import walkthrough
from config import PAGE_DIR, PORT

# The studio's own routes need a configured codebase, so they are loaded once config.json is there:
# at start, or right after the walkthrough writes it.
SETUP_ROUTES = {'/setup/detect': lambda body: (200, walkthrough.detect(body))}
POST_ROUTES = {}
STUDIO_GET = ('/registry', '/tray', '/scan_emoji', '/usages')
# The codebase's own images (the registry's paths, under web_root) are served under this prefix.
APP_PREFIX = '/app/'


def load_studio():
    global POST_ROUTES, SHORT_PREFIX, WEB_ROOT, MAX_PICK, scan_emoji, usages, tray, load_registry, registry_response
    from config import SHORT_PREFIX, WEB_ROOT
    from codebase import merge, scan_emoji, split, swap_emoji, usages
    import tray
    from registry import MAX_PICK, keep_emoji, load_registry, registry_response, save, set_active
    POST_ROUTES = {'/save': save, '/set_active': set_active, '/keep_emoji': keep_emoji,
                   '/swap_emoji': swap_emoji, '/split': split, '/merge': merge,
                   '/tray_add': tray.add, '/tray_edit': tray.edit, '/tray_remove': tray.remove}


def save_setup(body):
    """Writes config.json. On first run the studio starts at once; after that it needs a restart."""
    first_run = not config.CONFIGURED
    result = walkthrough.save(body)
    if first_run:
        importlib.reload(config)
        load_studio()
    result['restart'] = not first_run
    return 200, result


SETUP_ROUTES['/setup/save'] = save_setup


def inside(root, rel):
    """The full path of rel inside root, or None when it is outside or not a file."""
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, rel))
    return path if path.startswith(root + os.sep) and os.path.isfile(path) else None


def page_file(path):
    """The page file for a URL path: the walkthrough until the studio is set up."""
    if path == '/setup' or (path in ('/', '/studio') and not config.CONFIGURED):
        return 'setup.html'
    return 'index.html' if path in ('/', '/studio') else path.lstrip('/')


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
            pass  # the page went away before the answer

    def send_json(self, status, obj):
        self.send_body(status, 'application/json', json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def send_file(self, path):
        with open(path, 'rb') as f:
            body = f.read()
        kind = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if kind.startswith('text/') or kind.endswith('javascript'):
            kind += '; charset=utf-8'
        self.send_body(200, kind, body)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        if path == '/setup/state':
            self.send_json(200, walkthrough.state())
        elif not config.CONFIGURED and (path in STUDIO_GET or path.startswith(APP_PREFIX)):
            self.send_json(409, {'error': 'Icon Studio is not set up for a codebase yet'})
        elif path == '/registry':
            self.send_json(200, {**registry_response(load_registry()), 'maxPick': MAX_PICK, 'shortPrefix': SHORT_PREFIX})
        elif path == '/tray':
            self.send_json(*tray.list_tray())
        elif path == '/scan_emoji':
            self.send_json(200, {'emoji': scan_emoji()})
        elif path == '/usages':
            try:
                self.send_json(200, usages(urllib.parse.parse_qs(url.query).get('key', [''])[0]))
            except ValueError as e:
                self.send_json(400, {'error': str(e)})
        elif path.startswith(APP_PREFIX):
            # Only images: the registry points at them, and nothing else of the codebase is needed.
            file_path = inside(WEB_ROOT, path[len(APP_PREFIX):])
            if file_path and (mimetypes.guess_type(file_path)[0] or '').startswith('image/'):
                self.send_file(file_path)
            else:
                self.send_json(404, {'error': 'Not found'})
        else:
            file_path = inside(PAGE_DIR, page_file(path))
            if file_path:
                self.send_file(file_path)
            else:
                self.send_json(404, {'error': 'Not found'})

    def do_POST(self):
        route_path = urllib.parse.urlsplit(self.path).path
        route = SETUP_ROUTES.get(route_path) or (POST_ROUTES.get(route_path) if config.CONFIGURED else None)
        if not route:
            return self.send_json(404, {'error': 'Not found'})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            status, result = route(body)
        except ValueError as e:
            status, result = 400, {'error': str(e)}
        self.send_json(status, result)


if __name__ == '__main__':
    # Windows' registry can map .js to text/plain, which browsers refuse to run as a script.
    mimetypes.add_type('text/javascript', '.js')
    mimetypes.add_type('text/css', '.css')
    if config.CONFIGURED:
        load_studio()
    else:
        print('First run: open the page to tell Icon Studio where your codebase keeps its icons.')
    server = ThreadingHTTPServer(('', PORT), StudioHandler)
    print(f"🎨 logOS Icon Studio running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
