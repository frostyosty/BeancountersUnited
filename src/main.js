// src/main.js - The main entry point and application orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import our feature UI renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js'; // <-- Import auth UI renderer
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js'; // <-- Import owner dashboard UI

/**
 * Simple hash-based router.
 */
function handleRouteChange() {
    const hash = window.location.hash || '#menu';
    const { getUserRole } = useAppStore.getState(); // Get the role selector

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
        // --- NEW ROUTE ---
        case '#owner-dashboard':
            // Protect the route: only owners or managers can access
            if (getUserRole() === 'owner' || getUserRole() === 'manager') {
                renderOwnerDashboard();
            } else {
                // If a non-owner tries to access, show an error or redirect
                document.getElementById('main-content').innerHTML = `
                    <div class="error-message"><h2>Access Denied</h2><p>You do not have permission to view this page.</p></div>
                `;
            }
            break;
        // --- END NEW ROUTE ---
        default:
            renderMenuPage();
            break;
    }
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

    // Subscriber for auth status (login button, welcome message, etc.)
    useAppStore.subscribe(
        (state) => state.isAuthenticated,
        renderAuthStatus,
        { fireImmediately: true }
    );

    // Subscriber to re-render the menu page if the user role changes (for admin buttons)
    useAppStore.subscribe(
        (state) => state.profile?.role, // Listen specifically to the role
        () => {
            if (window.location.hash === '#menu' || window.location.hash === '') {
                renderMenuPage();
            }
        }
    );

    // Subscriber for the cart count in the header
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        useAppStore.subscribe(
            (state) => state.getTotalItemCount(),
            (itemCount) => {
                cartCountSpan.textContent = itemCount;
            },
            { fireImmediately: true }
        );
    }

    // Subscriber to re-render the cart page if the cart itself changes
    useAppStore.subscribe(
        (state) => state.items,
        () => {
            if (window.location.hash === '#cart') {
                renderCartPage();
            }
        }
    );

    // --- Initialize Core Services & Routing ---
    // This MUST be called to start the session check and set up the Supabase listener.
    useAppStore.getState().initializeAuth();

    window.addEventListener('hashchange', handleRouteChange);

    // --- Initial Data Fetch and Page Render ---
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.innerHTML = '<div class="loading-spinner">Loading...</div>';

    // Fetch initial data
    await useAppStore.getState().fetchMenu();

    // Render the initial page based on the current URL hash
    handleRouteChange();

    console.log("App Initialized and router is active.");
}

// Start the application
main();