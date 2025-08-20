

// src/main.js - The main entry point and application orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as api from './services/apiService.js';
import * as uiUtils from './utils/uiUtils.js';

// Import our feature UI renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderManagerDashboard } from './features/admin/managerDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

// Add a placeholder for the order confirmation page
function renderOrderConfirmationPage() {
    const mainContent = document.getElementById('main-content');
    const { lastSuccessfulOrderId } = useAppStore.getState();

    if (mainContent) {
        if (lastSuccessfulOrderId) {
            mainContent.innerHTML = `
                <div class="confirmation-message">
                    <h2>Thank You For Your Order!</h2>
                    <p>Your order has been placed successfully.</p>
                    <p>Your Order ID is: <strong>${lastSuccessfulOrderId}</strong></p>
                    <p>It will be ready for pickup at your scheduled time.</p>
                    <a href="#menu" class="button-link">Place Another Order</a>
                </div>
            `;
        } else {
            mainContent.innerHTML = `
                <div class="error-message">
                    <h2>Something went wrong.</h2>
                    <p>We couldn't retrieve your order confirmation details. Please check your email or contact us.</p>
                </div>
            `;
        }
    }
}

/**
 * Simple hash-based router.
 */
function handleRouteChange() {
    const hash = window.location.hash || '#menu';
    const { getUserRole } = useAppStore.getState();
    const userRole = getUserRole(); // Get the current user's role

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        case '#checkout':
            renderCheckoutPage();
            break;
        case '#order-confirmation':
            renderOrderConfirmationPage();
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') {
                renderOwnerDashboard();
            } else {
                document.getElementById('main-content').innerHTML = `<div class="error-message"><h2>Access Denied</h2><p>You do not have permission to view this page.</p></div>`;
            }
            break;
        case '#manager-dashboard':
            if (userRole === 'manager') {
                renderManagerDashboard();
            } else {
                document.getElementById('main-content').innerHTML = `<div class="error-message"><h2>Access Denied</h2><p>You do not have permission to view this page.</p></div>`;
            }
            break;
        default:
            renderMenuPage();
            break;
    }
}

/**
 * Fetches global settings and applies them to the UI (title, theme).
 */
async function loadAndApplySiteSettings() {
    try {
        const settings = await api.getSiteSettings();
        if (settings) {
            if (settings.websiteName) {
                uiUtils.updateSiteTitles(settings.websiteName);
            }
            if (settings.themeVariables) {
                Object.entries(settings.themeVariables).forEach(([varName, value]) => {
                    uiUtils.updateCssVariable(varName, value);
                });
            }
        }
    } catch (error) {
        console.error("Failed to load or apply site settings:", error);
    }
}








/**
 * Sets up a "backdoor" for developers to quickly log in as the god user.
 * It listens for a long press on the 'Menu' nav link.
 * This is SECURE because the password is read from an environment variable
 * and is ONLY included in non-production builds.
 */


function setupGodModeTrigger() {
    // Read the dev mode flag and the password from Vite's environment variables
    const IS_DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true';
    const GOD_MODE_PASSWORD = import.meta.env.VITE_GOD_MODE_PASSWORD;

    // --- SECURITY GATE ---
    // The trigger will only be attached if we are in dev mode AND the password is set.
    if (!IS_DEV_MODE || !GOD_MODE_PASSWORD) {
        // In production, GOD_MODE_PASSWORD will be undefined, so this code will not run.
        return;
    }

    const menuLink = document.querySelector('nav a[href="#menu"]');
    if (!menuLink) {
        console.warn("God mode trigger: Menu link not found.");
        return;
    }

    let pressTimer = null;

    const startPress = (event) => {
        event.preventDefault();

        pressTimer = setTimeout(() => {
            console.warn("GOD MODE TRIGGER ACTIVATED");
            const { login } = useAppStore.getState();

            const email = 'austintweed111@gmail.com'; // This is not sensitive information
            const password = GOD_MODE_PASSWORD;     // <-- Reads the secure password from env vars

            login(email, password).then(({ error }) => {
                if (error) {
                    alert(`God Mode Login Failed: ${error.message}`);
                } else {
                    console.log("God mode login successful.");
                }
            });

        }, 5000); // 5 seconds
    };

    const cancelPress = () => {
        clearTimeout(pressTimer);
    };

    // Add listeners for both mouse and touch events
    menuLink.addEventListener("mousedown", startPress);
    menuLink.addEventListener("mouseup", cancelPress);
    menuLink.addEventListener("mouseleave", cancelPress);

    menuLink.addEventListener("touchstart", startPress, { passive: false });
    menuLink.addEventListener("touchend", cancelPress);
    menuLink.addEventListener("touchcancel", cancelPress);

    console.log("%cGod Mode Trigger is active.", "color: orange;");
}



/**
 * The main application initialization function.
 */
async function main() {
    console.log("App Initializing...");

    // Create the main app structure inside the #app div.
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header">
                <h1>My Awesome Restaurant</h1>
                <nav>
                    <a href="#menu" class="nav-link">Menu</a>
                    <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                    <div id="auth-status-container"></div>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer">
                <p>&copy; ${new Date().getFullYear()} My Awesome Restaurant</p>
            </footer>
        `;
    } else {
        console.error("Fatal Error: #app element not found. App cannot start.");
        return;
    }

    // --- Set up Reactive UI Subscriptions ---
    // These listeners will handle all subsequent updates AFTER the initial render.
    useAppStore.subscribe((state) => state.isAuthenticated, renderAuthStatus);
    useAppStore.subscribe((state) => state.profile?.role, () => {
        if (window.location.hash === '#menu' || window.location.hash === '') { renderMenuPage(); }
    });
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        useAppStore.subscribe(
            (state) => state.getTotalItemCount(),
            (itemCount) => { cartCountSpan.textContent = itemCount; }
        );
    }
    useAppStore.subscribe((state) => state.items, () => {
        if (window.location.hash === '#cart') { renderCartPage(); }
    });


    // --- Initialize Core Services & Routing ---
    // This starts the Supabase listener.
    useAppStore.getState().initializeAuth();
    initializeImpersonationToolbar();
    window.addEventListener('hashchange', handleRouteChange);

    // --- Initial Data Fetch and Page Render ---
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.innerHTML = '<div class="loading-spinner">Loading...</div>';

    // Fetch initial data. The auth slice's `initializeAuth` has already started the session check.
    await Promise.all([
        useAppStore.getState().fetchMenu(),
        loadAndApplySiteSettings()
    ]);

    // --- CRITICAL FIX: Manually render initial state AFTER fetches are complete ---
    // By this point, initializeAuth has had time to get the initial session.
    renderAuthStatus(); // Manually render the auth status once.
    // Manually set the initial cart count once.
    if (cartCountSpan) {
        cartCountSpan.textContent = useAppStore.getState().getTotalItemCount();
    }
    
    // Now, call the router to render the correct page content.
    handleRouteChange();
    
    console.log("App Initialized and router is active.");
}

main();