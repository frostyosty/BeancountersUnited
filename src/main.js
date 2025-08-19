// src/main.js - Corrected Orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import our feature UI renderers
import { renderMenuPage } from './features/menu/menuUI.js';

// A simple placeholder for the cart page renderer
function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if (mainContent) {
        mainContent.innerHTML = '<h2>Your Cart</h2><p>This is where your cart items will be displayed.</p>';
    }
}


/**
 * Simple hash-based router. This is the SINGLE SOURCE OF TRUTH for what page is displayed.
 */
function handleRouteChange() {
    const hash = window.location.hash || '#menu'; // Default to the menu page

    switch (hash) {
        case '#menu':
            // We call renderMenuPage directly. It will read the latest state from the store.
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        default:
            // If the hash is something unknown, default to the menu
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
            <main id="main-content">
                <!-- Initial state will be set by the router -->
            </main>
            <footer id="main-footer">
                <p>&copy; ${new Date().getFullYear()} My Awesome Restaurant</p>
            </footer>
        `;
    } else {
        console.error("Fatal Error: #app element not found. App cannot start.");
        return;
    }

    // --- Set up Reactive UI Subscriptions (NO fireImmediately) ---
    // This subscriber's job is to react to subsequent changes, e.g., an owner updating an item.
    useAppStore.subscribe(
        (state) => state.menu.items, // Only listen for changes to the items array
        () => {
            // If the user is on the menu page, re-render it to show the change.
            if (window.location.hash === '#menu' || window.location.hash === '') {
                renderMenuPage();
            }
        }
    );

    // --- Set up Routing ---
    window.addEventListener('hashchange', handleRouteChange);

    // --- Initial Data Fetch and Render ---
    // 1. Manually trigger the initial loading state display
    const mainContent = document.getElementById('main-content');
    if(mainContent) mainContent.innerHTML = '<div class="loading-spinner">Loading menu...</div>';

    // 2. Fetch the essential data needed for the first page view.
    // We `await` this so we know the data is in the store before we proceed.
    await useAppStore.getState().fetchMenu();

    // 3. Now that the data is fetched and the store is updated,
    //    call the router to render the correct initial page.
    handleRouteChange();

    console.log("App Initialized and initial page rendered.");
}

// Start the application
main();