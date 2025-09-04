// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

function renderApp() {
    renderAuthStatus();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    }
    const hash = window.location.hash || '#menu';
    switch(hash) {
        case '#menu': renderMenuPage(); break;
        case '#cart': renderCartPage(); break;
        default: renderMenuPage(); break;
    }
}

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

// Kick off initial actions
useAppStore.getState().auth.listenToAuthChanges();
useAppStore.getState().menu.fetchMenu();
initializeImpersonationToolbar();
setupGodModeTrigger(); // Your trigger
renderApp(); // Initial render

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
        const godUserEmail = 'god@mode.dev';

        if (user?.email === godUserEmail) {
            console.warn("GOD MODE TRIGGER: Deactivating...");
            await logout();
            alert("God Mode Deactivated.");
        } else {
            console.warn("GOD MODE TRIGGER: Activating...");
            // If already logged in as someone else, log them out first.
            if (user) {
                await logout();
                // Brief delay to allow logout state to process
                await new Promise(res => setTimeout(res, 500));
            }
            const password = 'password123';
            const { error } = await login(godUserEmail, password);
            if (error) {
                alert(`God Mode Login Failed: ${error.message}`);
            } else {
                alert("God Mode Activated!");
            }
        }
    };

    // --- Triple-Click Logic ---
    triggerElement.addEventListener('click', () => {
        clickCount++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
        if (clickCount === 3) {
            toggleGodMode();
        }
    });

    // --- Long-Press Logic ---
    triggerElement.addEventListener('touchstart', (e) => {
        e.preventDefault();
        longPressTimer = setTimeout(toggleGodMode, longPressDuration);
    });
    triggerElement.addEventListener('touchend', () => clearTimeout(longPressTimer));
    triggerElement.addEventListener('touchcancel', () => clearTimeout(longPressTimer));

    console.log("God Mode Trigger (triple-click/long-press on header) is active.");
}