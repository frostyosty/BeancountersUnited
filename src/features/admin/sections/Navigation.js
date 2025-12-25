// src/features/admin/sections/Navigation.js

// --- TAB BAR (Dashboard Navigation) ---
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