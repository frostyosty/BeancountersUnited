// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

let isAppInitialized = false;

function renderApp() {
    renderAuthStatus();
    renderPageContent();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) { cartCountSpan.textContent = '0'; }
    }
}

function renderPageContent() {
    const hash = window.location.hash || '#menu';
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });
    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#cart': renderCartPage(); break;
        default: renderMenuPage(); break;
    }
}

function setupInteractions() {
    document.body.addEventListener('click', (e) => {
        // --- THIS IS THE FIX ---
        // We now check for the correct button IDs from authUI.js
        if (e.target.matches('#login-btn') || e.target.matches('#signup-btn')) {
            showLoginSignupModal();
            return;
        }
        if (e.target.matches('#logout-btn')) {
            useAppStore.getState().auth.logout();
            return;
        }
        // --- END FIX ---

        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) window.location.hash = newHash;
        }
    });
}

function setupGodModeTrigger() {
    const triggerElement = document.getElementById('main-header');
    if (!triggerElement) return;

    let clickCount = 0;
    let clickTimer = null;
    let longPressTimer = null;
    const longPressDuration = 3000;

    const toggleGodMode = async () => {
        clearTimeout(clickTimer);
        clearTimeout(longPressTimer);
        clickCount = 0;

        const { login, logout, user } = useAppStore.getState().auth;
        const godUserEmail = 'manager@mealmates.dev';

        if (user?.email === godUserEmail) {
            await logout();
            alert("God Mode Deactivated.");
        } else {
            if (user) {
                await logout();
                await new Promise(res => setTimeout(res, 500));
            }
            const { error } = await login(godUserEmail, 'password123');
            if (error) {
                alert(`God Mode Login Failed: ${error.message}`);
            } else {
                alert("God Mode Activated!");
            }
        }
    };

    triggerElement.addEventListener('click', () => {
        clickCount++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
        if (clickCount === 3) {
            toggleGodMode();
        }
    });
    triggerElement.addEventListener('touchstart', (e) => {
        e.preventDefault();
        longPressTimer = setTimeout(toggleGodMode, longPressDuration);
    });
    triggerElement.addEventListener('touchend', () => clearTimeout(longPressTimer));
    triggerElement.addEventListener('touchcancel', () => clearTimeout(longPressTimer));
}

function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    
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

    useAppStore.subscribe(renderApp);
    window.addEventListener('hashchange', renderPageContent);
    setupInteractions();
    
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    
    initializeImpersonationToolbar();
    setupGodModeTrigger();
    renderApp();
}

main();