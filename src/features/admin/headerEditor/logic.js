import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { DEFAULT_CONFIG } from './defaults.js';

// Local State
let editorState = {
    config: {},
    selectedMainIndex: -1,
    mainLetters: []
};

export function initEditorLogic(initialConfig) {
    // 1. Setup State
    editorState.config = { ...DEFAULT_CONFIG, ...(initialConfig || {}) };

    if (typeof editorState.config.mainText === 'string') {
        editorState.mainLetters = editorState.config.mainText.split('').map(c => ({ char: c }));
    } else if (Array.isArray(editorState.config.mainText)) {
        editorState.mainLetters = JSON.parse(JSON.stringify(editorState.config.mainText));
    } else {
        editorState.mainLetters = [];
    }
    
    // Initial sync
    editorState.config.mainText = editorState.mainLetters;

    // 2. Attach Listeners
    attachGlobalInputs();
    attachMainTextInput();
    attachLetterControls();
    attachImageUpload();
    attachSaveButton();

    // 3. Initial Render
    document.getElementById('he-pattern').value = editorState.config.pattern;
    renderChips();
    updatePreview();
}

function updatePreview() {
    editorState.config.mainText = editorState.mainLetters;
    const svg = uiUtils.generateHeaderSVG(editorState.config);
    const container = document.getElementById('header-preview-container');
    if (container) container.innerHTML = svg;

    // Update color labels
    document.querySelectorAll('input[type="color"]').forEach(input => {
        const span = input.nextElementSibling;
        if (span && span.classList.contains('he-color-value')) span.textContent = input.value;
    });
}

function attachGlobalInputs() {
    const bind = (id, key) => {
        const el = document.getElementById(id);
        if (el) {
            // Safer default handling
            if (editorState.config[key] !== undefined) el.value = editorState.config[key];
            el.addEventListener('input', (e) => {
                editorState.config[key] = e.target.value;
                updatePreview();
            });
        }
    };

    ['bgColor', 'accentColor', 'textColor', 'pattern'].forEach(k => bind(`he-${k.replace(/[A-Z]/g, m=>'-'+m.toLowerCase())}`, k));
    ['mainFont', 'mainSize', 'mainX', 'mainY', 'mainWeight'].forEach(k => bind(`he-${k.replace(/[A-Z]/g, m=>'-'+m.toLowerCase())}`, k));
    ['subText', 'subFont', 'subSize', 'subX', 'subY', 'subWeight'].forEach(k => bind(`he-${k.replace(/[A-Z]/g, m=>'-'+m.toLowerCase())}`, k));
    ['imgSize', 'imgX', 'imgY'].forEach(k => bind(`he-${k.replace(/[A-Z]/g, m=>'-'+m.toLowerCase())}`, k));
}

function attachMainTextInput() {
    const mainInput = document.getElementById('he-main-input');
    if (!mainInput) return;
    
    mainInput.addEventListener('input', (e) => {
        const newStr = e.target.value.toUpperCase();
        const newArr = newStr.split('').map((c, i) => {
            const oldObj = editorState.mainLetters[i];
            if (oldObj) return { ...oldObj, char: c };
            return { char: c };
        });
        editorState.mainLetters = newArr;
        editorState.selectedMainIndex = -1; 
        renderChips();
        updatePreview();
    });
}

function renderChips() {
    const container = document.getElementById('he-letter-chips');
    if (!container) return;
    
    container.innerHTML = editorState.mainLetters.map((l, i) => `
        <div class="he-letter-chip ${i === editorState.selectedMainIndex ? 'selected' : ''}" 
             data-index="${i}">${l.char}</div>
    `).join('');

    const controls = document.getElementById('he-letter-controls');
    if (editorState.selectedMainIndex > -1) {
        controls.classList.add('active');
        populateLetterControls(editorState.mainLetters[editorState.selectedMainIndex]);
    } else {
        controls.classList.remove('active');
    }
}

function populateLetterControls(letterObj) {
    document.getElementById('he-selected-char').textContent = letterObj.char;
    document.getElementById('hl-color').value = letterObj.color || editorState.config.textColor;
    document.getElementById('hl-font').value = letterObj.font || editorState.config.mainFont;
    document.getElementById('hl-size').value = letterObj.size || editorState.config.mainSize;
    document.getElementById('hl-rotate').value = letterObj.rotate || 0;
    document.getElementById('hl-dy').value = letterObj.dy || 0;
    document.getElementById('hl-dx').value = letterObj.dx || 0;
}

function attachLetterControls() {
    document.getElementById('he-letter-chips').addEventListener('click', (e) => {
        const chip = e.target.closest('.he-letter-chip');
        if (chip) {
            editorState.selectedMainIndex = parseInt(chip.dataset.index);
            renderChips();
        }
    });

    ['hl-color', 'hl-font', 'hl-size', 'hl-rotate', 'hl-dy', 'hl-dx'].forEach(id => {
        document.getElementById(id).addEventListener('input', (e) => {
            if (editorState.selectedMainIndex === -1) return;
            const key = id.replace('hl-', '');
            editorState.mainLetters[editorState.selectedMainIndex][key] = e.target.value;
            updatePreview();
        });
    });

    document.getElementById('hl-reset').onclick = () => {
        if (editorState.selectedMainIndex === -1) return;
        const char = editorState.mainLetters[editorState.selectedMainIndex].char;
        editorState.mainLetters[editorState.selectedMainIndex] = { char };
        populateLetterControls({ char });
        updatePreview();
    };
}

function attachImageUpload() {
    const dropZone = document.getElementById('he-drop-zone');
    const fileInput = document.getElementById('he-img-upload');
    const removeBtn = document.getElementById('he-remove-img');

    dropZone.onclick = () => fileInput.click();
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) uploadImg(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', (e) => { if (e.target.files[0]) uploadImg(e.target.files[0]); });

    async function uploadImg(file) {
        dropZone.innerHTML = "Uploading...";
        try {
            const fileExt = file.name.split('.').pop();
            const fileName = `header-assets/${Date.now()}.${fileExt}`;
            await supabase.storage.from('menu-images').upload(fileName, file);
            const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
            editorState.config.imgUrl = data.publicUrl;
            dropZone.innerHTML = "✅ Loaded";
            updatePreview();
        } catch (e) {
            console.error(e);
            dropZone.innerHTML = "Error";
        }
    }

    removeBtn.onclick = () => {
        editorState.config.imgUrl = '';
        dropZone.innerHTML = "Drop Icon Here";
        updatePreview();
    };
}

function attachSaveButton() {
    document.getElementById('he-save-btn').onclick = async () => {
        const btn = document.getElementById('he-save-btn');
        btn.textContent = "Saving..."; btn.disabled = true;
        try {
            editorState.config.mainText = editorState.mainLetters;
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateSiteSettings({ headerLogoConfig: editorState.config }, session.access_token);
            uiUtils.applyHeaderLogo(editorState.config);
            uiUtils.showToast("Header Saved!", "success");
            uiUtils.closeModal();
        } catch (e) {
            uiUtils.showToast("Save Failed", "error");
            btn.disabled = false;
        }
    };
}