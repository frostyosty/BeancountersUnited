// src/features/admin/headerEditor.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { useAppStore } from '@/store/appStore.js';
import { supabase } from '@/supabaseClient.js';
import { generateHeaderSVG } from '../../utils/uiUtils';

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
    // 1. Get existing config or default
    const { settings } = useAppStore.getState().siteSettings;
    const currentConfig = settings.headerLogoConfig || { ...DEFAULT_CONFIG };

    // 2. Generate Modal HTML
    const fonts = [
        "'Oswald', sans-serif", "'Roboto Slab', serif", "'Anton', sans-serif", 
        "'Pacifico', cursive", "'Bebas Neue', cursive", "'Righteous', cursive", 
        "Arial, sans-serif", "'Merriweather', serif"
    ];
    
    const fontOptions = fonts.map(f => `<option value="${f}">${f.split(',')[0].replace(/'/g, '')}</option>`).join('');

    const modalHTML = `
        <div class="modal-form-container" style="max-width:800px; width:95%;">
            <h3>Header Logo Creator</h3>
            
            <!-- PREVIEW AREA -->
            <div id="header-preview-container" style="border:1px solid #ddd; margin-bottom:20px; box-shadow:0 2px 5px rgba(0,0,0,0.1);">
                <!-- SVG Injected Here -->
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                <!-- LEFT COLUMN: Colors & Background -->
                <div>
                    <h4>Background & Colors</h4>
                    <div class="he-grid">
                        <div><label>Background</label><input type="color" id="he-bg-color" value="${currentConfig.bgColor}"></div>
                        <div><label>Accent</label><input type="color" id="he-accent-color" value="${currentConfig.accentColor}"></div>
                        <div><label>Text Color</label><input type="color" id="he-text-color" value="${currentConfig.textColor}"></div>
                        <div>
                            <label>Pattern</label>
                            <select id="he-pattern">
                                <option value="none">None</option>
                                <option value="stripes">Stripes</option>
                                <option value="circle">Circles</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- RIGHT COLUMN: Text Settings -->
                <div>
                    <h4>Main Text</h4>
                    <input type="text" id="he-main-text" value="${currentConfig.mainText}" style="width:100%; margin-bottom:5px;">
                    <div class="he-grid">
                        <select id="he-main-font">${fontOptions}</select>
                        <input type="number" id="he-main-size" value="${currentConfig.mainSize}">
                        <div><label>Pos X%</label><input type="range" id="he-main-x" min="0" max="100" value="${currentConfig.mainX}"></div>
                        <div><label>Pos Y%</label><input type="range" id="he-main-y" min="0" max="100" value="${currentConfig.mainY}"></div>
                    </div>

                    <h4 style="margin-top:10px;">Sub Text</h4>
                    <input type="text" id="he-sub-text" value="${currentConfig.subText}" style="width:100%; margin-bottom:5px;">
                    <div class="he-grid">
                        <select id="he-sub-font">${fontOptions}</select>
                        <input type="number" id="he-sub-size" value="${currentConfig.subSize}">
                        <div><label>Pos X%</label><input type="range" id="he-sub-x" min="0" max="100" value="${currentConfig.subX}"></div>
                        <div><label>Pos Y%</label><input type="range" id="he-sub-y" min="0" max="100" value="${currentConfig.subY}"></div>
                    </div>
                </div>
            </div>

            <div class="form-actions-split" style="margin-top:20px; padding-top:20px; border-top:1px solid #eee;">
                <button type="button" id="he-reset-btn" class="button-secondary">Reset to Defaults</button>
                <button type="button" id="he-save-btn" class="button-primary">Save & Apply Header</button>
            </div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // 3. Attach Listeners & Init
    const inputs = document.querySelectorAll('#header-preview-container ~ div input, #header-preview-container ~ div select');
    
    // Set initial selects
    document.getElementById('he-pattern').value = currentConfig.pattern;
    document.getElementById('he-main-font').value = currentConfig.mainFont;
    document.getElementById('he-sub-font').value = currentConfig.subFont;

    const updateUI = () => {
        const config = scrapeConfig();
        const svg = generateHeaderSVG(config);
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
            
            // Apply immediately
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

// Helper to read all inputs
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

