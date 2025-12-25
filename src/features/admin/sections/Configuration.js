// src/features/admin/sections/Configuration.js
import * as uiUtils from '@/utils/uiUtils.js'; // Need this for getThemeControlsHTML helper if used, or manual inputs below

export function renderGlobalSettingsSection(settings) {
    const currentLogo = settings.logoUrl || '';
    const hamburgerConfig = settings.hamburgerMenuContent || 'main-nav';
    
    // Layout Defaults
    const currentZoom = settings.themeVariables?.['--site-zoom'] || '100%';
    const currentPadding = settings.themeVariables?.['--global-padding'] || '1rem';
    const currentMargin = settings.themeVariables?.['--section-margin'] || '2rem';
    const currentRadius = settings.themeVariables?.['--border-radius'] || '4px';

    return `
        <section class="dashboard-section" style="border-color: #7b2cbf;">
            <h3 style="color:#7b2cbf;">Global Site Settings</h3>
            <form id="global-settings-form">
                <!-- 1. Identity -->
                <div class="form-group">
                    <label>Website Name</label>
                    <input type="text" name="websiteName" value="${settings.websiteName || 'Mealmates'}" required>
                </div>
                <div class="form-group">
                    <label>Website Logo</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img id="logo-preview" src="${currentLogo}" style="max-height:40px; display:${currentLogo?'block':'none'}; border:1px solid #ddd;">
                        <label for="logo-upload" class="button-secondary small" style="cursor:pointer;">Upload</label>
                        <input type="file" id="logo-upload" name="logoFile" accept="image/*" style="display:none;">
                        <button type="button" id="clear-logo-btn" class="button-danger small" style="display:${currentLogo?'block':'none'};">Remove</button>
                        <input type="hidden" name="logoUrl" value="${currentLogo}">
                    </div>
                </div>

                <!-- 2. Navigation Mode -->
                <div class="form-group">
                    <label>Mobile Menu Style</label>
                    <div style="display:flex; gap:15px; margin-top:5px;">
                        <label style="font-weight:normal; cursor:pointer;">
                            <input type="radio" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig==='main-nav'?'checked':''}> 
                            Simple (Links Only)
                        </label>
                        <label style="font-weight:normal; cursor:pointer;">
                            <input type="radio" name="hamburgerMenuContent" value="categories" ${hamburgerConfig==='categories'?'checked':''}> 
                            Category List (Links + Food Categories)
                        </label>
                    </div>
                    <p style="font-size:0.8rem; color:#666; margin-top:2px;">"Category List" adds quick links to specific menu sections in the hamburger menu.</p>
                </div>

                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">

                <!-- 3. Layout & Spacing (Moved from God Mode) -->
                <h4 style="margin-bottom:10px;">Layout & Spacing</h4>
                
                <div class="form-group">
                    <label>Global Zoom</label>
                    <div style="display:flex; gap:10px;">
                        <button type="button" class="button-secondary small zoom-btn" data-val="95%">95%</button>
                        <button type="button" class="button-secondary small zoom-btn" data-val="100%">100%</button>
                    </div>
                    <input type="hidden" name="zoomLevel" id="zoom-input" value="${currentZoom}">
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px;">
                    <div class="form-group">
                        <label>Padding</label>
                        <div style="display:flex; align-items:center;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="padding-input" data-step="-2" data-unit="px">-</button>
                            <input type="text" name="globalPadding" id="padding-input" value="${currentPadding}" readonly style="width:50px; text-align:center; border:none;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="padding-input" data-step="2" data-unit="px">+</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Margins</label>
                        <div style="display:flex; align-items:center;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="margin-input" data-step="-2" data-unit="px">-</button>
                            <input type="text" name="sectionMargin" id="margin-input" value="${currentMargin}" readonly style="width:50px; text-align:center; border:none;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="margin-input" data-step="2" data-unit="px">+</button>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Corners</label>
                        <div style="display:flex; align-items:center;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="radius-input" data-step="-2" data-unit="px">-</button>
                            <input type="text" name="borderRadius" id="radius-input" value="${currentRadius}" readonly style="width:50px; text-align:center; border:none;">
                            <button type="button" class="button-secondary small adjust-btn" data-target="radius-input" data-step="2" data-unit="px">+</button>
                        </div>
                    </div>
                </div>

                <div style="text-align:right; margin-top:20px;">
                    <button type="submit" class="button-primary">Save Settings</button>
                </div>
            </form>
        </section>
    `;
}

// ... (renderAboutConfigSection, renderPaymentSection remain the same) ...
export function renderAboutConfigSection(settings) {
    const aboutEnabled = settings.aboutUs?.enabled || false;
    return `
        <section class="dashboard-section">
            <h3>About Page Configuration</h3>
            <form id="about-config-form">
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableAboutUs" ${aboutEnabled ? 'checked' : ''}> 
                        Enable "About Us" Page
                    </label>
                    <p style="font-size:0.85rem; color:#666; margin-top:5px; margin-left: 24px;">
                        When enabled, an "About" link appears in the bottom of the menu.
                    </p>
                    <div style="margin-top:10px; margin-left:24px;">
                        <a href="#about-us" class="button-secondary small">Go to About Page</a>
                    </div>
                </div>
            </form>
        </section>
    `;
}

export function renderPaymentSection(paymentConfig) {
    const enableStripe = paymentConfig.enableStripe !== false;
    return `
        <section class="dashboard-section" style="border: 2px solid #dc3545;">
            <h3 style="color: #dc3545;">Payment & Emergency Controls</h3>
            <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                Control what customers see at checkout.
            </p>
            <form id="payment-settings-form">
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Stripe (Credit Cards)</label>
                    <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> 
                        Enable Online Card Payments
                    </label>
                </div>
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Customer "Pay on Pickup" Rules</label>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                        <div><label>Max Order Value ($)</label><input type="number" name="maxCashAmount" value="${paymentConfig.maxCashAmount}"></div>
                        <div><label>Max Item Count</label><input type="number" name="maxCashItems" value="${paymentConfig.maxCashItems}"></div>
                    </div>
                </div>
            </form>
        </section>
    `;
}