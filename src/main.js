// src/main.js - The "Back to Basics" Final Version

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import all the functions that render parts of our UI
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js'; // Assuming you have this
import { renderAuthStatus } from './features/auth/authUI.js';

/**
 * This is our single, simple "re-render" function. It reads the LATEST state
 * from the store every time it runs and updates the entire app.
 * This is perfect for debugging because it eliminates all complex conditional logic.
 */
function renderApp() {
    console.log("--- renderApp() called. Reading latest state from store. ---");

    // Re-render the auth status in the header
    renderAuthStatus();

    // Re-render the cart count in the header
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        // We need to make sure the cart slice and its functions exist
        const { cart } = useAppStore.getState();
        if (cart && typeof cart.getTotalItemCount === 'function') {
            cartCountSpan.textContent = cart.getTotalItemCount();
        }
    }

    // Decide which main page to show based on the URL hash
    const hash = window.location.hash || '#menu';
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add other cases here for checkout, dashboards, etc.
        default:
            renderMenuPage();
            break;
    }
}

// --- Main Application Setup ---

console.log("--- main.js script started ---");

// 1. Render the static HTML shell immediately.
const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header">
            <h1>Mealmates</h1>
            <nav>
                <a href="#menu" class="nav-link">Menu</a>
                <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                <div id="auth-status-container"></div>
            </nav>
        </header>
        <main id="main-content">
            <div class="initial-loader">Application initializing...</div>
        </main>
        <footer id="main-footer">
            <p>&copy; ${new Date().getFullYear()} Mealmates</p>
        </footer>
    `;
}

// 2. Set up a SINGLE, powerful subscriber.
// ANY time ANY part of the state changes, we will re-render the entire app.
useAppStore.subscribe(renderApp);

// 3. Set up the hashchange listener to also trigger a re-render.
window.addEventListener('hashchange', renderApp);

// 4. Kick off the initial asynchronous actions.
// We "fire and forget" these. The subscriber we just set up will handle the UI updates.
useAppStore.getState().auth.listenToAuthChanges(); // Starts listening for login/logout
useAppStore.getState().menu.fetchMenu();           // Starts fetching the menu

// 5. Perform the very first render.
// This will show the initial "Loading..." states correctly.
renderApp();

console.log("--- main.js script setup finished ---");