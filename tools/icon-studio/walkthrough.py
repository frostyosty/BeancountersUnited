"""The first-run walkthrough: finds how a codebase keeps its icons and writes config.json."""
import json, os, re, shutil
import config

VARIABLE_RE = re.compile(r'^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$')
ASSIGN_RE = re.compile(r'^\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*\{', re.M)
CODE_EXTS = ['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.css', '.scss', '.json',
             '.rs', '.kt', '.java', '.swift', '.py', '.php', '.rb', '.go', '.cs', '.csv']
ICON_DIR_NAMES = ('icons', 'icon', 'emoji', 'emoticons', 'img', 'images')
MAX_FILES = 20000
SWAP_FILE = 'icon_swap.js'


def find_codebase(raw):
    path = os.path.abspath(os.path.expanduser(str(raw or '').strip())) if str(raw or '').strip() else config.REPO_DIR
    if not os.path.isdir(path):
        raise ValueError(f'{path} is not a folder')
    return path


def inside(root, rel, what):
    """The full path of rel inside root; rel must be a relative path that stays there."""
    rel = str(rel or '').replace('\\', '/').strip()
    if not rel or os.path.isabs(rel) or re.match(r'^[A-Za-z]:', rel):
        raise ValueError(f'{what} must be a path inside the codebase')
    path = os.path.normpath(os.path.join(root, rel))
    if path != root and not path.startswith(root + os.sep):
        raise ValueError(f'{what} must be inside the codebase')
    return path


def read_registry_variable(path):
    """The variable a JS file sets to a JSON object, or None when the file is not an icon registry."""
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read()
        match = ASSIGN_RE.search(text)
        if not match:
            return None
        json.loads(text.split('=', 1)[1].strip().rstrip(';'))
        return match.group(1)
    except (OSError, UnicodeDecodeError, ValueError, IndexError):
        return None


def detect(body):
    """What the walkthrough offers for a codebase: registry files, icon folders, folders to scan, file types."""
    root = find_codebase(body.get('codebase'))
    skip = set(config.DEFAULT_SKIP_DIRS) | {os.path.basename(config.STUDIO_DIR)}
    registries, icon_dirs, ext_counts, dir_counts = [], [], {}, {}
    seen = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in skip and not d.startswith('.'))
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, '/')
        if rel_dir != '.' and os.path.basename(dirpath).lower() in ICON_DIR_NAMES:
            icon_dirs.append(rel_dir)
        top = rel_dir.split('/')[0]
        for filename in filenames:
            seen += 1
            ext = os.path.splitext(filename)[1].lower()
            if ext in CODE_EXTS:
                ext_counts[ext] = ext_counts.get(ext, 0) + 1
                dir_counts[top] = dir_counts.get(top, 0) + 1
            if ext == '.js' and 'regist' in filename.lower():
                variable = read_registry_variable(os.path.join(dirpath, filename))
                if variable:
                    registries.append({'path': os.path.relpath(os.path.join(dirpath, filename), root).replace(os.sep, '/'),
                                       'variable': variable})
        if seen > MAX_FILES:
            break
    return {
        'codebase': root,
        'registries': registries,
        'icon_dirs': icon_dirs,
        'extensions': sorted(ext_counts.items(), key=lambda item: -item[1]),
        'dirs': sorted(((d, n) for d, n in dir_counts.items() if d != '.'), key=lambda item: item[0]),
        'root_files': dir_counts.get('.', 0),
    }


def state(_body=None):
    return {'configured': config.CONFIGURED, 'codebase': config.REPO_DIR, 'studio_dir': config.STUDIO_DIR,
            'config_file': config.CONFIG_FILE, 'swap_file': SWAP_FILE}


def config_codebase(root):
    """The codebase as config.json writes it: relative to the studio folder when it can be."""
    try:
        return os.path.relpath(root, config.STUDIO_DIR).replace(os.sep, '/')
    except ValueError:
        return root.replace(os.sep, '/')


def save(body):
    """Validates the walkthrough's answers, creates the registry if asked, and writes config.json."""
    root = find_codebase(body.get('codebase'))
    variable = str(body.get('registry_variable') or '').strip()
    if not VARIABLE_RE.match(variable):
        raise ValueError('The registry variable must look like window.OS_ICON_REGISTRY')
    registry = inside(root, body.get('registry'), 'The registry file')
    if not registry.endswith('.js'):
        raise ValueError('The registry file must be a .js file')
    web_root = inside(root, body.get('web_root') or '.', 'The web root')
    icons = inside(web_root, body.get('icons_dir'), 'The icons folder')
    dirs = [str(d).replace('\\', '/').strip('/') or '.' for d in body.get('scan_dirs') or []]
    if not dirs:
        raise ValueError('Pick at least one folder to scan for emoji')
    for d in dirs:
        if not os.path.isdir(inside(root, d, 'A scanned folder')):
            raise ValueError(f'{d} is not a folder in the codebase')
    extensions = [str(e).strip().lower() for e in body.get('extensions') or []]
    if not extensions or not all(re.match(r'^\.[a-z0-9]+$', e) for e in extensions):
        raise ValueError('Pick at least one file type, such as .html')

    created = False
    if not os.path.isfile(registry):
        if not body.get('create_registry'):
            raise ValueError(f'{body.get("registry")} does not exist. Tick "Make a new registry" or pick another file.')
        os.makedirs(os.path.dirname(registry), exist_ok=True)
        with open(registry, 'w', encoding='utf-8') as f:
            f.write(variable + ' = ' + json.dumps({'emoji': {}}, indent=4) + ';\n')
        created = True
    elif read_registry_variable(registry) is None:
        raise ValueError('That file is not a registry: it must set a variable to a JSON object')

    swap = None
    if body.get('install_swap'):
        swap = os.path.join(web_root, SWAP_FILE)
        shutil.copyfile(os.path.join(config.STUDIO_DIR, SWAP_FILE), swap)

    skip = [d for d in body.get('skip_dirs') or config.DEFAULT_SKIP_DIRS]
    out = {
        'port': config.PORT,
        'codebase': config_codebase(root),
        'registry': os.path.relpath(registry, root).replace(os.sep, '/'),
        'registry_variable': variable,
        'web_root': os.path.relpath(web_root, root).replace(os.sep, '/'),
        'icons_dir': os.path.relpath(icons, root).replace(os.sep, '/'),
        'scan': {'dirs': dirs, 'extensions': extensions, 'skip_dirs': skip},
    }
    with open(config.CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=4)
        f.write('\n')

    tags = None
    if swap:
        registry_src = os.path.relpath(registry, web_root).replace(os.sep, '/')
        attr = '' if variable == 'window.OS_ICON_REGISTRY' else f' data-registry="{variable}"'
        tags = f'<script src="{registry_src}"></script>\n<script src="{SWAP_FILE}"{attr}></script>'
    return {'config': out, 'created_registry': created, 'swap_installed': bool(swap), 'script_tags': tags}
