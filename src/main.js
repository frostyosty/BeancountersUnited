// src/main.js - The main entry point and application orchestrator

import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// Import our feature UI renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js'; // <-- Import auth UI renderer

/**
 * Simple hash-based router.
 */
function handleRouteChange() {
    const hash = window.location.hash || '#menu'; // Default to the menu page

    // Update nav link styles to show the active page
    document.querySelectorAll('#main-header nav a').forEach(link => {
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
            renderCartPage(); // <-- Use the real cart page renderer
            break;
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

    // Subscriber to re-render auth status when user logs in/out
    useAppStore.subscribe(
        (state) => state.isAuthenticated,
        renderAuthStatus, // The function to call on change
        { fireImmediately: true }
    );

    // Subscriber to re-render the menu page if the user role changes
    // (to show/hide admin buttons)
    useAppStore.subscribe(
        (state) => state.auth?.profile?.role,
        () => {
            if (window.location.hash === '#menu' || window.location.hash === '') {
                renderMenuPage();
            }
        }
    );

    
    // Subscriber to update the cart count in the header
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        useAppStore.subscribe(
            (state) => state.getTotalItemCount(), // Use the selector from the cart slice
            (itemCount) => {
                cartCountSpan.textContent = itemCount;
            },
            { fireImmediately: true } // Run once on startup to set initial count
        );
    }

    // Subscriber to re-render the cart page if cart items change
    useAppStore.subscribe(
        (state) => state.items, // The array of items in the cart slice
        () => {
            // Only re-render if the user is currently on the cart page
            if (window.location.hash === '#cart') {
                renderCartPage();
            }
        }
    );


    // --- Initialize Auth and Routing ---
    // This MUST come before initial data fetch
    useAppStore.getState().initializeAuth();
    window.addEventListener('hashchange', handleRouteChange);

    // --- Initial Data Fetch and Render ---
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.innerHTML = '<div class="loading-spinner">Loading...</div>';

    await useAppStore.getState().fetchMenu();

    // Call the router to render the correct initial page
    handleRouteChange();

    console.log("App Initialized and router is active.");
}

// Start the application
main();