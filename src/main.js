// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import all our feature renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js'; // You will need to create/restore this file
import { renderAuthStatus } from './features/auth/authUI.js';

/**
 * This is our single, simple "re-render" function. It reads the LATEST state
 * from the store every time it runs and updates the entire app.
 */
function renderApp() {
    console.log("--- renderApp() called ---");

    // Always update components that are always visible
    renderAuthStatus();
    // renderCartCount(); // We'll add this back once the cart slice is re-integrated

    // Decide which main page to show based on the URL hash
    const hash = window.location.hash || '#menu';
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add dashboard routes here later
        default:
            renderMenuPage();
            break;
    }
}

// --- Application Start ---

console.log("--- main.js script started ---");

// 1. Render the static HTML shell.
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
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024 Mealmates</p></footer>
    `;
}

// 2. Set up a SINGLE, powerful subscriber.
// This guarantees that any state change will trigger a UI update.
useAppStore.subscribe(renderApp);

// 3. Set up listeners for user interaction.
window.addEventListener('hashchange', renderApp);

// Add a simple navigation handler to prevent full page reloads on link clicks
document.body.addEventListener('click', (e) => {
    if (e.target.matches('a[href^="#"]')) {
        e.preventDefault();
        const newHash = e.target.getAttribute('href');
        if (window.location.hash !== newHash) {
            window.location.hash = newHash;
        }
    }
});


// 4. Kick off the initial asynchronous actions.
// We "fire and forget". The subscriber will handle the UI updates when they complete.
useAppStore.getState().listenToAuthChanges();
useAppStore.getState().fetchMenu();

// 5. Perform the very first render.
// This will correctly show the initial "Loading..." states.
renderApp();

console.log("--- main.js script setup finished ---");