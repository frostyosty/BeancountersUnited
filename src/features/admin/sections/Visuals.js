import * as uiUtils from '@/utils/uiUtils.js';

export function renderAppearanceSection(settings) {
    const bgImage = settings.themeVariables?.['--body-background-image']?.replace(/url\(['"]?|['"]?\)/g, '') || '';
    const bgColor = settings.themeVariables?.['--background-color'] || '#ffffff';
    const uiConfig = settings.uiConfig || {}; 
    const transitionType = uiConfig.pageTransition || 'none';
    const staggerEnabled = uiConfig.staggerMenu || false;
    const bgType = uiConfig.backgroundType || 'color'; 
    const bgParallax = uiConfig.bgParallax || false;
    const bgAnimation = uiConfig.bgAnimation || false;
    const loaderConfig = settings.loaderConfig || { type: 'coffee', animation: 'pulse', customUrl: '' };

    return `
        <section class="dashboard-section">
            <h3>Appearance & Animations</h3>
            <div style="margin-bottom:20px;">
                ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
            </div>
            <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
            <form id="appearance-settings-form">
                <h4>Site Background</h4>
                <div class="form-group" style="display:flex; gap:15px; margin-bottom:15px;">
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="color" ${bgType==='color'?'checked':''}> Solid Color</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="image" ${bgType==='image'?'checked':''}> Custom Image</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="backgroundType" value="pattern" ${bgType==='pattern'?'checked':''}> Name Pattern</label>
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-color" style="display:${bgType==='color'?'block':'none'}">
                    <label>Background Color</label>
                    <input type="color" data-css-var="--background-color" value="${bgColor}" style="width:100%; height:40px;">
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-image" style="display:${bgType==='image'?'block':'none'}">
                    <label>Upload Image</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="bg-preview" src="${bgImage}" style="width:40px; height:40px; object-fit:cover; border:1px solid #ddd; background:#eee;">
                        <label for="bg-upload" class="button-secondary small" style="cursor:pointer;">Upload</label>
                        <input type="file" id="bg-upload" accept="image/*" style="display:none;">
                        <button type="button" id="clear-bg-btn" class="button-danger small">Remove</button>
                    </div>
                    <div style="margin-top:10px;">
                        <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="bgParallax" ${bgParallax ? 'checked' : ''}> Enable Parallax
                        </label>
                    </div>
                </div>
                <div class="form-group bg-control-group" id="bg-ctrl-pattern" style="display:${bgType==='pattern'?'block':'none'}">
                    <p style="font-size:0.9rem; color:#666;">Generates a diagonal pattern using your Website Name.</p>
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="bgAnimation" ${bgAnimation ? 'checked' : ''}> Animate (Slow Scroll)
                    </label>
                </div>

                <h4 style="margin-top:20px;">Loading Screen</h4>
                <div class="form-group" style="display:flex; gap:15px;">
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="loaderType" value="coffee" ${loaderConfig.type==='coffee'?'checked':''}> Coffee Cup</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="loaderType" value="hammer" ${loaderConfig.type==='hammer'?'checked':''}> Hammer</label>
                    <label style="font-weight:normal; cursor:pointer;"><input type="radio" name="loaderType" value="custom" ${loaderConfig.type==='custom'?'checked':''}> Custom Image</label>
                </div>
                <div class="form-group" id="loader-custom-group" style="display:${loaderConfig.type==='custom'?'block':'none'}">
                    <label>Custom Loader Image</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="loader-preview" src="${loaderConfig.customUrl || ''}" style="width:40px; height:40px; object-fit:contain; border:1px solid #ddd; background:#eee;">
                        <label for="loader-upload" class="button-secondary small" style="cursor:pointer;">Upload</label>
                        <input type="file" id="loader-upload" accept="image/*" style="display:none;">
                    </div>
                </div>
                <div class="form-group">
                    <label>Animation Style</label>
                    <select name="loaderAnimation">
                        <option value="pulse" ${loaderConfig.animation==='pulse'?'selected':''}>Gentle Pulse</option>
                        <option value="bounce" ${loaderConfig.animation==='bounce'?'selected':''}>Bounce</option>
                        <option value="fade" ${loaderConfig.animation==='fade'?'selected':''}>Fade In/Out</option>
                        <option value="spin" ${loaderConfig.animation==='spin'?'selected':''}>Spin (Rotation)</option>
                        <option value="none" ${loaderConfig.animation==='none'?'selected':''}>None (Static)</option>
                    </select>
                </div>

                <h4 style="margin-top:20px;">UI Transitions</h4>
                <div class="form-group">
                    <label>Page Transition</label>
                    <select name="pageTransition">
                        <option value="none" ${transitionType==='none'?'selected':''}>None</option>
                        <option value="fade" ${transitionType==='fade'?'selected':''}>Fade In</option>
                        <option value="slide" ${transitionType==='slide'?'selected':''}>Slide Up</option>
                        <option value="zoom" ${transitionType==='zoom'?'selected':''}>Zoom In</option>
                    </select>
                </div>
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="staggerMenu" ${staggerEnabled ? 'checked' : ''}> Gradual Menu Item Reveal
                    </label>
                </div>
            </form>
        </section>
    `;
}

export function renderHeaderSection(headerSettings) {
    const height = headerSettings.height || 60;
    const bgPattern = headerSettings.bgPattern || 'none';

    return `
        <section class="dashboard-section">
            <h3>Header Layout</h3>
            <form id="header-settings-form">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div>
                        <label>Logo Alignment</label>
                        <select name="logoAlignment">
                            <option value="center" ${headerSettings.logoAlignment === 'center' ? 'selected' : ''}>Center</option>
                            <option value="left" ${headerSettings.logoAlignment === 'left' ? 'selected' : ''}>Left</option>
                        </select>
                    </div>
                    <div>
                        <label>Burger Position</label>
                        <select name="hamburgerPosition">
                            <option value="right" ${headerSettings.hamburgerPosition === 'right' ? 'selected' : ''}>Right</option>
                            <option value="left" ${headerSettings.hamburgerPosition === 'left' ? 'selected' : ''}>Left</option>
                        </select>
                    </div>
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px;">
                    <div class="form-group">
                        <label>Height: <span id="header-height-val">${height}px</span></label>
                        <input type="range" name="headerHeight" min="50" max="150" value="${height}" 
                               oninput="document.getElementById('header-height-val').textContent = this.value + 'px'; document.documentElement.style.setProperty('--header-height', this.value + 'px');">
                    </div>
                    <div class="form-group">
                    <label>Header Background</label>
                    <div style="display:flex; align-items:center; gap:10px; border:1px solid #ccc; padding:4px; border-radius:4px;">
                            <input type="color" name="headerBgColor" value="${bgColor}" 
                                   style="width:40px; height:30px; border:none; background:none; cursor:pointer;"
                                   oninput="document.getElementById('main-header').style.backgroundColor = this.value;">
                            <span style="font-size:0.8rem; color:#666;">Pick Color</span>
                        </div>
                    </div>
                    <div class="form-group">
                    <label>Header Pattern</label>
                        <select name="headerPattern" style="width:100%; padding:8px;">
                            <option value="none" ${bgPattern==='none'?'selected':''}>None</option>
                            <option value="dots" ${bgPattern==='dots'?'selected':''}>Polka Dots</option>
                            <option value="stripes" ${bgPattern==='stripes'?'selected':''}>Stripes</option>
                            <option value="grid" ${bgPattern==='grid'?'selected':''}>Grid</option>
                            <option value="zigzag" ${bgPattern==='zigzag'?'selected':''}>Zig Zag</option>
                        </select>
                    </div>
                </div>

                <div style="padding-top:15px; border-top:1px solid #eee;">
                    <label style="display:block; margin-bottom:5px;">Custom Vector Banner</label>
                    <button type="button" id="open-header-creator-btn" class="button-secondary" style="width:100%;">
                        🎨 Create/Edit Header Logo
                    </button>
                </div>
            </form>
        </section>
    `;
}