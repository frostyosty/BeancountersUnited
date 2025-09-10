// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

function renderApp() {
    console.log("--- renderApp() CALLED ---");
    
    // Always render the persistent parts
    renderAuthStatus();
    // renderCartCount(); // We can add this back later

    // Router logic is now INSIDE the main render loop
    const hash = window.location.hash || '#menu';
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
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
                <a href="#cart" class="nav-link">Cart</a>
                <div id="auth-status-container"></div>
            </nav>
        </header>
        <main id="main-content"></main>
    `;
}

// ONE subscriber to rule them all
useAppStore.subscribe(renderApp);

// ONE listener for navigation
window.addEventListener('hashchange', renderApp);

// Kick off the initial actions
useAppStore.getState().menu.fetchMenu();
useAppStore.getState().auth.listenToAuthChanges();

// Perform the very first render
renderApp();

console.log("--- main.js script setup finished ---");