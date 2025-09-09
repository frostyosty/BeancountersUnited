// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as api from './services/apiService.js';
import * as uiUtils from './utils/uiUtils.js';

// Import all our feature renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

// --- MAIN RENDER FUNCTIONS ---
// These are now called ONLY by subscribers or the router.

function renderUI() {
    // This function renders the parts of the UI that depend on state.
    renderAuthStatus();
    renderPageContent();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    }
}

function renderPageContent() {
    const hash = window.location.hash || '#menu';
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add other routes here
        default:
            renderMenuPage();
            break;
    }
}


// --- APPLICATION STARTUP ---
async function main() {
    console.log("--- main() started ---");

    // 1. Render static shell
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
            <footer id="main-footer"><p>&copy; 2024</p></footer>
        `;
    }

    // --- 2. SET UP TARGETED SUBSCRIBERS ---
    // This subscriber ONLY listens for auth changes and updates the header.
    useAppStore.subscribe(state => state.auth, renderAuthStatus);

    // This subscriber ONLY listens for menu changes and updates the main content.
    useAppStore.subscribe(state => state.menu, () => {
        if (window.location.hash === '#menu' || window.location.hash === '') {
            renderMenuPage();
        }
    });

    // This subscriber ONLY listens for cart changes.
    useAppStore.subscribe(state => state.cart.items, () => {
        const cartCountSpan = document.getElementById('cart-count');
        if (cartCountSpan) {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        }
        if (window.location.hash === '#cart') {
            renderCartPage();
        }
    });

    // 3. Set up listeners for user interaction
    window.addEventListener('hashchange', renderPageContent);
    setupNavigationAndInteractions();

    // 4. Kick off initial data fetches
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    // await loadAndApplySiteSettings(); // We can add this back later

    // 5. Perform the very first render
    renderUI();

    console.log("--- main() finished ---");
}

main();

function setupNavigationAndInteractions() {
    document.body.addEventListener('click', (e) => {
        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) window.location.hash = newHash;
        }
        if (e.target.matches('#login-signup-btn')) { showLoginSignupModal(); }
        if (e.target.matches('#logout-btn')) { useAppStore.getState().auth.logout(); }
    });
}