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
        try {
                    cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            cartCountSpan.textContent = '0';
        }
    }

    // 2. Act as a router to render the main content area.
    const hash = window.location.hash || '#menu';

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        if (link.getAttribute('href') === hash) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    switch(hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add more routes here
        default:
            renderMenuPage();
            break;
    }
}

// --- Application Start ---

console.log("--- main.js script started ---");

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

// Set up listeners
useAppStore.subscribe(renderApp);
window.addEventListener('hashchange', renderApp);

document.body.addEventListener('click', (e) => {
    const navLink = e.target.closest('a[href^="#"]');
    if (navLink) {
        e.preventDefault();
        const newHash = navLink.getAttribute('href');
        if (window.location.hash !== newHash) window.location.hash = newHash;
    }
});

// Kick off initial asynchronous actions
useAppStore.getState().auth.listenToAuthChanges(); // CORRECT
useAppStore.getState().menu.fetchMenu()

// Perform the very first render
renderApp();

console.log("--- main.js script setup finished ---");