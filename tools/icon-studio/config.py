"""Where the codebase the studio works on keeps its icons, read from config.json.

codebase is relative to this folder; every other path is relative to codebase.
- registry: the file holding the icon registry, a JS file that sets registry_variable to a JSON object.
- web_root: the folder the registry's image paths are relative to.
- icons_dir: where saved icons go (inside web_root).
- scan: the folders and file types "Find emoji" reads, and the folders it skips.

CONFIGURED is False while config.json is missing or points at a registry that does not exist; the
server then runs the first-run walkthrough (setup.py) and writes config.json.
"""
import json, os

STUDIO_DIR = os.path.dirname(os.path.abspath(__file__))
PAGE_DIR = os.path.join(STUDIO_DIR, 'page')
CONFIG_FILE = os.path.join(STUDIO_DIR, 'config.json')
DEFAULT_SKIP_DIRS = ['node_modules', 'vendor', 'target', 'gen', 'dist', 'build', '.git']


def _read():
    try:
        with open(CONFIG_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


_config = _read()
_scan = _config.get('scan', {})

PORT = int(_config.get('port', 8081))
REPO_DIR = os.path.normpath(os.path.join(STUDIO_DIR, _config.get('codebase', '..')))


def _path(rel):
    return os.path.normpath(os.path.join(REPO_DIR, rel))


REGISTRY_FILE = _path(_config.get('registry', 'icon_registry.js'))
REGISTRY_VARIABLE = _config.get('registry_variable', 'window.OS_ICON_REGISTRY')
WEB_ROOT = _path(_config.get('web_root', '.'))
ICONS_DIR = _path(_config.get('icons_dir', 'assets/icons'))
SCAN_DIRS = [d.replace('\\', '/').strip('/') or '.' for d in _scan.get('dirs', [])]
SCAN_EXTS = tuple(_scan.get('extensions', []))
# The studio's own folder is never scanned, even when it sits inside a scanned folder.
SCAN_SKIP_DIRS = set(_scan.get('skip_dirs', DEFAULT_SKIP_DIRS)) | {os.path.basename(STUDIO_DIR)}
CONFIGURED = os.path.isfile(REGISTRY_FILE) and bool(SCAN_DIRS) and bool(SCAN_EXTS)
# Scan paths are shown without the folder all scanned folders share ("app-tauri-browser/").
_shared = os.path.commonpath(SCAN_DIRS).replace(os.sep, '/') if SCAN_DIRS else ''
SHORT_PREFIX = _shared + '/' if _shared not in ('', '.') else ''
