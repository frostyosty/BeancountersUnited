// The first-run walkthrough: asks where the codebase keeps its icons and sends the answers to the server.
const $ = id => document.getElementById(id);
const DEFAULT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.css', '.scss']);
let found = null;

async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

function setStatus(msg, isError) {
    $('status').textContent = msg;
    $('status').className = 'status' + (isError ? ' error' : '');
}

function checkbox(container, value, label, checked) {
    const el = document.createElement('label');
    el.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = value;
    box.checked = checked;
    el.append(box, ' ' + label);
    container.appendChild(el);
}

function checked(container) {
    return [...container.querySelectorAll('input:checked')].map(box => box.value);
}

async function look() {
    setStatus('Looking through the codebase...');
    try {
        found = await api('/setup/detect', { codebase: $('codebase').value });
    } catch (e) {
        return setStatus(e.message, true);
    }
    $('codebase').value = found.codebase;

    const pick = $('registry-pick');
    pick.replaceChildren();
    for (const r of found.registries) pick.add(new Option(`${r.path}  (${r.variable})`, r.path));
    pick.add(new Option('Make a new registry', ''));
    pick.value = found.registries.length ? found.registries[0].path : '';
    pickRegistry();

    const dirs = $('dirs');
    dirs.replaceChildren();
    for (const [dir, count] of found.dirs) checkbox(dirs, dir, `${dir}/ (${count} files)`, true);
    const exts = $('exts');
    exts.replaceChildren();
    for (const [ext, count] of found.extensions) checkbox(exts, ext, `${ext} (${count})`, DEFAULT_EXTS.has(ext));

    $('steps').hidden = false;
    setStatus(found.registries.length ? `Found ${found.registries.length} icon registr${found.registries.length === 1 ? 'y' : 'ies'}.` : 'No icon registry found. Pick a path and the studio makes one.');
}

function pickRegistry() {
    const path = $('registry-pick').value;
    const entry = found.registries.find(r => r.path === path);
    $('create').checked = !entry;
    $('registry').value = entry ? entry.path : 'icon_registry.js';
    $('variable').value = entry ? entry.variable : 'window.OS_ICON_REGISTRY';
    const slash = $('registry').value.lastIndexOf('/');
    const webRoot = slash < 0 ? '.' : $('registry').value.slice(0, slash);
    $('web-root').value = webRoot;
    const iconDir = found.icon_dirs.find(d => webRoot === '.' || d.startsWith(webRoot + '/'));
    const prefix = webRoot === '.' ? '' : webRoot + '/';
    $('icons-dir').value = iconDir ? iconDir.slice(prefix.length) : 'assets/icons';
}

async function saveSetup() {
    setStatus('Saving...');
    $('save-btn').disabled = true;
    try {
        const result = await api('/setup/save', {
            codebase: $('codebase').value,
            registry: $('registry').value,
            registry_variable: $('variable').value,
            create_registry: $('create').checked,
            web_root: $('web-root').value,
            icons_dir: $('icons-dir').value,
            scan_dirs: checked($('dirs')),
            extensions: checked($('exts')),
            install_swap: $('swap').checked,
        });
        showDone(result);
    } catch (e) {
        setStatus(e.message, true);
        $('save-btn').disabled = false;
    }
}

function showDone(result) {
    setStatus('');
    $('steps').hidden = true;
    $('done').hidden = false;
    const lines = ['config.json is written.'];
    if (result.created_registry) lines.push(`Made ${result.config.registry}.`);
    if (result.swap_installed) lines.push('Copied icon_swap.js into the web root. Add these to the pages that should show the images:');
    $('done-text').textContent = lines.join(' ');
    if (result.script_tags) {
        $('tags').hidden = false;
        $('tags').textContent = result.script_tags;
    }
    if (result.restart) $('done-text').textContent += ' Restart the studio to use the new settings.';
    else $('open').hidden = false;
}

api('/setup/state').then(state => {
    $('codebase').value = state.codebase;
    if (state.configured) $('intro').textContent = 'Icon Studio is already set up. Saving here changes config.json, and the studio needs a restart afterwards.';
}).catch(e => setStatus(e.message, true));
