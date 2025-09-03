// src/features/menu/menuUI.js - SIMPLIFIED DEBUG VERSION
import { useAppStore } from '@/store/appStore.js';

export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Get the state from the correct namespace
    const { items, isLoading, error } = useAppStore.getState().menu;

    if (isLoading) {
        mainContent.innerHTML = `Loading menu...`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `Error: ${error}`;
        return;
    }
    if (!Array.isArray(items)) {
        mainContent.innerHTML = `Error: Menu data is not a list.`;
        return;
    }

    // --- RADICALLY SIMPLIFIED RENDER LOGIC ---

    // We will build a simple list (<ul>) instead of the complex card layout.
    // We will only display the item's name.
    
    try {
        console.log("DEBUG: About to render simple list with", items.length, "items.");
        
        const listItemsHTML = items.map(item => {
            // Check if item and item.name exist and are valid
            if (item && typeof item.name === 'string') {
                return `<li>${item.name}</li>`;
            } else {
                // This will show us if we have bad data
                return `<li>INVALID MENU ITEM DATA</li>`;
            }
        }).join('');

        mainContent.innerHTML = `
            <h2>Our Menu (Simple View)</h2>
            <ul>
                ${listItemsHTML}
            </ul>
        `;
        
        console.log("DEBUG: Successfully set innerHTML for simple list.");

    } catch (e) {
        console.error("CRITICAL ERROR in simplified renderMenuPage:", e);
        mainContent.innerHTML = `<h2>A critical error occurred. Check console.</h2>`;
    }
}