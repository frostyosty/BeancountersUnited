// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

// --- RENDER FUNCTION & ROUTER ---
function renderApp() {
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    }

    const hash = window.location.hash || '#menu';
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch(hash) {
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

// --- APPLICATION START ---
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

// --- LISTENERS ---
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

// --- INITIAL ACTIONS & RENDER ---
useAppStore.getState().auth.listenToAuthChanges();
useAppStore.getState().menu.fetchMenu();
renderApp();

console.log("--- main.js script setup finished ---");