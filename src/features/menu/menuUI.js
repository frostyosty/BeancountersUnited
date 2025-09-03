// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';

/**
 * Renders the entire menu page into the main content area.
 * This is the simplest possible version.
 */
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use the flat store state
    const { menuItems, isMenuLoading, menuError } = useAppStore.getState();

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }
    if (menuError) {
        mainContent.innerHTML = `<div class="error-message">Error: ${menuError}</div>`;
        return;
    }
    if (!Array.isArray(menuItems)) {
        mainContent.innerHTML = `<div class="error-message">Error: Menu data is not a list.</div>`;
        return;
    }
    if (menuItems.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">The menu is empty.</div>`;
        return;
    }

    // --- SIMPLE RENDER LOGIC ---
    try {
        const menuHTML = menuItems.map(item => {
            // All HTML generation happens right here. No helper functions.
            const name = item?.name || 'Unnamed Item';
            const description = item?.description || '';
            const price = item?.price !== undefined ? parseFloat(item.price).toFixed(2) : 'N/A';
            const imageUrl = item?.image_url || '/placeholder-coffee.jpg';

            return `
                <div class="menu-item-card" style="border: 1px solid #ccc; padding: 1rem; margin-bottom: 1rem;">
                    <img src="${imageUrl}" alt="${name}" style="width:100px; height:100px; object-fit:cover;">
                    <h3>${name}</h3>
                    <p>${description}</p>
                    <p style="font-weight: bold;">$${price}</p>
                </div>
            `;
        }).join('');

        mainContent.innerHTML = `
            <section class="menu-category">
                <h2 class="category-title">Our Menu</h2>
                <div class="menu-items-grid">
                    ${menuHTML}
                </div>
            </section>
        `;
    } catch (e) {
        console.error("A critical error occurred inside renderMenuPage:", e);
        mainContent.innerHTML = `<div class="error-message">A critical error occurred while displaying the menu.</div>`;
    }
}