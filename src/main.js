// src/main.js (FINAL VERSION)
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

// --- Import ALL REAL feature modules ---
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderManagerDashboard } from './features/admin/managerDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';
import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js';

// --- State and Render Logic ---
let isAppInitialized = false;

function renderOrderConfirmationPage() {
    const mainContent = document.getElementById('main-content');
    const { lastSuccessfulOrderId } = useAppStore.getState().checkout;
    if (mainContent) {
        if (lastSuccessfulOrderId) {
            mainContent.innerHTML = `<div class="confirmation-message"><h2>Order Confirmed!</h2><p>Your Order ID is: <strong>${lastSuccessfulOrderId}</strong></p></div>`;
        } else {
            mainContent.innerHTML = `<div class="error-message"><h2>Could not find order details.</h2></div>`;
        }
    }
}

// --- THIS IS THE NEW, COMBINED FUNCTION FOR ALL PERSISTENT UI ---
function renderPersistentUI() {
    // 1. Render the desktop auth status (Login/Logout, Dashboard links)
    renderAuthStatus();

    // 2. Render the desktop cart count
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            cartCountSpan.textContent = '0';
        }
    }

    // 3. Rebuild the hamburger menu to keep it in sync
    // This function needs to be defined, we'll ensure it is.
    if (window.buildMobileMenu) {
        window.buildMobileMenu();
    }
}

function renderPageContent() {
    const hash = window.location.hash || '#menu';
    const { getUserRole, isAuthenticated } = useAppStore.getState().auth;
    const userRole = getUserRole();

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#cart': renderCartPage(); break;
        case '#checkout': renderCheckoutPage(); break;
        case '#order-confirmation': renderOrderConfirmationPage(); break;
        case '#order-history':
            if (isAuthenticated) { renderOrderHistoryPage(); } else { window.location.hash = '#menu'; }
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') { renderOwnerDashboard(); } else { window.location.hash = '#menu'; }
            break;
        case '#manager-dashboard':
            if (userRole === 'manager') { renderManagerDashboard(); } else { window.location.hash = '#menu'; }
            break;
        default: renderMenuPage(); break;
    }
}

function setupNavigationAndInteractions() {
    document.body.addEventListener('click', (e) => {
        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const newHash = navLink.getAttribute('href');
            if (window.location.hash !== newHash) window.location.hash = newHash;
        }
        if (e.target.matches('#login-signup-btn')) { showLoginSignupModal(); }
        if (e.target.matches('#logout-btn')) { useAppStore.getState().auth.logout(); }
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

function setupHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const mobileMenuPanel = document.getElementById('mobile-menu-panel');
    const mainContent = document.getElementById('main-content');
    const mobileNavContainer = document.getElementById('mobile-nav-links');

    if (!hamburgerBtn || !mobileMenuPanel || !mainContent || !mobileNavContainer) return;

    // --- We will use the ROBUST, STATE-DRIVEN build function ---
    const buildMobileMenu = () => {
        const { isAuthenticated, profile } = useAppStore.getState().auth;
        let navHTML = '';

        // 1. Always add static links
        navHTML += `<a href="#menu" class="nav-link">Menu</a>`;
        navHTML += `<a href="#cart" class="nav-link">Cart (${useAppStore.getState().cart.getTotalItemCount()})</a>`;

        // 2. Add dynamic, user-specific links based on auth state
        if (isAuthenticated && profile) {
            if (profile.can_see_order_history) {
                navHTML += `<a href="#order-history" class="nav-link">Order History</a>`;
            }
            if (profile.role === 'owner' || profile.role === 'manager') {
                navHTML += `<a href="#owner-dashboard" class="nav-link">Dashboard</a>`;
            }
        }

        // 3. Add the auth button section at the end
        let authSectionHTML = '';
        if (isAuthenticated) {
            authSectionHTML = `<div class="mobile-auth-section"><button id="logout-btn" class="button-secondary">Logout</button></div>`;
        } else {
            authSectionHTML = `<div class="mobile-auth-section"><button id="login-signup-btn" class="button-primary">Login / Sign Up</button></div>`;
        }

        const newHTML = navHTML + authSectionHTML;
        // Make it idempotent to prevent loops
        if (mobileNavContainer.innerHTML !== newHTML) {
            mobileNavContainer.innerHTML = newHTML;
        }
    };

    // Expose the function globally so renderPersistentUI can call it
    window.buildMobileMenu = buildMobileMenu;

    const toggleMenu = () => {
        hamburgerBtn.classList.toggle('open');
        mobileMenuPanel.classList.toggle('open');
    };

    hamburgerBtn.addEventListener('click', () => toggleMenu());

    mobileMenuPanel.addEventListener('click', (e) => {
        if (e.target.closest('a.nav-link') || e.target.closest('button')) {
            toggleMenu();
        }
    });

    mainContent.addEventListener('click', () => {
        if (mobileMenuPanel.classList.contains('open')) {
            toggleMenu();
        }
    });
}

async function main() {
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
                    <button id="hamburger-btn" class="hamburger-button"><span></span><span></span><span></span></button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            <div id="mobile-menu-panel" class="mobile-menu-panel"><nav id="mobile-nav-links"></nav></div>
        `;
    }

    // Call this FIRST to define window.buildMobileMenu
    setupHamburgerMenu();



    // 2. Set up smart subscribers and listeners.

    // This subscriber ONLY updates the persistent UI (header).
    // It now listens to the loading status as well.
    useAppStore.subscribe(
        // --- THIS IS THE FIX ---
        (state) => ({
            isAuthLoading: state.auth.isAuthLoading,
            isAuthenticated: state.auth.isAuthenticated,
            cartItems: state.cart.items
        }),
        // --- END OF FIX ---
        renderPersistentUI
    );

    // This listener ONLY re-renders the main page content when the URL hash changes.
    window.addEventListener('hashchange', renderPageContent);

    // This subscriber specifically watches for when the menu is done loading.
    useAppStore.subscribe(
        (state) => state.menu.isLoading,
        (isLoading) => {
            // If loading is FINISHED and we are still on the menu page, re-render the content.
            if (!isLoading && (window.location.hash === '#menu' || window.location.hash === '')) {
                renderPageContent();
            }
        }
    );

    // Set up other listeners
    setupNavigationAndInteractions();
    initializeImpersonationToolbar();
    setupGodModeTrigger(); // setupGodModeTrigger is fine to keep as is

    // Kick off initial data fetches
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();

    // Perform the very first renders
    renderPersistentUI();
    renderPageContent();

    console.log("--- main() finished ---");
}

main();