// src/main.js (FINAL & CORRECTED)
import './utils/debugLogger.js';
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as uiUtils from './utils/uiUtils.js'; // <-- RE-ADD THIS IMPORT

// --- Import Feature Modules ---
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderGodDashboard } from './features/admin/godDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godTaskbarUI.js';
import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js';

// 1. Run this IMMEDIATELY (before anything else)
uiUtils.initGlobalSpinner();

// Define the spinner HTML constant so we can use it in multiple places
const SPINNER_SVG = `
<div class="auth-loading-spinner">
    <svg viewBox="0 0 100 100">
        <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" />
        <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" />
        <path class="mini-steam" d="M40 35 L 42 25" fill="none" stroke="currentColor" stroke-width="4" />
        <path class="mini-steam" d="M50 35 L 48 25" fill="none" stroke="currentColor" stroke-width="4" />
        <path class="mini-steam" d="M60 35 L 62 25" fill="none" stroke="currentColor" stroke-width="4" />
    </svg>
</div>`;



// --- State and Render Logic ---
let isAppInitialized = false;

// This function ONLY updates persistent elements like the header
function renderPersistentUI() {
    renderAuthStatus();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    if (window.buildMobileMenu) window.buildMobileMenu();
}


// This function ONLY renders the main page content
function renderPageContent() {
    console.log("%c[Router] renderPageContent() CALLED", "font-weight: bold;");
    const hash = window.location.hash || '#menu';
    const { getUserRole, isAuthLoading } = useAppStore.getState().auth; // Get loading state
    
    // 1. STOP if auth is still loading. 
    // The auth listener will trigger a re-render when it finishes.
    if (isAuthLoading) {
        console.log("[Router] Auth loading... waiting.");
        return; 
    }const userRole = getUserRole();

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#cart': renderCartPage(); break;
        case '#checkout': renderCheckoutPage(); break;
        case '#order-confirmation':
            const mainContent = document.getElementById('main-content');
            const { lastSuccessfulOrderId } = useAppStore.getState().checkout;
            if (mainContent) mainContent.innerHTML = lastSuccessfulOrderId ? `...` : `...`; // Simplified for brevity
            break;
        case '#order-history':
            if (isAuthenticated) {
                console.log(`[Router] Hash is '${hash}'. Calling renderOrderHistoryPage().`);
                renderOrderHistoryPage();
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'god') {
                console.log(`[Router] Hash is '${hash}'. Calling renderOwnerDashboard().`);
                renderOwnerDashboard();
            } else {
                window.location.hash = '#menu';
            }
            break;
case '#god-dashboard':
            // Ensure this checks for 'god', NOT 'manager'
            if (userRole === 'god') {
                renderGodDashboard();
            } else {
                console.warn(`[Router] Access Denied. Role is ${userRole}`);
                window.location.hash = '#menu';
            }
            break;
        default: renderMenuPage(); break;
    }
}

function setupNavigationAndInteractions() {
    document.body.addEventListener('click', (e) => {
        // Handle login/signup/logout buttons first
        if (e.target.matches('#login-signup-btn')) {
            showLoginSignupModal();
            return; // Stop further processing
        }
        if (e.target.matches('#logout-btn')) {
            useAppStore.getState().auth.logout();
            return; // Stop further processing
        }

        // Handle ALL navigation links (desktop, mobile, and category filters)
        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();

            const categoryFilter = navLink.dataset.categoryFilter;
            if (categoryFilter) {
                // FIX: Accessed via the 'ui' slice
                useAppStore.getState().ui.setActiveMenuCategory(categoryFilter);
            }

            const newHash = navLink.getAttribute('href');
            // Only change the hash if it's a real navigation event
            if (window.location.hash !== newHash) {
                window.location.hash = newHash;
            }
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
        const godUserEmail = 'god@mealmates.dev';

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

            // --- THIS IS THE FIX ---
            // If owner OR god, show the Owner Dashboard link.
            if (profile.role === 'owner' || profile.role === 'god') {
                navHTML += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
            }
            // AND, if SPECIFICALLY a god, ALSO show the God Mode link.
            if (profile.role === 'god') {
                navHTML += `<a href="#god-dashboard" class="nav-link">God Mode</a>`;
            }
            // --- END OF FIX ---
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

    // Expose the function globally so other parts of the app can call it
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
    console.log("[App] Main initialization started.");

    // 1. Render Shell (Keep existing code)
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header">
                <h1>Mealmates</h1>
                <nav>
                    <a href="#menu" class="nav-link">Menu</a>
                    <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                    <!-- FIX: Pre-fill with spinner instead of "..." -->
                    <div id="auth-status-container">${SPINNER_SVG}</div>
                    <button id="hamburger-btn" class="hamburger-button"><span></span><span></span><span></span></button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            <div id="mobile-menu-panel" class="mobile-menu-panel"><nav id="mobile-nav-links"></nav></div>
        `;
    }
    // === STEP 2: SETUP ALL SYNCHRONOUS UI & LISTENERS ===
    console.log("[App] Initializing synchronous UI and listeners...");
    setupHamburgerMenu();
    setupNavigationAndInteractions();
    initializeImpersonationToolbar();
    setupGodModeTrigger();

    // === STEP 3: SETUP SUBSCRIPTIONS & ASYNC STARTUP ===
    console.log("[App] Setting up subscriptions and kicking off initial fetches...");

    // Set up the hashchange listener
    window.addEventListener('hashchange', renderPageContent);


    // Set up the Header UI subscriber
    const getPersistentUIState = () => {
        const state = useAppStore.getState();
        return {
            isAuthLoading: state.auth.isAuthLoading,
            isAuthenticated: state.auth.isAuthenticated,
            profile: state.auth.profile, // Need profile for hamburger links
            cartItemCount: state.cart.items.length // Simple count is enough to trigger
        };
    };


    let previousUIState = getPersistentUIState();
    useAppStore.subscribe(() => {
        const currentUIState = getPersistentUIState();
        if (JSON.stringify(currentUIState) !== JSON.stringify(previousUIState)) {
            console.log("%c[App Sub] Header UI state changed. Re-rendering.", "color: blue;");
            renderPersistentUI();
            previousUIState = currentUIState;
        }
    });


    setInterval(() => {
        const state = useAppStore.getState();
        if (state.auth.isAuthenticated) {
            // Refresh orders silently to get latest timestamps/status
            // (Only if we have loaded them at least once)
            if (state.orderHistory.hasLoaded) {
                // We trigger the check
                state.orderHistory.checkUrgency();
            }
        }
    }, 60 * 1000); // Check every 1 minute
    // Set up the Page Content subscriber

    useAppStore.subscribe(
        // FIX: Return a string key "trigger-category"
        (state) => `${state.ui._reRenderTrigger}-${state.ui.activeMenuCategory}`,

        (keyString) => {
            console.log(`%c[App Sub] Page re-render triggered. Key: ${keyString}`, "color: green;");
            renderPageContent();
        }
    );


    // If no hash exists, force it to #menu. 
    // This triggers the hashchange listener automatically.
    if (!window.location.hash) {
        window.location.hash = '#menu';
    }

    // 4. Initial Data Fetch
    await Promise.all([
        useAppStore.getState().auth.listenToAuthChanges(),
        useAppStore.getState().menu.fetchMenu(),
        useAppStore.getState().siteSettings.fetchSiteSettings()
    ]);
    

    if (useAppStore.getState().auth.isAuthenticated) {
        useAppStore.getState().orderHistory.fetchOrderHistory(true); // true = silent
    }
    
// Apply Settings
    const settings = useAppStore.getState().siteSettings.settings;
    
    if (settings) {
        // 1. Apply Fonts
        if (settings.themeVariables?.['--font-family-main-name']) {
            uiUtils.applySiteFont(settings.themeVariables['--font-family-main-name']);
        }
        // 2. Apply Header Layout
        if (settings.headerSettings) {
            uiUtils.applyHeaderLayout(settings.headerSettings);
        }
        // 3. Apply Logo / Title (NEW)
        if (settings.websiteName || settings.logoUrl) {
            uiUtils.updateSiteTitles(settings.websiteName, settings.logoUrl);
        }
    }
    // -----------------------------

    console.log("[App] Initial data loaded. Performing first full render...");
    renderPersistentUI();
    renderPageContent();
    // --- END OF FIX ---

    console.log("[App] Main initialization finished.");

    // === STEP 4: HIDE THE LOADER ===
    setTimeout(() => {
        console.log("[App] Hiding initial loader.");
        uiUtils.hideInitialLoader();
    }, 100); // Shorter delay is fine now
}

main();