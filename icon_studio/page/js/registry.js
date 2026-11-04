// The registry panel: the slots and their saved icons, "Find emoji", where the code uses a slot,
// and changing, splitting and merging slots.
let scan = null;       // emoji found by "Find emoji": { key, emoji, name, places: [[file, line, text]] }
let ticked = { key: null, places: new Set() }; // places ticked for the targeted emoji, as "file:line"

function renderRegistry() {
    closeMenus();
    const groups = $('groups');
    const list = $('slot-list');
    groups.innerHTML = '';
    list.innerHTML = '';
    if (scan) {
        renderNeedsIcon(groups);
        fillSwapList();
    }
    for (const [group, slots] of Object.entries(registry)) {
        const heading = document.createElement('h3');
        heading.textContent = group;
        const grid = document.createElement('div');
        grid.className = 'grid';
        for (const [name, entry] of Object.entries(slots)) {
            if (!entry || !entry.type) continue;
            const key = group + '.' + name;
            const card = document.createElement('div');
            card.className = 'icon-card';
            card.dataset.key = key;
            card.appendChild(iconEl(entry));
            const label = document.createElement('span');
            label.className = 'label' + (labels[key] ? ' words' : '');
            label.textContent = labels[key] || key;
            card.appendChild(label);
            card.onclick = () => targetSlot(key);
            wireCard(card, key, label);
            const variants = entry.variants || [];
            if (variants.length > 1) {
                const arrow = document.createElement('button');
                arrow.className = 'variant-arrow';
                arrow.title = variants.length + ' saved icons';
                arrow.textContent = '▾';
                arrow.onclick = e => { e.stopPropagation(); toggleVariantMenu(key, arrow); };
                card.appendChild(arrow);
            }
            grid.appendChild(card);
            const opt = document.createElement('option');
            opt.value = key;
            list.appendChild(opt);
        }
        groups.appendChild(heading);
        groups.appendChild(grid);
    }
    slotChanged();
}

// Emoji found by "Find emoji" that have no registry.emoji entry yet.
function renderNeedsIcon(groups) {
    const needs = scan.filter(item => !slotEntry(item.key));
    const heading = document.createElement('h3');
    heading.textContent = 'Needs icon (' + needs.length + ')';
    const hint = document.createElement('div');
    hint.className = 'hint needs-hint';
    hint.textContent = needs.length
        ? 'Emoji in the app that have no icon yet. Click one to make icons for it: the icon you save replaces that emoji on every page, desktop and Android. Emoji in tooltips, dropdown options, window titles and native menus stay emoji.'
        : 'Every emoji found has an icon or was kept as an emoji.';
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const item of needs) {
        const card = document.createElement('div');
        card.className = 'icon-card';
        card.dataset.key = item.key;
        card.appendChild(iconEl({ type: 'emoji', value: item.emoji }));
        const label = document.createElement('span');
        label.className = 'label words';
        label.textContent = item.name || item.key;
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = item.places.length + (item.places.length === 1 ? ' place' : ' places');
        card.append(label, sub);
        card.onclick = () => targetSlot(item.key);
        wireCard(card, item.key, label);
        const keep = document.createElement('button');
        keep.className = 'keep-btn';
        keep.textContent = 'Keep emoji';
        keep.title = 'Leave this emoji as it is and take it off this list';
        keep.onclick = e => { e.stopPropagation(); keepEmoji(item.key); };
        card.appendChild(keep);
        grid.appendChild(card);
    }
    groups.append(heading, hint, grid);
}

async function scanEmoji() {
    $('scan-btn').disabled = true;
    try {
        scan = (await api('/scan_emoji')).emoji;
        renderRegistry();
        $('registry-panel').scrollTop = 0;
        setStatus('Found ' + scan.length + ' different emoji, ' + scan.filter(item => !slotEntry(item.key)).length + ' without an icon.');
    } catch (e) {
        setStatus('Scan failed: ' + e.message, true);
    }
    $('scan-btn').disabled = false;
}

async function keepEmoji(key) {
    try {
        applyRegistry(await api('/keep_emoji', { key }));
        renderRegistry();
    } catch (e) {
        setStatus(e.message, true);
    }
}

function targetSlot(key) {
    $('slot').value = key;
    slotChanged();
}

// Where the targeted emoji appears in the code, after a scan. Ticked places can be changed to
// another emoji, which then has its own icon.
function showPlaces(key) {
    const found = scan && scan.find(item => item.key === key);
    const places = $('places');
    places.hidden = $('swap-row').hidden = !found;
    places.innerHTML = '';
    if (ticked.key !== key) ticked = { key, places: new Set() };
    if (!found) return;
    const ids = found.places.map(([file, line]) => file + ':' + line);
    const head = document.createElement('label');
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.title = 'Tick or untick every place';
    all.onchange = () => {
        ticked.places = new Set(all.checked ? ids : []);
        showPlaces(key);
    };
    head.append(all, found.emoji + ' is used in ' + ids.length + (ids.length === 1 ? ' place.' : ' places.') + ' Tick the ones to change:');
    places.appendChild(head);
    found.places.forEach(([file, line, text], i) => {
        const row = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = ticked.places.has(ids[i]);
        box.onchange = () => {
            if (box.checked) ticked.places.add(ids[i]);
            else ticked.places.delete(ids[i]);
            updateSwap(found);
        };
        const loc = document.createElement('b');
        loc.textContent = shortPath(file) + ':' + line;
        row.append(box, loc, ' ' + text);
        row.title = file + ':' + line + '\n' + text;
        places.appendChild(row);
    });
    updateSwap(found);
}

function updateSwap(found) {
    const n = ticked.places.size;
    const all = $('places').querySelector('input');
    all.checked = n === found.places.length;
    all.indeterminate = n > 0 && !all.checked;
    $('swap-btn').disabled = !n || !$('swap-to').value.trim();
    $('swap-btn').textContent = n ? 'Change ' + n + (n === 1 ? ' place' : ' places') : 'Change ticked';
}

// Emoji the scan found or the registry holds, to pick the replacement from by name.
function fillSwapList() {
    const known = new Map(scan.map(item => [item.emoji, item.name]));
    for (const label of Object.values(labels)) {
        const [emoji, ...name] = label.split(' ');
        if (!known.has(emoji)) known.set(emoji, name.join(' '));
    }
    $('swap-list').innerHTML = '';
    for (const [emoji, name] of known) {
        const opt = document.createElement('option');
        opt.value = emoji;
        opt.label = name;
        $('swap-list').appendChild(opt);
    }
}

// Rewrites the ticked lines of the source to use another emoji, then targets that emoji.
async function swapPlaces() {
    const found = scan && scan.find(item => item.key === ticked.key);
    if (!found) return;
    const places = found.places.filter(([file, line]) => ticked.places.has(file + ':' + line)).map(([file, line]) => [file, line]);
    $('swap-btn').disabled = true;
    try {
        const data = await api('/swap_emoji', { key: found.key, to: $('swap-to').value.trim(), places });
        applyRegistry(data);
        scan = data.emoji;
        $('swap-to').value = '';
        renderRegistry();
        targetSlot(data.to_key);
        const to = scan.find(item => item.key === data.to_key);
        setStatus('✅ Changed ' + data.changed + (data.changed === 1 ? ' place' : ' places') + ' from ' + found.emoji + ' to ' + (to ? to.emoji : data.to_key) +
            (data.skipped ? ' (' + data.skipped + ' had changed since the scan and were left alone)' : '') + '. Reload logOS to see it.');
    } catch (e) {
        setStatus(e.message, true);
        updateSwap(found);
    }
}

function slotChanged() {
    const key = $('slot').value.trim();
    const preview = $('slot-preview');
    preview.innerHTML = '';
    if (KEY_RE.test(key)) {
        const entry = slotEntry(key);
        if (entry) preview.appendChild(iconEl(entry));
        else preview.innerHTML = '<span class="new">new</span>';
    }
    document.querySelectorAll('.icon-card').forEach(c => c.classList.toggle('targeted', c.dataset.key === key));
    showPlaces(key);
    updatePicks();
}

function toggleVariantMenu(key, anchor) {
    const menu = $('variant-menu');
    const wasOpen = !menu.hidden && menu.dataset.key === key;
    closeMenus();
    if (wasOpen) return;
    const entry = slotEntry(key);
    menu.dataset.key = key;
    for (const v of entry.variants) {
        const opt = document.createElement('button');
        opt.className = 'variant checker' + (v.type === entry.type && v.value === entry.value ? ' active' : '');
        opt.title = v.value;
        opt.appendChild(iconEl(v));
        opt.onclick = () => setActive(key, v);
        menu.appendChild(opt);
    }
    menu.hidden = false;
    anchor.classList.add('open');
    placeMenu(menu, anchor);
}

function closeVariantMenu() {
    $('variant-menu').hidden = true;
    $('variant-menu').innerHTML = '';
    document.querySelectorAll('.variant-arrow.open').forEach(a => a.classList.remove('open'));
}

function placeMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, r.bottom + menu.offsetHeight + 4 > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4) + 'px';
}

function closeMenus() {
    closeVariantMenu();
    $('usage-menu').hidden = true;
    $('usage-menu').innerHTML = '';
    document.querySelectorAll('.usage-arrow.open').forEach(a => a.classList.remove('open'));
}

// The entry a card shows: the slot's, or the emoji itself for one the scan found.
function cardEntry(key) {
    const found = scan && scan.find(item => item.key === key);
    return slotEntry(key) || (found && { type: 'emoji', value: found.emoji });
}

// "💬 speech balloon" for an emoji slot, the key for a named one.
function slotName(key) {
    const found = scan && scan.find(item => item.key === key);
    return labels[key] || (found ? found.emoji + ' ' + found.name : key);
}

// Every card gets a ▾ next to its name (where the code uses the icon) and can be dragged onto
// another card to merge the two.
function wireCard(card, key, label) {
    const arrow = document.createElement('button');
    arrow.className = 'usage-arrow';
    arrow.title = 'Where the code uses this icon';
    arrow.textContent = '▾';
    arrow.onclick = e => { e.stopPropagation(); toggleUsageMenu(key, arrow); };
    label.appendChild(arrow);
    card.querySelectorAll('img').forEach(img => { img.draggable = false; });
    card.draggable = true;
    card.addEventListener('dragstart', e => {
        e.dataTransfer.setData(SLOT_DRAG, key);
        e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragover', e => {
        if (!e.dataTransfer.types.includes(SLOT_DRAG)) return;
        e.preventDefault();
        card.classList.add('merge-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('merge-target'));
    card.addEventListener('drop', e => {
        if (!e.dataTransfer.types.includes(SLOT_DRAG)) return;
        e.preventDefault();
        card.classList.remove('merge-target');
        const from = e.dataTransfer.getData(SLOT_DRAG);
        if (from && from !== key) mergeSlots(from, key);
    });
}

async function toggleUsageMenu(key, anchor) {
    const menu = $('usage-menu');
    const wasOpen = !menu.hidden && menu.dataset.key === key;
    closeMenus();
    if (wasOpen) return;
    menu.dataset.key = key;
    menu.textContent = 'Looking through the code…';
    menu.hidden = false;
    anchor.classList.add('open');
    placeMenu(menu, anchor);
    let places;
    try {
        places = (await api('/usages?key=' + encodeURIComponent(key))).places;
    } catch (e) {
        places = e.message;
    }
    if (menu.hidden || menu.dataset.key !== key) return;
    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'usage-title';
    const name = slotName(key);
    if (typeof places === 'string') head.textContent = places;
    else if (!places.length) head.textContent = name + ' is not named anywhere in the code. It may be an unused slot, or its name is put together while the app runs.';
    else head.textContent = name + ' is used in ' + places.length + (places.length === 1 ? ' place.' : ' places. Split gives one place its own icon.');
    menu.appendChild(head);
    for (const place of typeof places === 'string' ? [] : places) {
        const row = document.createElement('div');
        row.className = 'usage';
        const top = document.createElement('div');
        top.className = 'usage-head';
        const loc = document.createElement('b');
        loc.textContent = shortPath(place.file) + ':' + place.line;
        loc.title = place.file + ':' + place.line;
        const split = document.createElement('button');
        split.textContent = 'Split';
        split.title = 'Give this place its own icon, apart from the other places';
        split.onclick = () => splitPlace(key, place);
        top.append(loc, split);
        const code = document.createElement('div');
        code.className = 'usage-code';
        for (const [number, text] of place.context) {
            const line = document.createElement('div');
            if (number === place.line) line.className = 'hit';
            line.textContent = number + '  ' + text;
            code.appendChild(line);
        }
        row.append(top, code);
        menu.appendChild(row);
    }
    placeMenu(menu, anchor);
}

// Split: one place in the code gets its own slot, a copy of this one, to restyle on its own.
// An emoji is its own name, so an emoji place has to change to another emoji instead.
async function splitPlace(key, place) {
    let to;
    if (key.startsWith('emoji.')) {
        to = (prompt('An emoji gets its icon by which emoji it is, so this place needs a different emoji to have its own icon. Emoji to use here:') || '').trim();
        if (!to) return;
    }
    try {
        const data = await api('/split', { key, file: place.file, line: place.line, to });
        applyRegistry(data);
        if (data.emoji) scan = data.emoji;
        renderRegistry();
        targetSlot(data.new_key);
        setStatus('✅ ' + place.file.split('/').pop() + ':' + place.line + ' now uses ' + slotName(data.new_key) + '. Make or pick an icon for it.');
    } catch (e) {
        setStatus(e.message, true);
    }
}

// Asks which of two different icons the merged slot shows. Resolves to 'from', 'into' or null.
function askKeep(from, a, into, b, mixed) {
    return new Promise(resolve => {
        const choices = $('merge-choices');
        choices.innerHTML = '';
        $('merge-text').textContent = (mixed ? slotName(from) + ' and ' + slotName(into) + ' will show the same icon.' : 'Merging ' + slotName(from) + ' into ' + slotName(into) + '.') +
            ' Every place in the code that uses either will show one icon. Which one?';
        const done = answer => { $('merge-modal').hidden = true; resolve(answer); };
        for (const [answer, key, entry] of [['from', from, a], ['into', into, b]]) {
            const btn = document.createElement('button');
            btn.className = 'merge-choice checker';
            btn.appendChild(iconEl(entry));
            const name = document.createElement('span');
            name.textContent = 'Keep ' + (entry.type === 'emoji' ? entry.value : 'the icon of ' + slotName(key));
            btn.appendChild(name);
            btn.onclick = () => done(answer);
            choices.appendChild(btn);
        }
        $('merge-cancel').onclick = () => done(null);
        $('merge-modal').hidden = false;
    });
}

// Merge: dragging one card onto another makes every place that used the dragged icon use the
// other one, and joins their ▾ lists.
async function mergeSlots(from, into) {
    // The code names an emoji and a slot in different ways, so those two stay apart and share an icon.
    const mixed = from.startsWith('emoji.') !== into.startsWith('emoji.');
    const a = cardEntry(from), b = cardEntry(into);
    if (!a || !b) return;
    const names = [slotName(from), slotName(into)];
    let keep = 'into';
    if (a.type !== b.type || a.value !== b.value) {
        keep = await askKeep(from, a, into, b, mixed);
        if (!keep) return;
    }
    try {
        const data = await api('/merge', { from, into, keep });
        applyRegistry(data);
        if (data.emoji) scan = data.emoji;
        renderRegistry();
        targetSlot(data.key);
        if (mixed) return setStatus('✅ ' + names[0] + ' and ' + names[1] + ' now show the same icon, and each has the other in its ▾ list. Reload logOS to see it.');
        setStatus('✅ Merged ' + names[0] + ' and ' + names[1] + ' into ' + slotName(data.key) + ': changed ' + data.changed + (data.changed === 1 ? ' place' : ' places') + ' in the code. Reload logOS to see it.');
    } catch (e) {
        setStatus(e.message, true);
    }
}

async function setActive(key, variant) {
    try {
        applyRegistry(await api('/set_active', { key, value: variant.value }));
        renderRegistry();
        setStatus('✅ ' + key + ' now uses ' + variant.value.split('/').pop());
    } catch (e) {
        setStatus(e.message, true);
    }
}

$('slot').addEventListener('input', slotChanged);
$('swap-to').addEventListener('input', () => showPlaces($('slot').value.trim()));
$('registry-panel').addEventListener('scroll', closeMenus);
window.addEventListener('resize', closeMenus);
document.addEventListener('click', e => {
    if (!e.target.closest('#variant-menu, .variant-arrow, #usage-menu, .usage-arrow')) closeMenus();
});
