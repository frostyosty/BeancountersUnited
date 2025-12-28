// src/features/admin/sections/Navigation.js

// --- 1. TAB BAR ---
export function renderTabBar(tabs, activeTab, position) {
    const html = tabs.map(t => {
        if (t.hidden) return '';
        const isActive = t.id === activeTab ? 'active' : '';
        return `<button class="admin-tab-btn ${isActive}" data-tab="${t.id}">${t.label}</button>`;
    }).join('');

    const style = `
        display: flex; 
        gap: 10px; 
        padding: 10px; 
        background: #eee; 
        border-radius: 8px; 
        margin-bottom: 20px; 
        overflow-x: auto;
        ${position === 'bottom' ? 'order: 99;' : ''}
    `;

    return `<div id="admin-tab-bar" style="${style}">${html}</div>`;
}

// --- 2. LAYOUT CONFIGURATOR (This is the missing one) ---
export function renderLayoutConfig(tabs, position, enabled) {
    const listItems = tabs.map((t, index) => `
        <li class="tab-config-item" data-id="${t.id}" style="display:flex; justify-content:space-between; padding:8px; background:white; margin-bottom:5px; border:1px solid #ddd; border-radius:4px;">
            <span style="cursor:grab">☰ ${t.label}</span>
            <label style="font-size:0.8rem; cursor:pointer;">
                <input type="checkbox" class="tab-visibility-toggle" data-id="${t.id}" ${!t.hidden ? 'checked' : ''}> Show
            </label>
        </li>
    `).join('');

    return `
        <section class="dashboard-section" style="border: 2px solid #666; margin-top: 30px;">
            <h3>Dashboard Layout</h3>
            <form id="dashboard-layout-form">
                <div class="form-group">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="enableTabs" ${enabled ? 'checked' : ''}> 
                        Enable Tabbed View (Clean Mode)
                    </label>
                </div>
                
                <div id="tab-config-area" style="display:${enabled ? 'block' : 'none'}">
                    <div class="form-group">
                        <label>Tab Bar Position</label>
                        <select name="tabPosition" style="width:100%; padding:8px;">
                            <option value="top" ${position==='top'?'selected':''}>Top</option>
                            <option value="bottom" ${position==='bottom'?'selected':''}>Bottom</option>
                        </select>
                    </div>
                    
                    <label style="display:block; margin-bottom:5px; font-weight:bold;">Tab Order & Visibility</label>
                    <ul id="tab-sort-list" style="list-style:none; padding:0; overflow:hidden;">${listItems}</ul>
                    
                    <button type="submit" class="button-secondary small" style="margin-top:10px;">Save Layout</button>
                </div>
            </form>
        </section>
    `;
}