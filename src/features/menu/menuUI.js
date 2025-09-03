// src/features/menu/menuUI.js - HEAVY DEBUGGING VERSION
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

// We are defining this FIRST and ensuring it's a simple, unbreakable function for the test.
const createMenuItemHTML = (item) => {
    // This function must be error-proof for our test.
    const name = item?.name || 'Unnamed Item';
    const price = item?.price !== undefined ? parseFloat(item.price).toFixed(2) : 'N/A';
    return `<div style="border:1px solid limegreen; padding:5px; margin:5px;">Item: ${name} - Price: $${price}</div>`;
};


export function renderMenuPage() {
    console.log("--- renderMenuPage() CALLED ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) {
        console.error("DEBUG: #main-content NOT FOUND. Aborting render.");
        return;
    }

    const { menuItems, isMenuLoading, menuError } = useAppStore.getState();

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu... (isMenuLoading is true)</div>`;
        return;
    }
    if (menuError) {
        mainContent.innerHTML = `<div class="error-message">Error: ${menuError}</div>`;
        return;
    }
    if (!Array.isArray(menuItems)) {
        mainContent.innerHTML = `<div class="error-message">CRITICAL ERROR: menuItems is not an array!</div>`;
        console.error("DEBUG: menuItems is not an array. Value:", menuItems);
        return;
    }
    if (menuItems.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">Menu is empty. (items.length is 0)</div>`;
        return;
    }

    // If we reach this point, we have a valid, non-empty array of menuItems.
    console.log(`DEBUG: Attempting to render SUCCESS state with ${menuItems.length} items.`);

    try {
        // --- BREAKDOWN STEP 1: Grouping ---
        console.log("DEBUG STEP 1: Starting to group items by category...");
        const itemsByCategory = menuItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});
        console.log("DEBUG STEP 1: Grouping successful. Categories found:", Object.keys(itemsByCategory));

        // --- BREAKDOWN STEP 2: Mapping Categories ---
        console.log("DEBUG STEP 2: Starting to map categories to HTML sections...");
        const categorySections = Object.entries(itemsByCategory).map(([category, items]) => {
            console.log(`DEBUG: Mapping category "${category}" which has ${items.length} items.`);
            
            // --- BREAKDOWN STEP 3: Mapping Items within a Category ---
            if (!Array.isArray(items)) {
                console.error(`CRITICAL ERROR: The value for category "${category}" is not an array! Value:`, items);
                return '<div>Error: Items for this category were not in a list.</div>';
            }
            console.log(`DEBUG: Mapping ${items.length} items for category "${category}"...`);
            
            // This is the line that the original error pointed to.
            const itemsHTML = items.map(createMenuItemHTML).join('');
            
            console.log(`DEBUG: Successfully mapped items for category "${category}".`);

            return `
                <section class="menu-category">
                    <h2 class="category-title">${category}</h2>
                    <div class="menu-items-grid">
                        ${itemsHTML}
                    </div>
                </section>
            `;
        });
        console.log("DEBUG STEP 2: Mapping categories successful.");

        // --- BREAKDOWN STEP 4: Joining HTML ---
        console.log("DEBUG STEP 4: Joining final HTML string...");
        const finalHTML = categorySections.join('');
        console.log("DEBUG STEP 4: Final HTML length:", finalHTML.length);

        // --- FINAL RENDER ---
        mainContent.innerHTML = finalHTML;
        // attachMenuEventListeners(); // Commented out for this test to reduce variables.

    } catch (error) {
        console.error("!!! CRITICAL ERROR during HTML generation in renderMenuPage:", error);
        mainContent.innerHTML = `<div class="error-message"><h2>A critical error occurred while displaying the menu.</h2></div>`;
    }
}