import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';

// Defaults
const DEFAULT_CONFIG = {
    bgColor: '#263238', accentColor: '#f57c00', textColor: '#ffffff', pattern: 'none',
    mainText: 'MEALMATES', mainX: 50, mainY: 45, mainFont: "'Oswald', sans-serif", mainSize: 40, mainWeight: 700,
    subText: 'Food & Coffee', subX: 50, subY: 70, subFont: "Arial, sans-serif", subSize: 16, subWeight: 400,
    imgUrl: '', imgX: 80, imgY: 50, imgSize: 60
};

// State for the editor instance
let editorState = {
    config: {},
    selectedMainIndex: -1, 
    mainLetters: [] 
};

export function openHeaderLogoEditor() {
    const { settings } = useAppStore.getState().siteSettings;
    let savedConfig = settings.headerLogoConfig;

    // --- FIX: Safety Parse ---
    // If API returned a string (due to whitelist miss), parse it manually.
    if (typeof savedConfig === 'string') {
        try {
            savedConfig = JSON.parse(savedConfig);
        } catch (e) {
            console.error("Failed to parse header config:", e);
            savedConfig = {};
        }
    }
    
    // Debug Log: Check what we are actually loading
    console.log("[HeaderEditor] Loading Config:", savedConfig);

    // Merge Defaults
    editorState.config = { ...DEFAULT_CONFIG, ...(savedConfig || {}) };
    
    // Initialize Letters Array
    if (typeof editorState.config.mainText === 'string') {
        editorState.mainLetters = editorState.config.mainText.split('').map(c => ({ char: c }));
    } else if (Array.isArray(editorState.config.mainText)) {
        editorState.mainLetters = JSON.parse(JSON.stringify(editorState.config.mainText)); 
    } else {
        editorState.mainLetters = [];
    }

    // Sync back
    editorState.config.mainText = editorState.mainLetters;

    // Font Options
     const fonts = [
        "'Oswald', sans-serif",       // Strong / Industrial
        "'Playfair Display', serif",   // Elegant / Luxury
        "'Bebas Neue', cursive",      // Tall / Bold
        "'Dancing Script', cursive",  // Flowing / Artsy
        "'Pacifico', cursive",        // Friendly / Retro
        "'Montserrat', sans-serif",   // Modern / Clean
        "'Roboto Slab', serif",       // Classic / Strong
        "'Righteous', cursive",       // Modern / Tech
        "'Merriweather', serif",      // Traditional
        "Arial, sans-serif"           // Fallback
    ];
    
    // Create dropdown options
    // Fix: Show clean names in the dropdown (remove quotes and fallbacks for display)
    const fontOptions = fonts.map(f => {
        const cleanName = f.split(',')[0].replace(/'/g, '');
        return `<option value="${f}">${cleanName}</option>`;
    }).join('');

    
    // Helper to get string for input display
    const displayString = editorState.mainLetters.map(l => l.char).join('');

    const modalHTML = `
        <div class="he-modal-wrapper">
            <h3 class="he-title">Header Logo Creator</h3>
            <div id="header-preview-container" class="he-preview-box"></div>

            <div class="he-controls-container">
                <!-- LEFT: GLOBAL & BG -->
                <div class="he-column">
                    <h4 class="he-subtitle">Background</h4>
                    <div class="he-input-group"><label>Bg Color</label><div class="he-color-picker-wrapper"><input type="color" id="he-bg-color" value="${editorState.config.bgColor}"><span class="he-color-value"></span></div></div>
                    <div class="he-input-group"><label>Accent</label><div class="he-color-picker-wrapper"><input type="color" id="he-accent-color" value="${editorState.config.accentColor}"><span class="he-color-value"></span></div></div>
                    <div class="he-input-group"><label>Base Text</label><div class="he-color-picker-wrapper"><input type="color" id="he-text-color" value="${editorState.config.textColor}"><span class="he-color-value"></span></div></div>
                    <div class="he-input-group">
                        <label>Pattern</label>
                        <select id="he-pattern" class="he-select">
                            <option value="none">None</option>
                            <option value="stripes">Stripes</option>
                            <option value="circle">Dots</option>
                        </select>
                    </div>
                    
                    <h4 class="he-subtitle" style="margin-top:15px;">Icon Image</h4>
                    <div id="he-drop-zone" class="he-drop-zone"><p>Drop Icon Here</p><input type="file" id="he-img-upload" style="display:none;"></div>
                    <div class="he-range-group">
                        <div class="he-range-row"><span>Size</span> <input type="range" id="he-img-size" min="10" max="200" value="${editorState.config.imgSize}"></div>
                        <div class="he-range-row"><span>X</span> <input type="range" id="he-img-x" min="0" max="100" value="${editorState.config.imgX}"></div>
                        <div class="he-range-row"><span>Y</span> <input type="range" id="he-img-y" min="0" max="100" value="${editorState.config.imgY}"></div>
                    </div>
                    <button type="button" id="he-remove-img" class="button-danger small" style="width:100%; margin-top:5px;">Remove Icon</button>
                </div>

                <!-- RIGHT: TEXT & LETTERS -->
                <div class="he-column">
                    <h4 class="he-subtitle">Main Title</h4>
                    
                    <!-- 1. Base Input -->
                    <input type="text" id="he-main-input" value="${displayString}" class="he-text-input" placeholder="Type Title Here...">
                    
                    <!-- 2. Base Controls -->
                    <div class="he-row" style="margin-top:5px;">
                        <select id="he-main-font" class="he-select" style="flex:2;">${fontOptions}</select>
                        <input type="number" id="he-main-size" value="${editorState.config.mainSize}" class="he-number-input">
                    </div>
                    
                    <div class="he-range-group">
                         <label>Base Pos & Weight</label>
                         <div class="he-range-row"><span>X</span><input type="range" id="he-main-x" min="0" max="100" value="${editorState.config.mainX}"></div>
                         <div class="he-range-row"><span>Y</span><input type="range" id="he-main-y" min="0" max="100" value="${editorState.config.mainY}"></div>
                         <div class="he-range-row"><span>B</span><input type="range" id="he-main-weight" min="100" max="900" step="100" value="${editorState.config.mainWeight}"></div>
                    </div>

                    <!-- 3. LETTER CHIPS -->
                    <label style="font-size:0.85rem; font-weight:bold; margin-top:10px; display:block;">Advanced Letter Edit</label>
                    <div id="he-letter-chips" class="he-letter-row"></div>

                    <!-- 4. INDIVIDUAL LETTER CONTROLS -->
                    <div id="he-letter-controls" class="he-adv-controls">
                        <p style="margin:0 0 5px 0; font-size:0.8rem; font-weight:bold;">Editing Letter: <span id="he-selected-char" style="color:var(--primary-color)"></span></p>
                        
                        <div class="he-mini-row"><span class="he-mini-label">Color</span> <input type="color" id="hl-color"></div>
                        <div class="he-mini-row"><span class="he-mini-label">Font</span> <select id="hl-font" class="he-mini-input">${fontOptions}</select></div>
                        <div class="he-mini-row"><span class="he-mini-label">Size</span> <input type="number" id="hl-size" class="he-mini-input"></div>
                        <div class="he-mini-row"><span class="he-mini-label">Rotate</span> <input type="range" id="hl-rotate" min="-180" max="180" class="he-mini-input"></div>
                        <div class="he-mini-row"><span class="he-mini-label">Y-Off</span> <input type="range" id="hl-dy" min="-50" max="50" class="he-mini-input"></div>
                        <div class="he-mini-row"><span class="he-mini-label">Kern</span> <input type="range" id="hl-dx" min="-20" max="50" class="he-mini-input"></div>
                        
                        <button id="hl-reset" class="button-secondary small" style="width:100%; margin-top:5px;">Reset Letter</button>
                    </div>

                    <!-- SUB TITLE (Simple) -->
                    <h4 class="he-subtitle" style="margin-top:15px;">Sub-Title</h4>
                    <input type="text" id="he-sub-text" value="${editorState.config.subText}" class="he-text-input">
                    <div class="he-range-group">
                         <div class="he-range-row"><span>Size</span><input type="number" id="he-sub-size" value="${editorState.config.subSize}"></div>
                         <div class="he-range-row"><span>X</span><input type="range" id="he-sub-x" min="0" max="100" value="${editorState.config.subX}"></div>
                         <div class="he-range-row"><span>Y</span><input type="range" id="he-sub-y" min="0" max="100" value="${editorState.config.subY}"></div>
                         <div class="he-range-row"><span>B</span><input type="range" id="he-sub-weight" min="100" max="900" step="100" value="${editorState.config.subWeight}"></div>
                    </div>
                </div>
            </div>
            <div class="he-actions"><button type="button" id="he-save-btn" class="button-primary">Save & Apply</button></div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // --- Render Preview ---
    const updatePreview = () => {
        // Ensure config object has latest letters array
        editorState.config.mainText = editorState.mainLetters;
        
        // Render SVG
        const svg = uiUtils.generateHeaderSVG(editorState.config);
        const previewContainer = document.getElementById('header-preview-container');
        if(previewContainer) previewContainer.innerHTML = svg;

        // Update color value labels
        document.querySelectorAll('input[type="color"]').forEach(input => {
            const span = input.nextElementSibling;
            if (span && span.classList.contains('he-color-value')) span.textContent = input.value;
        });
    };

    // --- State Binding Helper ---
    const bind = (id, key) => {
        const el = document.getElementById(id);
        if(el) {
            // Set Initial Value from Config
            el.value = editorState.config[key] || '';
            
            // Bind Event
            el.addEventListener('input', (e) => {
                editorState.config[key] = e.target.value;
                updatePreview();
            });
        }
    };

    // Bind Global Inputs
    bind('he-bg-color', 'bgColor');
    bind('he-accent-color', 'accentColor');
    bind('he-text-color', 'textColor');
    bind('he-pattern', 'pattern');
    
    // Bind Main Base Props
    bind('he-main-font', 'mainFont');
    bind('he-main-size', 'mainSize');
    bind('he-main-x', 'mainX');
    bind('he-main-y', 'mainY');
    bind('he-main-weight', 'mainWeight');

    // Bind Sub Props
    bind('he-sub-text', 'subText');
    bind('he-sub-font', 'subFont');
    bind('he-sub-size', 'subSize');
    bind('he-sub-x', 'subX');
    bind('he-sub-y', 'subY');
    bind('he-sub-weight', 'subWeight');

    // Bind Image Props
    bind('he-img-size', 'imgSize');
    bind('he-img-x', 'imgX');
    bind('he-img-y', 'imgY');


    // --- Main Text Input (Rebuilds Letters Array) ---
    const mainInput = document.getElementById('he-main-input');
    mainInput.addEventListener('input', (e) => {
        const newStr = e.target.value.toUpperCase();
        const newArr = newStr.split('').map((c, i) => {
            const oldObj = editorState.mainLetters[i];
            // Preserve style if just replacing char, else new defaults
            if (oldObj) return { ...oldObj, char: c }; 
            return { char: c };
        });
        editorState.mainLetters = newArr;
        editorState.selectedMainIndex = -1; // Reset selection
        renderChips();
        updatePreview();
    });

    // --- Chip Rendering ---
    function renderChips() {
        const container = document.getElementById('he-letter-chips');
        container.innerHTML = editorState.mainLetters.map((l, i) => `
            <div class="he-letter-chip ${i === editorState.selectedMainIndex ? 'selected' : ''}" 
                 data-index="${i}">${l.char}</div>
        `).join('');
        
        // Toggle Controls Visibility
        const controls = document.getElementById('he-letter-controls');
        if (editorState.selectedMainIndex > -1) {
            controls.classList.add('active');
            populateLetterControls(editorState.mainLetters[editorState.selectedMainIndex]);
        } else {
            controls.classList.remove('active');
        }
    }

    // --- Chip Click ---
    document.getElementById('he-letter-chips').addEventListener('click', (e) => {
        const chip = e.target.closest('.he-letter-chip');
        if (chip) {
            editorState.selectedMainIndex = parseInt(chip.dataset.index);
            renderChips();
        }
    });

    // --- Individual Letter Controls ---
    function populateLetterControls(letterObj) {
        document.getElementById('he-selected-char').textContent = letterObj.char;
        document.getElementById('hl-color').value = letterObj.color || editorState.config.textColor;
        document.getElementById('hl-font').value = letterObj.font || editorState.config.mainFont;
        document.getElementById('hl-size').value = letterObj.size || editorState.config.mainSize;
        document.getElementById('hl-rotate').value = letterObj.rotate || 0;
        document.getElementById('hl-dy').value = letterObj.dy || 0;
        document.getElementById('hl-dx').value = letterObj.dx || 0;
    }

    ['hl-color', 'hl-font', 'hl-size', 'hl-rotate', 'hl-dy', 'hl-dx'].forEach(id => {
        document.getElementById(id).addEventListener('input', (e) => {
            if (editorState.selectedMainIndex === -1) return;
            const key = id.replace('hl-', '');
            const val = e.target.value;
            
            editorState.mainLetters[editorState.selectedMainIndex][key] = val;
            updatePreview();
        });
    });
    
    document.getElementById('hl-reset').onclick = () => {
        if (editorState.selectedMainIndex === -1) return;
        const char = editorState.mainLetters[editorState.selectedMainIndex].char;
        editorState.mainLetters[editorState.selectedMainIndex] = { char }; // Reset to clean obj
        populateLetterControls({ char }); // Update inputs
        updatePreview();
    };

    // --- Image Upload ---
    const dropZone = document.getElementById('he-drop-zone');
    const fileInput = document.getElementById('he-img-upload');
    dropZone.onclick = () => fileInput.click();
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault(); dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if(file) uploadImg(file);
    });
    fileInput.addEventListener('change', (e) => { if(e.target.files[0]) uploadImg(e.target.files[0]); });

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
        } catch(e) {
            console.error(e);
            dropZone.innerHTML = "Error";
        }
    }
    document.getElementById('he-remove-img').onclick = () => {
        editorState.config.imgUrl = '';
        dropZone.innerHTML = "Drop Icon Here";
        updatePreview();
    }

    // --- SAVE ---
    document.getElementById('he-save-btn').onclick = async () => {
        const btn = document.getElementById('he-save-btn');
        btn.textContent = "Saving..."; btn.disabled = true;
        try {
            // Force sync of letters
            editorState.config.mainText = editorState.mainLetters;
            
            await api.updateSiteSettings({ headerLogoConfig: editorState.config }, (await supabase.auth.getSession()).data.session.access_token);
            uiUtils.applyHeaderLogo(editorState.config);
            uiUtils.showToast("Header Saved!", "success");
            uiUtils.closeModal();
        } catch(e) {
            console.error(e);
            uiUtils.showToast("Save Failed", "error");
            btn.disabled = false;
        }
    };

    // Initial Calls
    document.getElementById('he-pattern').value = editorState.config.pattern; 
    renderChips();
    updatePreview();
}