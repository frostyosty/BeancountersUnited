// src/main.js - The main entry point and application orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import our new menu UI feature
import { renderMenuPage } from './features/menu/menuUI.js';

/**
 * The main application initialization function.
 */
async function main() {
    console.log("App Initializing...");

    // Create the main app structure inside the #app div.
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header">
                <h1>My Awesome Restaurant</h1>
                <nav>
                    <a href="#menu">Menu</a>
                    <a href="#cart">Cart (<span id="cart-count">0</span>)</a>
                </nav>
            </header>
            <main id="main-content">
                <!-- Feature content will be rendered here -->
            </main>
            <footer id="main-footer">
                <p>&copy; ${new Date().getFullYear()} My Awesome Restaurant</p>
            </footer>
        `;
    } else {
        console.error("Fatal Error: #app element not found. App cannot start.");
        return;
    }

    // Set up a Zustand subscriber to re-render the menu whenever its state changes.
    // This is the core of our reactive UI.
    useAppStore.subscribe(
        // The selector: this subscription will ONLY run if the `state.menu` object changes.
        (state) => state.menu,
        // The callback: this function runs when the selected state changes.
        () => {
            // For now, we assume if the menu state changes, we are on the menu page.
            // A router will make this more robust later.
            renderMenuPage();
        },
        // Options: fireImmediately ensures it runs once on startup with the initial state.
        { fireImmediately: true }
    );

    // --- Kick off the first data fetch ---
    // Get the `fetchMenu` action from the store and call it.
    // This will trigger the loading state, then either the success or error state,
    // and our subscriber above will render the UI accordingly.
    await useAppStore.getState().fetchMenu();

    console.log("App Initialized and initial data fetch initiated.");
}

// Start the application
main();