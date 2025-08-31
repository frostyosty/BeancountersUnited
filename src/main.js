// src/main.js - The Full Application
import './assets/css/style.css';
import { supabase, supabaseError } from './supabaseClient.js';
import { useAppStore } from './store/appStore.js';

// Import all our feature renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';
// Add dashboards back later

function renderApp() {
    console.log("--- renderApp() called ---");
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            // Using flat store structure
            cartCountSpan.textContent = useAppStore.getState().getCartItemCount();
        } catch(e) { /* cart slice might not be ready */ }
    }

    const hash = window.location.hash || '#menu';
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add more routes later
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
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

if (supabaseError) {
    // Handle the fatal error if supabase failed to init
    document.getElementById('main-content').innerHTML = `<div class="error-message">${supabaseError}</div>`;
} else {
    // Set up the full application
    useAppStore.subscribe(renderApp);
    window.addEventListener('hashchange', renderApp);

    document.body.addEventListener('click', (e) => {
        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) {
                window.location.hash = newHash;
            }
        }
    });

    // Kick off initial actions
    useAppStore.getState().listenToAuthChanges(); // Now we add auth back
    useAppStore.getState().fetchMenu();

    // Initial render
    renderApp();
    console.log("--- main.js script setup finished ---");
}