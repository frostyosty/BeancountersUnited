// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import all our feature renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

/**
 * This is our single, simple "re-render" function. It reads the LATEST state
 * from the store every time it runs and updates the entire app.
 */
function renderApp() {
    console.log("--- renderApp() called ---");

    // 1. Render persistent UI components that are always visible.
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        // Use a try-catch as a safeguard
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            // This might happen if cartSlice isn't loaded yet, default to 0
            cartCountSpan.textContent = '0';
        }
    }

    // 2. Act as a router to render the main content area.
    const hash = window.location.hash || '#menu';

    // Style the active navigation link
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        if (link.getAttribute('href') === hash) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    // Render the correct page based on the hash
    switch(hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add more routes here for checkout, dashboards, etc.
        default:
            renderMenuPage(); // Default to the menu
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
// This guarantees that any state change will trigger a full UI update.
useAppStore.subscribe(renderApp);

// 3. Set up listeners for user interac