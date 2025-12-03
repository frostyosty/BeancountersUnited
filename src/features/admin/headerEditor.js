// src/features/admin/headerEditor.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';

// Default Config
const DEFAULT_CONFIG = {
    bgColor: '#263238',
    accentColor: '#f57c00',
    textColor: '#ffffff',
    pattern: 'none',
    mainText: 'MEALMATES',
    mainX: 50, mainY: 45,
    mainFont: "'Oswald', sans-serif",
    mainSize: 40,
    subText: 'Delicious Food & Coffee',
    subX: 50, subY: 70,
    subFont: "Arial, sans-serif",
    subSize: 16
};

export function openHeaderLogoEditor() {
    const { settings } = useAppStore.getState().siteSettings;
    const currentConfig = settings.headerLogoConfig || { ...DEFAULT_CONFIG };

    const fonts = [
        "'Oswald', sans-serif", "'Roboto Slab', serif", "'Anton', sans-serif", 
        "'Pacifico', cursive", "'Bebas Neue', cursive", "'Righteous', cursive", 
        "Arial, sans-serif", "'Merriweather', serif"
    ];
    
    const fontOptions = fonts.map(f => `<option value="${f}">${f.split(',')[0].replace(/'/g, '')}</option>`).join('');

    // --- UPDATED HTML STRUCTURE (Using 'he-' classes) ---
    const modalHTML = `
        <div class="he-modal-wrapper">
            <h3 class="he-title">Header Logo Creator</h3>
            
            <!-- PREVIEW -->
            <div id="header-preview-container" class="he-preview-box">
                <!-- SVG Injected Here -->
            </div>

            <div class="he-controls-container">
                <!-- LEFT COLUMN: Appearance -->
                <div class="he-column">
                    <h4 class="he-subtitle">Background & Palette</h4>
                    
                    <div class="he-input-group">
                        <label>Background Color</label>
                        <div class="he-color-picker-wrapper">
                            <input type="color" id="he-bg-color" value="${currentConfig.bgColor}">
                            <span class="he-color-value">${currentConfig.bgColor}</span>
                        </div>
                    </div>

                    <div class="he-input-group">
                        <label>Accent / Decor</label>
                        <div class="he-color-picker-wrapper">
                            <input type="color" id="he-accent-color" value="${currentConfig.accentColor}">
                            <span class="he-color-value">${currentConfig.accentColor}</span>
                        </div>
                    </div>

                    <div class="he-input-group">
                        <label>Text Color</label>
                        <div class="he-color-picker-wrapper">
                            <input type="color" id="he-text-color" value="${currentConfig.textColor}">
                            <span class="he-color-value">${currentConfig.textColor}</span>
                        </div>
                    </div>

                    <div class="he-input-group">
                        <label>Pattern Overlay</label>
                        <select id="he-pattern" class="he-select">
                            <option value="none">None</option>
                            <option value="stripes">Stripes (Diagonal)</option>
                            <option value="circle">Dots</option>
                        </select>
                    </div>
                </div>

                <!-- RIGHT COLUMN: Typography -->
                <div class="he-column">
                    <h4 class="he-subtitle">Main Title</h4>
                    <input type="text" id="he-main-text" value="${currentConfig.mainText}" class="he-text-input" placeholder="Main Text">
                    
                    <div class="he-row">
                        <select id="he-main-font" class="he-select" style="flex:2;">${fontOptions}</select>
                        <input type="number" id="he-main-size" value="${currentConfig.mainSize}" class="he-number-input" title="Size">
                    </div>
                    
                    <div class="he-range-group">
                        <label>Position</label>
                        <div class="he-range-row">
                            <span>X</span> <input type="range" id="he-main-x" min="0" max="100" value="${currentConfig.mainX}">
                            <span>Y</span> <input type="range" id="he-main-y" min="0" max="100" value="${currentConfig.mainY}">
                        </div>
                    </div>

                    <div class="he-divider"></div>

                    <h4 class="he-subtitle">Sub-Title</h4>
                    <input type="text" id="he-sub-text" value="${currentConfig.subText}" class="he-text-input" placeholder="Sub Text">
                    
                    <div class="he-row">
                        <select id="he-sub-font" class="he-select" style="flex:2;">${fontOptions}</select>
                        <input type="number" id="he-sub-size" value="${currentConfig.subSize}" class="he-number-input" title="Size">
                    </div>

                    <div class="he-range-group">
                        <label>Position</label>
                        <div class="he-range-row">
                            <span>X</span> <input type="range" id="he-sub-x" min="0" max="100" value="${currentConfig.subX}">
                            <span>Y</span> <input type="range" id="he-sub-y" min="0" max="100" value="${currentConfig.subY}">
                        </div>
                    </div>
                </div>
            </div>

            <div class="he-actions">
                <button type="button" id="he-reset-btn" class="button-secondary">Reset</button>
                <button type="button" id="he-save-btn" class="button-primary">Save & Apply</button>
            </div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // --- Init Inputs ---
    document.getElementById('he-pattern').value = currentConfig.pattern;
    document.getElementById('he-main-font').value = currentConfig.mainFont;
    document.getElementById('he-sub-font').value = currentConfig.subFont;

    const inputs = document.querySelectorAll('.he-modal-wrapper input, .he-modal-wrapper select');
    
    const updateUI = () => {
        const config = scrapeConfig();
        // Update color labels
        document.querySelectorAll('input[type="color"]').forEach(input => {
            const span = input.nextElementSibling;
            if (span && span.classList.contains('he-color-value')) span.textContent = input.value;
        });
        const svg = uiUtils.generateHeaderSVG(config);
        document.getElementById('header-preview-container').innerHTML = svg;
    };

    inputs.forEach(el => el.addEventListener('input', updateUI));

    document.getElementById('he-save-btn').onclick = async () => {
        const btn = document.getElementById('he-save-btn');
        btn.textContent = "Saving...";
        btn.disabled = true;
        
        const finalConfig = scrapeConfig();
        const { data: { session } } = await supabase.auth.getSession();
        
        try {
            await api.updateSiteSettings({ headerLogoConfig: finalConfig }, session.access_token);
            uiUtils.applyHeaderLogo(finalConfig);
            uiUtils.showToast("Header logo updated!", "success");
            uiUtils.closeModal();
        } catch (e) {
            console.error(e);
            uiUtils.showToast("Failed to save.", "error");
            btn.disabled = false;
        }
    };

    // Initial Render
    updateUI();
}

function scrapeConfig() {
    return {
        bgColor: document.getElementById('he-bg-color').value,
        accentColor: document.getElementById('he-accent-color').value,
        textColor: document.getElementById('he-text-color').value,
        pattern: document.getElementById('he-pattern').value,
        mainText: document.getElementById('he-main-text').value,
        mainFont: document.getElementById('he-main-font').value,
        mainSize: document.getElementById('he-main-size').value,
        mainX: document.getElementById('he-main-x').value,
        mainY: document.getElementById('he-main-y').value,
        subText: document.getElementById('he-sub-text').value,
        subFont: document.getElementById('he-sub-font').value,
        subSize: document.getElementById('he-sub-size').value,
        subX: document.getElementById('he-sub-x').value,
        subY: document.getElementById('he-sub-y').value,
    };
}