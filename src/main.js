// src/main.js
import './utils/debugLogger.js';
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as uiUtils from './utils/uiUtils.js';

// --- Import Feature Modules ---
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderGodDashboard } from './features/admin/godDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godTaskbarUI.js';
import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js';
import { renderAboutUsPage } from './features/about/aboutUsUI.js'; // NEW IMPORT

// 1. Run this IMMEDIATELY
uiUtils.initGlobalSpinner();

// Spinner HTML
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

function renderPersistentUI() {
    renderAuthStatus();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    if (window.buildMobileMenu) window.buildMobileMenu();
}

function renderPageContent() {
    console.log("%c[Router] renderPageContent() CALLED", "font-weight: bold;");
    const hash = window.location.hash || '#menu';
    
    const { getUserRole, isAuthLoading, isAuthenticated } = useAppStore.getState().auth; 
    
    if (isAuthLoading) {
        console.log("[Router] Auth loading... waiting.");
        return; 
    }
    
    const userRole = getUserRole();

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#about-us': renderAboutUsPage(); break; // NEW ROUTE
        case '#cart': renderCartPage(); break;
        case '#checkout': renderCheckoutPage(); break;
        case '#order-confirmation':
            const mainContent = document.getElementById('main-content');
            const { lastSuccessfulOrderId } = useAppStore.getState().checkout;
            if (mainContent) mainContent.innerHTML = lastSuccessfulOrderId ? `...` : `...`; 
            break;
        case '#order-history':
            if (isAuthenticated) {
                renderOrderHistoryPage();
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'god') {
                renderOwnerDashboard();
            } else {
                window.location.hash = '#menu';
            }
            break;
        case '#god-dashboard':
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
        if (e.target.matches('#login-signup-btn')) {
            showLoginSignupModal();
            return; 
        }
        if (e.target.matches('#logout-btn')) {
            useAppStore.getState().auth.logout();
            return; 
        }

        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const categoryFilter = navLink.dataset.categoryFilter;
            if (categoryFilter) {
                useAppStore.getState().ui.setActiveMenuCategory(categoryFilter);
            }
            const newHash = navLink.getAttribute('href');
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
        if (clickCount === 3) toggleGodMode();
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

    const buildMobileMenu = () => {
        const { isAuthenticated, profile } = useAppStore.getState().auth;
        
        // FIX: Safely access settings for the toggle
        const { settings } = useAppStore.getState().siteSettings;
        const aboutEnabled = settings?.aboutUs?.enabled || false;

        let navHTML = '';

        navHTML += `<a href="#menu" class="nav-link">Menu</a>`;
        
        // NEW: Conditionally add About Us
        if (aboutEnabled) {
            navHTML += `<a href="#about-us" class="nav-link">About Us</a>`;
        }

        navHTML += `<a href="#cart" class="nav-link">Cart (${useAppStore.getState().cart.getTotalItemCount()})</a>`;

        if (isAuthenticated && profile) {
            if (profile.can_see_order_history) {
                navHTML += `<a href="#order-history" class="nav-link">Order History</a>`;
            }
            if (profile.role === 'owner' || profile.role === 'god') {
                navHTML += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
            }
            if (profile.role === 'god') {
                navHTML += `<a href="#god-dashboard" class="nav-link">God Mode</a>`;
            }
        }

        let authSectionHTML = '';
        if (isAuthenticated) {
            authSectionHTML = `<div class="mobile-auth-section"><button id="logout-btn" class="button-secondary">Logout</button></div>`;
        } else {
            authSectionHTML = `<div class="mobile-auth-section"><button id="login-signup-btn" class="button-primary">Login / Sign Up</button></div>`;
        }

        const newHTML = navHTML + authSectionHTML;
        if (mobileNavContainer.innerHTML !== newHTML) {
            mobileNavContainer.innerHTML = newHTML;
        }
    };

    window.buildMobileMenu = buildMobileMenu;

    const toggleMenu = () => {
        hamburgerBtn.classList.toggle('open');
        mobileMenuPanel.classList.toggle('open');
    };

    hamburgerBtn.addEventListener('click', () => toggleMenu());
    mobileMenuPanel.addEventListener('click', (e) => {
        if (e.target.closest('a.nav-link') || e.target.closest('button')) toggleMenu();
    });
    mainContent.addEventListener('click', () => {
        if (mobileMenuPanel.classList.contains('open')) toggleMenu();
    });
}

async function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("[App] Main initialization started.");

    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header">
                <h1>Mealmates</h1>
                <nav>
                    <a href="#menu" class="nav-link">Menu</a>
                    <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                    <div id="auth-status-container">${SPINNER_SVG}</div>
                    <button id="hamburger-btn" class="hamburger-button"><span></span><span></span><span></span></button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            <div id="mobile-menu-panel" class="mobile-menu-panel"><nav id="mobile-nav-links"></nav></div>
        `;
    }

    setupHamburgerMenu();
    setupNavigationAndInteractions();
    initializeImpersonationToolbar();
    setupGodModeTrigger();

    window.addEventListener('hashchange', renderPageContent);

    const getPersistentUIState = () => {
        const state = useAppStore.getState();
        return {
            isAuthLoading: state.auth.isAuthLoading,
            isAuthenticated: state.auth.isAuthenticated,
            profile: state.auth.profile, 
            cartItemCount: state.cart.items.length,
            // Add settings trigger so hamburger updates when "About Us" is toggled
            aboutEnabled: state.siteSettings.settings?.aboutUs?.enabled
        };
    };
    
    let previousUIState = getPersistentUIState();
    useAppStore.subscribe(() => {
        const currentUIState = getPersistentUIState();
        if (JSON.stringify(currentUIState) !== JSON.stringify(previousUIState)) {
            renderPersistentUI();
            previousUIState = currentUIState;
        }
    });

    setInterval(() => {
        const state = useAppStore.getState();
        if (state.auth.isAuthenticated && state.orderHistory.hasLoaded) {
            state.orderHistory.checkUrgency();
        }
    }, 60 * 1000);

    useAppStore.subscribe(
        (state) => `${state.ui._reRenderTrigger}-${state.ui.activeMenuCategory}-${state.auth.isAuthLoading}`,
        (keyString) => {
            console.log(`%c[App Sub] Page re-render triggered. Key: ${keyString}`, "color: green;");
            renderPageContent();
        }
    );

    if (!window.location.hash) {
        window.location.hash = '#menu';
    }

    await Promise.all([
        useAppStore.getState().auth.listenToAuthChanges(),
        useAppStore.getState().menu.fetchMenu(),
        useAppStore.getState().siteSettings.fetchSiteSettings()
    ]);

    if (useAppStore.getState().auth.isAuthenticated) {
        useAppStore.getState().orderHistory.fetchOrderHistory(true); 
    }
    
    const settings = useAppStore.getState().siteSettings.settings;
    if (settings) {
        if (settings.themeVariables) {
            Object.entries(settings.themeVariables).forEach(([key, value]) => {
                document.documentElement.style.setProperty(key, value);
            });
            if (settings.themeVariables['--font-family-main-name']) {
                uiUtils.applySiteFont(settings.themeVariables['--font-family-main-name']);
            }
        }
        if (settings.headerSettings) uiUtils.applyHeaderLayout(settings.headerSettings);
        if (settings.websiteName || settings.logoUrl) uiUtils.updateSiteTitles(settings.websiteName, settings.logoUrl);
        
        // Apply Backgrounds
        uiUtils.applyGlobalBackground(settings);
    }

    console.log("[App] Initial data loaded. Performing first full render...");
    renderPersistentUI();
    renderPageContent();

    setTimeout(() => {
        console.log("[App] Hiding initial loader.");
        uiUtils.hideInitialLoader();
    }, 100);
}

main();