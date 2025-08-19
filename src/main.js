// src/main.js - The main entry point and application orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import our feature UI renderers
import { renderMenuPage } from './features/menu/menuUI.js';
// We'll create a placeholder for the cart page renderer
function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
        mainContent.innerHTML = '<h2>Your Cart</h2><p>This is where your cart items will be displayed. This feature is coming soon!</p>';
    }
}


/**
 * Simple hash-based router.
 * It decides which page-rendering function to call based on the URL hash.
 */
function handleRouteChange() {
    const hash = window.location.hash || '#menu'; // Default to the menu page

    // Simple router logic
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // We will add more cases here later for #checkout, #admin, etc.
        default:
            // If the hash is something unknown, go to the menu
            renderMenuPage();
            break;
    }
}

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
            <main id="main-content"></main>
            <footer id="main-footer">
                <p>&copy; ${new Date().getFullYear()} My Awesome Restaurant</p>
            </footer>
        `;
    } else {
        console.error("Fatal Error: #app element not found. App cannot start.");
        return;
    }

    // --- Set up Reactive UI Subscriptions ---
    // This subscriber re-renders the CURRENTLY ACTIVE page if its data changes.
    useAppStore.subscribe(
        (state) => state.menu, // Listen for changes to menu data
        () => {
            // Only re-render the menu page if it's the one currently visible
            if (window.location.hash === '#menu' || window.location.hash === '') {
                renderMenuPage();
            }
        },
        { fireImmediately: true }
    );

    // --- Set up Routing ---
    window.addEventListener('hashchange', handleRouteChange);
    handleRouteChange(); // Manually call it once to render the initial page

    // --- Kick off the initial data fetch ---
    // We can now fetch data without awaiting it here, the subscriber will handle the loading state UI.
    useAppStore.getState().fetchMenu();

    console.log("App Initialized and router is active.");
}

// Start the application
main();