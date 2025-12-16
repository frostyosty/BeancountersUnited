// src/features/admin/headerEditor/logic.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js'; // Need store access
import { DEFAULT_CONFIG } from './defaults.js';

// Local State
let editorState = {
    config: {},
    selectedMainIndex: -1,
    mainLetters: [],
    isDirty: false // Track changes
};

export function initEditorLogic(initialConfig) {
    // 1. Reset State Completely (Fixes "Loading previous one" bug)
    editorState = {
        config: { ...DEFAULT_CONFIG, ...(initialConfig || {}) },
        selectedMainIndex: -1,
        mainLetters: [],
        isDirty: false
    };

    // Deep copy the letters array to avoid reference bugs
    if (typeof editorState.config.mainText === 'string') {
        editorState.mainLetters = editorState.config.mainText.split('').map(c => ({ char: c }));
    } else if (Array.isArray(editorState.config.mainText)) {
        editorState.mainLetters = JSON.parse(JSON.stringify(editorState.config.mainText));
    } else {
        editorState.mainLetters = [];
    }
    
    // Sync
    editorState.config.mainText = editorState.mainLetters;

    // 2. Attach Listeners
    attachGlobalInputs();
    attachMainTextInput();
    attachLetterControls();
    attachImageUpload();
    attachSaveButton();

    // 3. Hijack Close Logic (For Unsaved Prompt)
    hijackCloseBehavior();

    // 4. Initial Render
    const patternSelect = document.getElementById('he-pattern');
    if (patternSelect) patternSelect.value = editorState.config.pattern;
    
    renderChips();
    updatePreview();
}

function markDirty() {
    editorState.isDirty = true;
}

function hijackCloseBehavior() {
    // We need to replace the default close listeners with our own check
    const modalContent = document.querySelector('.modal-content');
    const closeBtn = document.querySelector('.modal-close-btn');
    const overlay = document.querySelector('.modal-overlay');

    const handleAttemptClose = (e) => {
        e.stopPropagation();
        if (editorState.isDirty) {
            showUnsavedPrompt();
        } else {
            uiUtils.closeModal();
        }
    };

    // Replace Close Button
    if (closeBtn) {
        const newBtn = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newBtn, closeBtn);
        newBtn.addEventListener('click', handleAttemptClose);
    }

    // Replace Overlay Click
    if (overlay) {
        // uiUtils attaches click to overlay. We can't easily remove that anonymous function.
        // But we can intercept the click if we capture it on the wrapper or stop propagation?
        // Easier: Just overwrite the overlay's onclick if it was set via JS property, 
        // but uiUtils uses addEventListener.
        // Strategy: Clone the overlay inner content to a new overlay? Too complex.
        
        // Simple Strategy: Add a capture listener that stops prop if dirty
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                if (editorState.isDirty) {
                    e.stopImmediatePropagation(); // Stop uiUtils listener
                    e.preventDefault();
                    showUnsavedPrompt();
                }
            }
        }, true); // Capture phase!
    }
}

function showUnsavedPrompt() {
    // Check if already open
    if (document.querySelector('.he-unsaved-overlay')) return;

    const wrapper = document.querySelector('.he-modal-wrapper');
    const overlay = document.createElement('div');
    overlay.className = 'he-unsaved-overlay';
    overlay.innerHTML = `
        <div class="he-unsaved-box">
            <h4>Unsaved Changes</h4>
            <p>You have unsaved changes. Do you want to save them before closing?</p>
            <div class="he-unsaved-actions">
                <button id="he-prompt-discard" class="button-danger small">Discard</button>
                <button id="he-prompt-cancel" class="button-secondary small">Cancel</button>
                <button id="he-prompt-save" class="button-primary small">Save</button>
            </div>
        </div>
    `;
    
    // Make relative to position absolute overlay
    if (wrapper) {
        wrapper.style.position = 'relative';
        wrapper.appendChild(overlay);
    }

    document.getElementById('he-prompt-cancel').onclick = () => overlay.remove();
    document.getElementById('he-prompt-discard').onclick = () => uiUtils.closeModal();
    document.getElementById('he-prompt-save').onclick = () => document.getElementById('he-save-btn').click();
}

function updatePreview() {
    editorState.config.mainText = editorState.mainLetters;
    const svg = uiUtils.generateHeaderSVG(editorState.config);
    const container = document.getElementById('header-preview-container');
    if (container) container.innerHTML = svg;

    document.querySelectorAll('input[type="color"]').forEach(input => {
        const span = input.nextElementSibling;
        if (span && span.classList.contains('he-color-value')) span.textContent = input.value;
    });
}

function attachGlobalInputs() {
    const bind = (id, key) => {
        const el = document.getElementById(id);
        if (el) {
            if (editorState.config[key] !== undefined) el.value = editorState.config[key];
            el.addEventListener('input', (e) => {
                editorState.config[key] = e.target.value;
                markDirty();
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
        markDirty();
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
            markDirty();
            updatePreview();
        });
    });

    document.getElementById('hl-reset').onclick = () => {
        if (editorState.selectedMainIndex === -1) return;
        const char = editorState.mainLetters[editorState.selectedMainIndex].char;
        editorState.mainLetters[editorState.selectedMainIndex] = { char };
        populateLetterControls({ char });
        markDirty();
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
            markDirty();
            updatePreview();
        } catch (e) {
            console.error(e);
            dropZone.innerHTML = "Error";
        }
    }

    removeBtn.onclick = () => {
        editorState.config.imgUrl = '';
        dropZone.innerHTML = "Drop Icon Here";
        markDirty();
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
            
            // FIX: Refresh the store immediately so subsequent opens get the new data
            await useAppStore.getState().siteSettings.fetchSiteSettings(true);

            uiUtils.applyHeaderLogo(editorState.config);
            uiUtils.showToast("Header Saved!", "success");
            
            // Clear dirty flag so we can close without prompt
            editorState.isDirty = false;
            uiUtils.closeModal();
        } catch (e) {
            uiUtils.showToast("Save Failed", "error");
            btn.disabled = false;
        }
    };
}