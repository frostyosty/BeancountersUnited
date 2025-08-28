// src/features/menu/menuUI.js - DEBUGGING VERSION

import { useAppStore } from '@/store/appStore.js';

/**
 * Renders the menu page.
 * FOR DEBUGGING: This version ignores the store state and just tries to render static text.
 */
export function renderMenuPage() {
    console.log("--- [DEBUG] renderMenuPage() CALLED ---");

    const mainContent = document.getElementById('main-content');
    if (!mainContent) {
        console.error("[DEBUG] renderMenuPage: Could not find #main-content element!");
        return;
    }

    // Get the state just for logging purposes.
    const menuState = useAppStore.getState().menu;
    console.log("[DEBUG] Current menu state is:", menuState);

    // --- THE TEST ---
    // We are completely ignoring the isLoading, error, and items properties.
    // We are just trying to render a simple, static piece of HTML.
    const staticHTML = `
        <div style="border: 5px solid green; padding: 20px;">
            <h1>Hello from renderMenuPage!</h1>
            <p>If you can see this text with a green border, it means this function is working correctly and can write to the DOM.</p>
            <p>The current loading state is: <strong>${menuState.isLoading}</strong></p>
        </div>
    `;

    console.log("[DEBUG] Setting mainContent.innerHTML with static HTML.");
    mainContent.innerHTML = staticHTML;
    console.log("[DEBUG] Set mainContent.innerHTML successfully.");
}

// We don't need these for this test, but we'll leave them here to avoid import errors elsewhere.
function createMenuItemHTML(item) { return ''; }
function attachMenuEventListeners() {}