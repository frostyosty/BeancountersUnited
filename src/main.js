// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// --- Feature UI Imports ---
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

// --- State Variables ---
let isAppInitialized = false;

// --- Render & Router Functions ---

function renderApp() {
    // This is the main render loop, called on any state or route change.
    renderAuthStatus();
    renderPageContent(); // This will render the main content based on the route
    
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            cartCountSpan.textContent = '0';
        }
    }
}

function renderPageContent() {
    const hash = window.location.hash || '#menu';
    
    // Style the active navigation link
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        if (link.getAttribute('href') === hash) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add more routes here for dashboards, checkout, etc.
        default:
            renderMenuPage();
            break;
    }
}


// --- Setup Functions ---

function setupNavigationAndInteractions() {
    // Use event delegation on the body for all major clicks
    document.body.addEventListener('click', (e) => {
        const target = e.target; // For convenience

        // --- Handle Modal Triggers First ---
        if (target.matches('#login-signup-btn')) {
            e.stopPropagation(); // Stop the event from bubbling to the header
            showLoginSignupModal();
            return; // Action handled, exit the function
        }
        if (target.matches('#logout-btn')) {
            e.stopPropagation(); // Stop the event from bubbling to the header
            useAppStore.getState().auth.logout();
            return; // Action handled, exit the function
        }

        // --- Then, handle Navigation Links ---
        const navLink = target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            e.stopPropagation(); // Stop the event from bubbling to the header
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) {
                window.location.hash = newHash;
            }
            return; // Action handled, exit the function
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
        const godUserEmail = 'god@mode.dev';

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

// --- Main Application Initialization ---

function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("--- main() started ---");

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
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
        `;
    }

    // 1. Set up listeners
    useAppStore.subscribe(renderApp);
    window.addEventListener('hashchange', renderPageContent); // Route on hash change
    setupNavigationAndInteractions(); // Handle all clicks
    
    // 2. Kick off initial actions
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    
    // 3. Initialize UI modules
    initializeImpersonationToolbar();
    setupGodModeTrigger();

    // 4. Perform the first render
    renderApp();
    
    console.log("--- main.js script setup finished ---");
}

// Start the application
main();