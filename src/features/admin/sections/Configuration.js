export function renderGlobalSettingsSection(settings) {
    const currentLogo = settings.logoUrl || '';
    const hamburgerConfig = settings.hamburgerMenuContent || 'main-nav';

    return `
        <section class="dashboard-section" style="border-color: #7b2cbf;">
            <h3 style="color:#7b2cbf;">Global Site Settings</h3>
            <form id="global-settings-form">
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
                        <p id="no-logo-text" style="display:${currentLogo?'none':'block'}; font-size:0.8rem; margin:0;">No logo</p>
                    </div>
                </div>
                <div class="form-group">
                    <label>Mobile Menu Content</label>
                    <div style="display:flex; gap:15px;">
                        <label><input type="radio" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig==='main-nav'?'checked':''}> Simple Menu</label>
                        <label><input type="radio" name="hamburgerMenuContent" value="categories" ${hamburgerConfig==='categories'?'checked':''}> Category List</label>
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
                These settings control what <strong>Customers</strong> see. 
            </p>
            <form id="payment-settings-form">
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Stripe (Credit Cards)</label>
                    <label style="display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableStripe" ${enableStripe ? 'checked' : ''}> Enable Stripe (Credit Cards)
                    </label>
                </div>
                <div style="margin-bottom:20px; padding:15px; background:#fff; border:1px solid #ddd; border-radius:6px;">
                    <label style="font-weight:bold; display:block; margin-bottom:10px;">Pay on Pickup (Cash)</label>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                        <div><label>Max Order Value ($)</label><input type="number" name="maxCashAmount" value="${paymentConfig.maxCashAmount}"></div>
                        <div><label>Max Item Count</label><input type="number" name="maxCashItems" value="${paymentConfig.maxCashItems}"></div>
                    </div>
                </div>
            </form>
        </section>
    `;
}

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