// Paint tools: draw, curve, fill, clear background, sharpen and recolor. They change the pixels,
// only the selected ones when there is a selection.
// Sharpen: each pixel moves a little away from the average of its four neighbours.
function sharpen() {
    const amount = 0.2;
    changePixels((img, src) => {
        const d = img.data, w = img.width, h = img.height;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = (y * w + x) * 4;
                if (!src[p + 3]) continue;
                const near = [x > 0 ? p - 4 : p, x + 1 < w ? p + 4 : p, y > 0 ? p - w * 4 : p, y + 1 < h ? p + w * 4 : p];
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    // A transparent neighbour has no colour to compare with.
                    for (const q of near) sum += src[q + 3] ? src[q + c] : src[p + c];
                    d[p + c] = src[p + c] * (1 + 4 * amount) - sum * amount;
                }
            }
        }
        blendSelection(d, src);
    });
}

const luma = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

// Fill: gives the icon (or the selection) one colour. Its average brightness becomes that
// colour; darker pixels go towards black and lighter ones towards white, so shading stays.
window.fillColour = function() {
    const hex = $('recolor-colour').value;
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    changePixels((img, src) => {
        const d = img.data;
        let total = 0, weight = 0;
        for (let i = 0, p = 0; p < d.length; i++, p += 4) {
            const wgt = src[p + 3] * (sel ? sel.mask[i] : 255);
            total += luma(src, p) * wgt;
            weight += wgt;
        }
        const mean = weight ? total / weight : 128;
        for (let p = 0; p < d.length; p += 4) {
            const l = luma(src, p);
            for (let c = 0; c < 3; c++) {
                d[p + c] = l <= mean ? rgb[c] * l / (mean || 1) : rgb[c] + (255 - rgb[c]) * (l - mean) / (255 - mean);
            }
        }
        blendSelection(d, src);
    });
};

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, d / (1 - Math.abs(2 * l - 1)), l];
}

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h / 60 % 2 - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// The Hue, Saturation and Brightness sliders.
function adjustColours() {
    if (!editing) return;
    floating = null;
    beginLive();
    const turn = val('recolor-hue'), sat = val('recolor-sat') / 100, bright = val('recolor-bright') / 100;
    const src = live.img.data;
    const img = new ImageData(new Uint8ClampedArray(src), canvas.width, canvas.height), d = img.data;
    for (let p = 0; p < d.length; p += 4) {
        if (!src[p + 3]) continue;
        let [h, s, l] = rgbToHsl(src[p], src[p + 1], src[p + 2]);
        h = (h + turn + 360) % 360;
        s = Math.min(1, s * (1 + sat));
        l = bright > 0 ? l + (1 - l) * bright : l * (1 + bright);
        [d[p], d[p + 1], d[p + 2]] = hslToRgb(h, s, l);
    }
    blendSelection(d, src);
    ctx.putImageData(img, 0, 0);
}

defineTool('sharpen', {
    label: '✨ Sharpen',
    title: 'Click the icon to sharpen it a little',
    hint: 'Click the icon to sharpen it a little. Click again for more.',
    cursor: 'pointer',
    keepsSelection: true,
    down() {
        sharpen();
    },
});

defineTool('recolor', {
    label: '🎨 Recolor',
    title: "Change the icon's colours",
    hint: 'Tint gives the icon one colour and keeps its shading (the Fill tool paints a flat colour). The sliders shift the colours it has. With a selection, only the selected area changes.',
    keepsSelection: true,
});

defineOptions('recolor', `
    <input type="color" id="recolor-colour" value="#3b82f6" title="Colour to fill with">
    <button title="Give the icon this colour, keeping its shading" onclick="fillColour()">Tint</button>
    <label class="hint">Hue <input type="range" id="recolor-hue" min="-180" max="180" value="0" data-reset="0"><input type="number" class="num" min="-180" max="180" value="0">°</label>
    <label class="hint">Saturation <input type="range" id="recolor-sat" min="-100" max="100" value="0" data-reset="0"><input type="number" class="num" min="-100" max="100" value="0">%</label>
    <label class="hint">Brightness <input type="range" id="recolor-bright" min="-100" max="100" value="0" data-reset="0"><input type="number" class="num" min="-100" max="100" value="0">%</label>`);

['recolor-hue', 'recolor-sat', 'recolor-bright'].forEach(id => $(id).addEventListener('input', adjustColours));

const paintRgb = () => [1, 3, 5].map(i => parseInt($('paint-colour').value.slice(i, i + 2), 16));

// The ink: 'none', 'colour' or 'erase'. Draw, Curve and Fill paint with the colour, or rub out when
// it is Erase (None paints like Colour). A selection tool applies it once to the selection it makes
// and the ink goes back to None.
let ink = 'none';

function setInk(mode) {
    ink = mode;
    document.querySelectorAll('[data-ink]').forEach(b => b.classList.toggle('active', b.dataset.ink === mode));
    $('sel-colour').hidden = mode !== 'colour';
    showFill(fillAt);
    if (tool === 'curve') showBend();
}

// Fills the pixels of an area (0 to 255 per pixel) with the colour, or takes its opacity away.
function inkPixels(area, erase) {
    const rgb = paintRgb();
    changePixels(img => {
        const d = img.data;
        for (let i = 0; i < area.length; i++) {
            const m = area[i] / 255;
            if (!m) continue;
            if (erase) {
                d[i * 4 + 3] *= 1 - m;
                continue;
            }
            for (let c = 0; c < 3; c++) d[i * 4 + c] += (rgb[c] - d[i * 4 + c]) * m;
            d[i * 4 + 3] += (255 - d[i * 4 + 3]) * m;
        }
    });
}

function applyInk() {
    if (ink === 'none' || !sel) return;
    const mode = ink;
    setInk('none');
    if (mode === 'erase') eraseSelection();
    else inkPixels(sel.mask.slice(), false);
}

// Draw and Curve paint onto a layer of their own, which is laid over the picture as it was when
// the stroke began. That keeps a stroke at one opacity where it crosses itself, and lets the
// selection limit it.
let stroke = null;      // { base: ImageData, layer: canvas, last }
let bend = null;        // the curve being made: { p0, p1, mouse, stage (1 = placing the end, 2 = bending), dragged }
let fillAt = -1;        // the pixel the Fill preview was last worked out for
let fillMask = null;
let bgRef = null;       // the colour Clear bg removes: [r, g, b], or null for the corner colour
let bgSeed = -1;

function beginStroke() {
    endLive();
    floating = null;
    pushHistory();
    stroke = { base: ctx.getImageData(0, 0, canvas.width, canvas.height), layer: newCanvas(() => {}) };
}

function brushLine(c, a, b) {
    c.lineCap = c.lineJoin = 'round';
    c.lineWidth = val('paint-size');
    c.strokeStyle = $('paint-colour').value;
    c.beginPath();
    c.moveTo(a[0] + 0.5, a[1] + 0.5);
    c.lineTo(b[0] + 0.5, b[1] + 0.5);
    c.stroke();
}

function composeStroke() {
    ctx.putImageData(stroke.base, 0, 0);
    ctx.globalAlpha = val('paint-opacity') / 100;
    ctx.globalCompositeOperation = ink === 'erase' ? 'destination-out' : 'source-over';
    ctx.drawImage(stroke.layer, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (sel) {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        blendSelection(img.data, stroke.base.data);
        ctx.putImageData(img, 0, 0);
    }
}

// The outline of the brush under the mouse, on the overlay.
function showBrush(e) {
    drawSelection();
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return;
    const [x, y] = canvasPoint(e);
    octx.lineWidth = Math.max(1, canvas.width / 300);
    octx.strokeStyle = '#000';
    octx.beginPath();
    octx.arc(x + 0.5, y + 0.5, val('paint-size') / 2, 0, Math.PI * 2);
    octx.stroke();
    octx.strokeStyle = '#fff';
    octx.setLineDash([octx.lineWidth * 2, octx.lineWidth * 2]);
    octx.stroke();
    octx.setLineDash([]);
}

defineTool('draw', {
    label: '✏️ Draw',
    title: 'Paint with a brush',
    hint: 'Drag to paint. Pick the colour, size and opacity above. Ink Erase rubs out instead. With a selection, you only paint inside it.',
    cursor: 'crosshair',
    keepsSelection: true,
    down(e, [x, y]) {
        beginStroke();
        stroke.last = [x, y];
        brushLine(stroke.layer.getContext('2d'), [x, y], [x, y]);
        composeStroke();
    },
    move(e) {
        if (!stroke) return showBrush(e);
        const at = canvasPoint(e);
        brushLine(stroke.layer.getContext('2d'), stroke.last, at);
        stroke.last = at;
        composeStroke();
    },
    up() {
        stroke = null;
    },
});

// The curve's control point is chosen so the curve passes through the mouse.
function bendPath(c, b) {
    const m = b.mouse || [(b.p0[0] + b.p1[0]) / 2, (b.p0[1] + b.p1[1]) / 2];
    const cx = 2 * m[0] - (b.p0[0] + b.p1[0]) / 2, cy = 2 * m[1] - (b.p0[1] + b.p1[1]) / 2;
    c.lineCap = 'round';
    c.lineWidth = val('paint-size');
    c.beginPath();
    c.moveTo(b.p0[0] + 0.5, b.p0[1] + 0.5);
    c.quadraticCurveTo(cx + 0.5, cy + 0.5, b.p1[0] + 0.5, b.p1[1] + 0.5);
}

function showBend() {
    drawSelection();
    if (!bend) return;
    const b = bend.stage === 1 ? { p0: bend.p0, p1: bend.mouse || bend.p0 } : bend;
    octx.globalAlpha = val('paint-opacity') / 100;
    octx.strokeStyle = ink === 'erase' ? '#fff' : $('paint-colour').value;
    bendPath(octx, b);
    octx.stroke();
    octx.globalAlpha = 1;
    const dot = Math.max(1, canvas.width / 300) * 1.5;
    octx.fillStyle = '#8ab4f8';
    for (const p of [bend.p0, bend.stage === 2 ? bend.p1 : null, bend.stage === 2 ? bend.mouse : null]) {
        if (p) octx.fillRect(p[0] + 0.5 - dot, p[1] + 0.5 - dot, dot * 2, dot * 2);
    }
}

function commitBend() {
    const b = bend;
    bend = null;
    if (!b || b.stage !== 2) return showBend();
    beginStroke();
    const c = stroke.layer.getContext('2d');
    c.strokeStyle = $('paint-colour').value;
    bendPath(c, b);
    c.stroke();
    composeStroke();
    stroke = null;
    drawSelection();
}

defineTool('curve', {
    label: '〰️ Curve',
    title: 'Draw a curved line',
    hint: 'Click where the line starts, click where it ends, move the mouse to bend it and click to put it down. Ink Erase rubs out along it. (Dragging from the start to the end works too.) Enter puts it down, Esc drops it.',
    cursor: 'crosshair',
    keepsSelection: true,
    down(e, [x, y]) {
        if (!bend) bend = { p0: [x, y], stage: 1, mouse: null };
        else if (bend.stage === 1) Object.assign(bend, { p1: [x, y], stage: 2, mouse: null });
        else { bend.mouse = [x, y]; return commitBend(); }
        showBend();
    },
    move(e) {
        if (!bend) return;
        bend.mouse = canvasPoint(e);
        if (bend.stage === 1 && pressed === TOOLS.curve && Math.hypot(bend.mouse[0] - bend.p0[0], bend.mouse[1] - bend.p0[1]) > 3) bend.dragged = true;
        showBend();
    },
    up() {
        if (bend && bend.stage === 1 && bend.dragged) Object.assign(bend, { p1: bend.mouse, stage: 2, mouse: null });
        showBend();
    },
    key(e) {
        if (!bend) return false;
        if (e.key === 'Enter') commitBend();
        else if (e.key === 'Escape' || e.key === 'Backspace') { bend = null; showBend(); }
        else return false;
        e.preventDefault();
        return true;
    },
});

// Fill: with a selection it paints the whole selection; without one it paints the area under the
// mouse (the pixels around it of nearly the same colour). The area is tinted before the click.
function floodMask(d, w, h, seed, maxDiff) {
    const out = new Uint8Array(w * h), stack = [seed], s = seed * 4;
    while (stack.length) {
        const idx = stack.pop();
        if (out[idx]) continue;
        const p = idx * 4;
        // A fully transparent pixel has no colour of its own, so only its transparency counts.
        const diff = !d[s + 3] || !d[p + 3] ? Math.abs(d[p + 3] - d[s + 3]) : Math.max(
            Math.abs(d[p] - d[s]), Math.abs(d[p + 1] - d[s + 1]), Math.abs(d[p + 2] - d[s + 2]), Math.abs(d[p + 3] - d[s + 3]));
        if (diff > maxDiff) continue;
        out[idx] = 255;
        const x = idx % w;
        if (x > 0) stack.push(idx - 1);
        if (x + 1 < w) stack.push(idx + 1);
        if (idx >= w) stack.push(idx - w);
        if (idx + w < w * h) stack.push(idx + w);
    }
    return out;
}

function fillTarget(at) {
    if (sel) return sel.mask;
    if (at < 0) return null;
    if (at !== fillAt || !fillMask) {
        fillAt = at;
        fillMask = floodMask(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, at, val('fill-tolerance') * 2.55);
    }
    return fillMask;
}

function showFill(at) {
    if (tool !== 'fill') return;
    drawSelection();
    const verb = ink === 'erase' ? 'Erases' : 'Fills';
    $('fill-what').textContent = sel ? `${verb} the whole selection` : `${verb} the area under the mouse`;
    const mask = fillTarget(at);
    if (!mask) return;
    const w = canvas.width, h = canvas.height, rgb = ink === 'erase' ? [255, 255, 255] : paintRgb();
    const img = new ImageData(w, h);
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        img.data[i * 4] = rgb[0]; img.data[i * 4 + 1] = rgb[1]; img.data[i * 4 + 2] = rgb[2];
        img.data[i * 4 + 3] = mask[i] * 0.55;
    }
    octx.drawImage(newCanvas(c => c.putImageData(img, 0, 0)), 0, 0);
}

const fillPoint = e => {
    const rect = canvas.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) return -1;
    const [x, y] = canvasPoint(e);
    return Math.min(y, canvas.height - 1) * canvas.width + Math.min(x, canvas.width - 1);
};

defineTool('fill', {
    label: '🪣 Fill',
    title: 'Fill the selection, or the area you click, with a colour',
    hint: 'With a selection, a click fills the whole selection. Without one, a click fills the area under the mouse. The area that will be filled is tinted first. Ink Erase clears it instead.',
    cursor: 'crosshair',
    keepsSelection: true,
    down(e) {
        const at = fillPoint(e);
        if (sel && ink === 'erase') return eraseSelection();
        const mask = fillTarget(at);
        if (!mask) return;
        inkPixels(mask.slice(), ink === 'erase');
        fillMask = null;
        showFill(at);
    },
    move(e) {
        if (!pressed) showFill(fillPoint(e));
    },
});

// Clear bg: makes the colour clicked (or the corner colour) transparent. Intensity is how far from
// that colour a pixel may be and still go; pixels near the limit go only part way.
function cornerColour(d, w, h) {
    for (const i of [0, w - 1, (h - 1) * w, h * w - 1]) if (d[i * 4 + 3]) return [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    return null;
}

function applyBgRemove() {
    if (!editing) return;
    floating = null;
    beginLive();
    const w = canvas.width, h = canvas.height, src = live.img.data;
    const ref = bgRef || cornerColour(src, w, h);
    $('bg-swatch').style.background = ref ? `rgb(${ref})` : 'transparent';
    const hi = val('bg-intensity') * 1.6, lo = hi * 0.5;
    if (!ref || hi < 1) return ctx.putImageData(live.img, 0, 0);
    const dist = new Float32Array(w * h), reach = new Uint8Array(w * h);
    for (let i = 0; i < dist.length; i++) {
        const p = i * 4;
        dist[i] = src[p + 3] ? Math.max(Math.abs(src[p] - ref[0]), Math.abs(src[p + 1] - ref[1]), Math.abs(src[p + 2] - ref[2])) : 0;
    }
    if ($('bg-edge').checked) {
        // Only what joins the picture's edge (or the clicked spot) through such pixels.
        const stack = [];
        const start = i => { if (dist[i] <= hi && !reach[i]) { reach[i] = 1; stack.push(i); } };
        for (let x = 0; x < w; x++) { start(x); start((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { start(y * w); start(y * w + w - 1); }
        if (bgSeed >= 0) start(bgSeed);
        while (stack.length) {
            const i = stack.pop(), x = i % w;
            if (x > 0) start(i - 1);
            if (x + 1 < w) start(i + 1);
            if (i >= w) start(i - w);
            if (i + w < w * h) start(i + w);
        }
    } else {
        for (let i = 0; i < reach.length; i++) reach[i] = dist[i] <= hi ? 1 : 0;
    }
    const img = new ImageData(new Uint8ClampedArray(src), w, h), d = img.data;
    for (let i = 0; i < reach.length; i++) {
        if (reach[i]) d[i * 4 + 3] = src[i * 4 + 3] * (dist[i] <= lo ? 0 : (dist[i] - lo) / (hi - lo));
    }
    blendSelection(d, src);
    ctx.putImageData(img, 0, 0);
}

defineTool('bgremove', {
    label: '🧽 Clear bg',
    title: 'Make a background colour transparent, with an intensity',
    hint: 'Click the background colour (or just move Intensity: the corner colour is used). Higher intensity clears colours further from it. A new click keeps the last result and starts again. With a selection, only the selected area is cleared.',
    cursor: 'crosshair',
    keepsSelection: true,
    down(e, [x, y]) {
        endLive();
        beginLive();
        const i = Math.min(y, canvas.height - 1) * canvas.width + Math.min(x, canvas.width - 1), s = live.img.data;
        if (!s[i * 4 + 3]) return;
        bgRef = [s[i * 4], s[i * 4 + 1], s[i * 4 + 2]];
        bgSeed = i;
        applyBgRemove();
    },
});

defineOptions('draw curve fill', `${INK_PICK}
    <input type="color" id="paint-colour" value="#e11d48" title="Colour">
    <label class="hint" data-only="draw curve">Size <input type="range" id="paint-size" min="1" max="64" value="4"><input type="number" class="num" min="1" max="64" value="4">px</label>
    <label class="hint" data-only="draw curve">Opacity <input type="range" id="paint-opacity" min="1" max="100" value="100"><input type="number" class="num" min="1" max="100" value="100">%</label>
    <label class="hint" data-only="fill">Tolerance <input type="range" id="fill-tolerance" min="0" max="100" value="10"><input type="number" class="num" min="0" max="100" value="10">%</label>
    <span class="hint" id="fill-what" data-only="fill"></span>`);

defineOptions('bgremove', `
    <span id="bg-swatch" title="The colour being cleared" style="width:18px;height:18px;border:1px solid #888;display:inline-block;"></span>
    <label class="hint">Intensity <input type="range" id="bg-intensity" min="0" max="100" value="30"><input type="number" class="num" min="0" max="100" value="30">%</label>
    <label class="hint"><input type="checkbox" id="bg-edge" checked> Only what touches the edge</label>`);

$('bg-intensity').addEventListener('input', applyBgRemove);
$('bg-edge').addEventListener('change', () => { if (live && tool === 'bgremove') applyBgRemove(); });
$('fill-tolerance').addEventListener('input', () => { fillMask = null; showFill(fillAt); });
$('paint-colour').addEventListener('input', () => {
    $('sel-colour').value = $('paint-colour').value;
    showFill(fillAt);
    if (tool === 'curve') showBend();
});
$('sel-colour').addEventListener('input', () => {
    $('paint-colour').value = $('sel-colour').value;
    $('paint-colour').dispatchEvent(new Event('input'));
});
$('tool-options').addEventListener('click', e => {
    const pick = e.target.closest('[data-ink]');
    if (pick) setInk(pick.dataset.ink);
});
setInk('none');

// Each tool starts clean when it is picked.
const pickTool = window.setTool;
window.setTool = function(name) {
    stroke = bend = fillMask = bgRef = null;
    fillAt = bgSeed = -1;
    pickTool(name);
    if (name === 'fill') showFill(-1);
};
