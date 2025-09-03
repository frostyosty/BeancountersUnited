// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';

export function renderMenuPage() {
    console.log("--- renderMenuPage() CALLED ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) {
        console.error("renderMenuPage: #main-content element not found!");
        return;
    }
    
    const { menuItems, isMenuLoading, menuError } = useAppStore.getState();
    console.log("renderMenuPage: Rendering with state:", { isMenuLoading, menuError, itemCount: menuItems.length });

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
    } else if (menuError) {
        mainContent.innerHTML = `<div class="error-message">Error: ${menuError}</div>`;
    } else if (menuItems.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">The menu is empty.</div>`;
    } else {
        const menuHTML = menuItems.map(item => `
            <div class="menu-item-card" style="border: 1px solid green; padding: 10px; margin: 5px;">
                <h3>${item.name}</h3>
                <p>$${parseFloat(item.price).toFixed(2)}</p>
            </div>
        `).join('');
        mainContent.innerHTML = `<div class="menu-items-grid">${menuHTML}</div>`;
    }
}