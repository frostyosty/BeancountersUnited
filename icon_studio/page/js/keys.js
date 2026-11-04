// The editor's tool layout and keys. layoutTools sorts the tool buttons into kinds and gives each
// tool a key (1 to 6 for the first six, then letters), shown on its button and changeable under
// ⌨ Keys. The picked tool sees each key first (its key(e) in defineTool); what it does not use
// goes to the keys below.

// The kind a tool belongs to; a tool can name its own with `group` in defineTool.
const TOOL_KINDS = [
    ['Select', ['wand', 'rect', 'ellipse', 'circle', 'shape', 'lasso']],
    ['Transform', ['crop', 'scale', 'stretch', 'move', 'rotate', 'transform']],
    ['Paint', ['draw', 'brush', 'curve', 'fill', 'erase', 'eraser', 'bgremove', 'removebg']],
    ['Adjust', ['sharpen', 'recolor']],
];
const KEYS_STORE = 'iconStudioToolKeys';
const RESERVED_KEYS = '[]{} ';
let toolKeys = {};      // tool name -> its key, '' for none
let keyOfTool = {};     // key -> tool name
let toolOrder = [];     // tool names as laid out
let rebinding = null;   // the tool whose key waits for a press in the Keys panel

function kindOf(name) {
    return TOOLS[name].group || (TOOL_KINDS.find(k => k[1].includes(name)) || ['More'])[0];
}

function savedKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORE)) || {}; } catch (err) { return {}; }
}

function storeKeys(custom) {
    try { localStorage.setItem(KEYS_STORE, JSON.stringify(custom)); } catch (err) { /* the keys last for this visit only */ }
}

// Every tool's key: the changed ones first, then 1 to 6 for the first six tools and the first free
// letter of the name for the rest.
function assignKeys() {
    const custom = savedKeys();
    toolKeys = {};
    keyOfTool = {};
    const take = (name, key) => { toolKeys[name] = key; if (key) keyOfTool[key] = name; };
    toolOrder.forEach(name => {
        const key = custom[name];
        if (typeof key === 'string' && key.length <= 1 && !RESERVED_KEYS.includes(key) && (!key || !keyOfTool[key])) take(name, key);
    });
    toolOrder.forEach((name, n) => {
        if (name in toolKeys) return;
        const choices = (n < 6 ? [String(n + 1)] : []).concat((name + 'abcdefghijklmnopqrstuvwxyz').split(''));
        take(name, choices.find(k => /^[a-z1-6]$/.test(k) && !keyOfTool[k]) || '');
    });
}

function showKeys() {
    toolOrder.forEach(name => {
        const button = $('tool-' + name);
        const cap = button.querySelector('.keycap');
        const key = toolKeys[name];
        cap.textContent = key.toUpperCase();
        cap.hidden = !key;
        button.title = TOOLS[name].title + (key ? ' (key ' + key.toUpperCase() + ')' : '');
    });
    renderKeyPanel();
}

// Puts the tool buttons into a box per kind, adds the key badges and the ⌨ Keys panel.
function layoutTools() {
    const kinds = {};
    Object.keys(TOOLS).forEach(name => { (kinds[kindOf(name)] = kinds[kindOf(name)] || []).push(name); });
    const order = TOOL_KINDS.map(k => k[0]).concat('More').filter(k => kinds[k]);
    Object.keys(kinds).forEach(k => { if (!order.includes(k)) order.push(k); });
    const box = $('tool-buttons');
    order.forEach(kind => {
        const known = (TOOL_KINDS.find(k => k[0] === kind) || [kind, []])[1];
        const names = kinds[kind].sort((a, b) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99));
        const group = document.createElement('span');
        group.className = 'tool-group';
        group.innerHTML = '<small></small><span class="tool-row"></span>';
        group.firstChild.textContent = kind;
        names.forEach(name => {
            const button = $('tool-' + name);
            const cap = document.createElement('kbd');
            cap.className = 'keycap';
            button.appendChild(cap);
            group.lastChild.appendChild(button);
            toolOrder.push(name);
        });
        box.appendChild(group);
    });
    const toggle = document.createElement('button');
    toggle.id = 'keys-toggle';
    toggle.className = 'secondary';
    toggle.textContent = '⌨ Keys';
    toggle.title = 'Change the key of each tool';
    toggle.addEventListener('click', () => { $('keys-panel').hidden = !$('keys-panel').hidden; });
    box.parentNode.appendChild(toggle);
    const panel = document.createElement('div');
    panel.id = 'keys-panel';
    panel.hidden = true;
    box.closest('.modal-content').appendChild(panel);
    assignKeys();
    showKeys();
}

// The Keys panel: a row per tool; click its key, then press the new one.
function renderKeyPanel() {
    const panel = $('keys-panel');
    if (!panel) return;
    panel.innerHTML = '<div class="hint">Click a key, then press the new one. Backspace clears it, Esc cancels.</div>';
    toolOrder.forEach(name => {
        const row = document.createElement('div');
        row.className = 'key-row';
        const label = document.createElement('span');
        label.textContent = TOOLS[name].label;
        const button = document.createElement('button');
        button.className = 'key-set' + (rebinding === name ? ' waiting' : '');
        button.textContent = rebinding === name ? 'press a key…' : (toolKeys[name] || '—').toUpperCase();
        button.addEventListener('click', () => { rebinding = rebinding === name ? null : name; renderKeyPanel(); });
        row.append(label, button);
        panel.appendChild(row);
    });
    const reset = document.createElement('button');
    reset.className = 'secondary';
    reset.textContent = 'Reset keys';
    reset.addEventListener('click', () => { storeKeys({}); rebinding = null; assignKeys(); showKeys(); });
    panel.appendChild(reset);
}

// A key taken from another tool leaves that tool the key this one had.
function bindKey(name, key) {
    const custom = { ...toolKeys };
    const other = keyOfTool[key];
    if (key && other && other !== name) custom[other] = toolKeys[name];
    custom[name] = key;
    storeKeys(custom);
    assignKeys();
    showKeys();
}

// While the panel waits for a key, nothing else sees the keyboard.
window.addEventListener('keydown', e => {
    if (!rebinding) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const name = rebinding;
    if (e.key === 'Backspace' || e.key === 'Delete') {
        rebinding = null;
        bindKey(name, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !RESERVED_KEYS.includes(e.key)) {
        rebinding = null;
        bindKey(name, e.key.toLowerCase());
    } else {
        if (e.key === 'Escape') rebinding = null;
        renderKeyPanel();
    }
}, true);

window.addEventListener('DOMContentLoaded', layoutTools);

window.addEventListener('keydown', e => {
    if (!editing) return;
    // Keys typed into a box belong to the box.
    if (e.target.matches && e.target.matches('input:not([type=range]):not([type=checkbox]), textarea, select') && e.key !== 'Escape') return;
    const spec = TOOLS[tool];
    if (spec.key && spec.key(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const arrow = !ctrl && !e.altKey && { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (arrow && !(e.target.matches && e.target.matches('input[type=number], input[type=range]'))) {
        // A tool with a slider takes left and right for it; otherwise the arrows move the selection or icon.
        const slider = document.querySelector('.tool-opts:not([hidden]) label:not([hidden]) > input[type=range]');
        e.preventDefault();
        if (slider && arrow[0]) stepSlider(arrow[0], e.shiftKey);
        else if (!slider || !arrow[0]) nudge(arrow[0] * (e.shiftKey ? 10 : 1), arrow[1] * (e.shiftKey ? 10 : 1));
        return;
    }
    if (!ctrl && !e.altKey && !e.repeat && keyOfTool[e.key.toLowerCase()]) {
        e.preventDefault();
        setTool(keyOfTool[e.key.toLowerCase()]);
    } else if (e.key === 'Escape') {
        if (sel) deselect();
        else closeEditor();
    } else if (ctrl && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoEdit();
    } else if (ctrl && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copySelection();
    } else if (ctrl && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        pasteClip();
    } else if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
        e.preventDefault();
        stepSlider(e.key === '[' || e.key === '{' ? -1 : 1, e.shiftKey);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        eraseSelection();
    }
});
