import { getFontOptionsHTML } from './defaults.js';

export function getHeaderEditorHTML(config, displayString) {
    const fontOptions = getFontOptionsHTML();

    return `
        <div class="he-modal-wrapper">
            <h3 class="he-title">Header Logo Creator</h3>
            <div id="header-preview-container" class="he-preview-box"></div>

            <div class="he-controls-container">
                <!-- LEFT: GLOBAL & BG -->
                <div class="he-column">
                    <h4 class="he-subtitle">Background</h4>
                    <div class="he-input-group"><label>Bg Color</label><div class="he-color-picker-wrapper"><input type="color" id="he-bg-color" value="${config.bgColor}"><span class="he-color-value"></span></div></div>
                    <div class="he-input-group"><label>Accent</label><div class="he-color-picker-wrapper"><input type="color" id="he-accent-color" value="${config.accentColor}"><span class="he-color-value"></span></div></div>
                    <div class="he-input-group"><label>Base Text</label><div class="he-color-picker-wrapper"><input type="color" id="he-text-color" value="${config.textColor}"><span class="he-color-value"></span></div></div>
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
                        <div class="he-range-row"><span>Size</span> <input type="range" id="he-img-size" min="10" max="200" value="${config.imgSize}"></div>
                        <div class="he-range-row"><span>X</span> <input type="range" id="he-img-x" min="0" max="100" value="${config.imgX}"></div>
                        <div class="he-range-row"><span>Y</span> <input type="range" id="he-img-y" min="0" max="100" value="${config.imgY}"></div>
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
                        <input type="number" id="he-main-size" value="${config.mainSize}" class="he-number-input">
                    </div>
                    
                    <div class="he-range-group">
                         <label>Base Pos & Weight</label>
                         <div class="he-range-row"><span>X</span><input type="range" id="he-main-x" min="0" max="100" value="${config.mainX}"></div>
                         <div class="he-range-row"><span>Y</span><input type="range" id="he-main-y" min="0" max="100" value="${config.mainY}"></div>
                         <div class="he-range-row"><span>B</span><input type="range" id="he-main-weight" min="100" max="900" step="100" value="${config.mainWeight}"></div>
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
                    <input type="text" id="he-sub-text" value="${config.subText}" class="he-text-input">
                    <div class="he-range-group">
                         <div class="he-range-row"><span>Size</span><input type="number" id="he-sub-size" value="${config.subSize}"></div>
                         <div class="he-range-row"><span>X</span><input type="range" id="he-sub-x" min="0" max="100" value="${config.subX}"></div>
                         <div class="he-range-row"><span>Y</span><input type="range" id="he-sub-y" min="0" max="100" value="${config.subY}"></div>
                         <div class="he-range-row"><span>B</span><input type="range" id="he-sub-weight" min="100" max="900" step="100" value="${config.subWeight}"></div>
                    </div>
                </div>
            </div>
            <div class="he-actions"><button type="button" id="he-save-btn" class="button-primary">Save & Apply</button></div>
        </div>
    `;
}