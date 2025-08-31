// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';

export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Read state from the 'menu' namespace
    const { items, isLoading, error } = useAppStore.getState().menu;

    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message">Error: ${error}</div>`;
        return;
    }
    if (items.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">The menu is empty.</div>`;
        return;
    }

    const menuHTML = items.map(item => `
        <div class="menu-item-card" style="border: 1px solid green; padding: 10px; margin: 5px;">
            <h3>${item.name}</h3>
            <p>${item.description}</p>
            <p><strong>$${parseFloat(item.price).toFixed(2)}</strong></p>
        </div>
    `).join('');
    mainContent.innerHTML = `<div class="menu-items-grid">${menuHTML}</div>`;
}