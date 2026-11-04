// What every part of the page shares: the registry, calls to the server, the status line.
const KEY_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const SLOT_DRAG = 'application/x-logos-icon-slot';
const $ = id => document.getElementById(id);
let registry = {};
let labels = {};       // "emoji.1f4ac" -> "💬 speech balloon"
let shortPrefix = '';  // the folder every scanned path starts with, left out when paths are shown

async function api(path, body, signal) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || res.statusText);
        err.status = res.status;
        throw err;
    }
    return data;
}

function setStatus(msg, isError) {
    $('status').textContent = msg;
    $('status').className = 'status' + (isError ? ' error' : '');
}

const shortPath = file => (shortPrefix && file.startsWith(shortPrefix) ? file.slice(shortPrefix.length) : file);

// An emoji or image for a registry entry ({ type, value }). Image paths are relative to the
// codebase's web root, which the server serves under /app/.
function iconEl(entry) {
    if (entry && entry.type === 'image' && entry.value) {
        const img = document.createElement('img');
        img.src = /^(https?|data):/.test(entry.value) ? entry.value : '/app/' + entry.value;
        img.alt = entry.value;
        return img;
    }
    const span = document.createElement('span');
    span.className = 'emoji';
    span.textContent = (entry && entry.value) || '?';
    return span;
}

function slotEntry(key) {
    const [group, name] = key.split('.');
    return registry[group] && registry[group][name];
}

function applyRegistry(data) {
    registry = data.registry;
    labels = data.labels || {};
}
