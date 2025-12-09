// src/main.js (FINAL & COMPLETE)
import './utils/debugLogger.js';
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as uiUtils from './utils/uiUtils.js';
import { applyHeaderLogo } from './utils/uiUtils.js'; // Ensure this is imported

// --- Import Feature Modules ---
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderGodDashboard } from './features/admin/godDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godTaskbarUI.js';
import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js';
import { renderAboutUsPage } from './features/about/aboutUsUI.js';
import { renderUserProfilePage } from './features/user/userProfileUI.js';


uiUtils.initGlobalSpinner();

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

let isAppInitialized = false;

// --- DYNAMIC DESKTOP NAV ---
function renderDesktopNav() {
    const container = document.getElementById('desktop-nav-links');
    if (!container) return;

    const { isAuthenticated, profile } = useAppStore.getState().auth;
    const { settings } = useAppStore.getState().siteSettings;
    const cartCount = useAppStore.getState().cart.getTotalItemCount();
    const aboutEnabled = settings?.aboutUs?.enabled || false;
    const currentHash = window.location.hash || '#menu';

    const makeLink = (hash, label) => {
        const activeClass = currentHash === hash ? 'active' : '';
        return `<a href="${hash}" class="nav-link ${activeClass}">${label}</a>`;
    };

    let html = makeLink('#menu', 'Menu');

    if (aboutEnabled) {
        html += makeLink('#about-us', 'About Us');
    }

    if (isAuthenticated && profile) {
        if (profile.can_see_order_history) {
            html += makeLink('#order-history', 'Orders');
        }
        if (profile.role === 'owner' || profile.role === 'god') {
            html += makeLink('#owner-dashboard', 'Dashboard');
        }
        if (profile.role === 'god') {
            html += makeLink('#god-dashboard', 'God Mode');
        }
    }

    html += `<a href="#cart" class="nav-link ${currentHash === '#cart' ? 'active' : ''}">Cart (<span id="cart-count">${cartCount}</span>)</a>`;
    container.innerHTML = html;
}

// Updates persistent elements like the header
function renderPersistentUI() {
    renderAuthStatus();
    renderDesktopNav();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
    if (window.buildMobileMenu) window.buildMobileMenu();
}

function renderPageContent() {
    console.log("%c[Router] renderPageContent() CALLED", "font-weight: bold;");
    const hash = window.location.hash || '#menu';

    const { getUserRole, isAuthLoading, isAuthenticated } = useAppStore.getState().auth;

    // 1. Wait for Auth to finish loading before routing
    if (isAuthLoading) {
        console.log("[Router] Auth loading... waiting.");
        return;
    }

    const userRole = getUserRole();

    // 2. Update Desktop Nav Active State
    renderDesktopNav();

    // 3. Route Switch
    switch (hash) {
        case '#menu':
            renderMenuPage();
            break;

        case '#about-us':
            renderAboutUsPage();
            break;

        case '#cart':
        case '#checkout':
            // Merged view
            renderCartPage();
            break;

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

        case '#my-account':
            if (isAuthenticated) {
                renderUserProfilePage();
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

        default:
            renderMenuPage();
            break;
    }
}

function setupNavigationAndInteractions() {
    document.body.addEventListener('click', (e) => {
        if (e.target.matches('#login-signup-btn')) { showLoginSignupModal(); return; }
        if (e.target.matches('#logout-btn')) { useAppStore.getState().auth.logout(); return; }

        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
            const categoryFilter = navLink.dataset.categoryFilter;
            if (categoryFilter) useAppStore.getState().ui.setActiveMenuCategory(categoryFilter);
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
            uiUtils.showToast("God Mode Deactivated", "info");
        } else {
            if (user) {
                await logout();
                await new Promise(res => setTimeout(res, 500));
            }
            const { error } = await login(godUserEmail, 'password123');
            if (error) uiUtils.showToast(`Login Failed: ${error.message}`, "error");
            else uiUtils.showToast("God Mode Activated!", "success");
        }
    };

    triggerElement.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        clickCount++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);
        if (clickCount === 3) toggleGodMode();
    });

    triggerElement.addEventListener('touchstart', (e) => {
        if (!e.target.closest('button') && !e.target.closest('a')) {
            longPressTimer = setTimeout(toggleGodMode, longPressDuration);
        }
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
        const { settings } = useAppStore.getState().siteSettings;
        const cartCount = useAppStore.getState().cart.getTotalItemCount();

        const aboutEnabled = settings?.aboutUs?.enabled || false;
        const siteName = settings?.websiteName || 'Mealmates';

        let navHTML = '';

        // 1. Standard Links
        navHTML += `<a href="#menu" class="nav-link">Menu</a>`;
        navHTML += `<a href="#cart" class="nav-link">Cart (${cartCount})</a>`;

        // 2. Authenticated User Links
        if (isAuthenticated && profile) {
            // New "My Account" Link
            navHTML += `<a href="#my-account" class="nav-link">My ${siteName}</a>`;

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

        // 3. About Us (At the bottom of links)
        if (aboutEnabled) {
            navHTML += `<a href="#about-us" class="nav-link">About Us</a>`;
        }

        // 4. Auth Buttons (Login/Logout)
        let authSectionHTML = '';
        if (isAuthenticated) {
            authSectionHTML = `<div class="mobile-auth-section"><button id="logout-btn" class="button-secondary">Logout</button></div>`;
        } else {
            authSectionHTML = `<div class="mobile-auth-section"><button id="login-signup-btn" class="button-primary">Login / Sign Up</button></div>`;
        }

        const newHTML = navHTML + authSectionHTML;

        // Prevent unnecessary DOM thrashing
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

     // --- 1. PRE-CALCULATE LOGO & BACKGROUND (Anti-Jolt Fix) ---
    let logoHTML = 'Mealmates';
    let logoStyle = '';
    let headerStyle = ''; // NEW variable for the container
    
    const cachedHeader = localStorage.getItem('cached_header_config');
    if (cachedHeader) {
        try {
            const config = JSON.parse(cachedHeader);
            logoHTML = uiUtils.generateHeaderSVG(config);
            logoStyle = 'padding:0; line-height:0; display:flex; align-items:center; width:100%; justify-content:center;';
            
            // FIX: Pre-calculate the background color
            if (config.bgColor) {
                headerStyle = `background-color: ${config.bgColor};`;
            }
        } catch (e) {
            console.error("Cache load failed", e);
        }
    }

    // --- 2. RENDER SHELL ---
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <!-- FIX: Apply the calculated headerStyle -->
            <header id="main-header" style="${headerStyle}">
                <h1 style="${logoStyle}">${logoHTML}</h1>
                
                <nav>
                    <div id="desktop-nav-links" class="desktop-nav-group"></div>
                    <div id="auth-status-container">${SPINNER_SVG}</div>
                    <button id="hamburger-btn" class="hamburger-button"><span></span><span></span><span></span></button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            <div id="mobile-menu-panel" class="mobile-menu-panel"><nav id="mobile-nav-links"></nav></div>
        `;
    }


    // 3. Listeners
    setupHamburgerMenu();
    setupNavigationAndInteractions();
    initializeImpersonationToolbar();
    setupGodModeTrigger();

    window.addEventListener('hashchange', renderPageContent);

    // 4. Subscriptions
    const getPersistentUIState = () => {
        const state = useAppStore.getState();
        return {
            isAuthLoading: state.auth.isAuthLoading,
            isAuthenticated: state.auth.isAuthenticated,
            profile: state.auth.profile,
            cartItemCount: state.cart.items.length,
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

    // 5. Initial Data
    await Promise.all([
        useAppStore.getState().auth.listenToAuthChanges(),
        useAppStore.getState().menu.fetchMenu(),
        useAppStore.getState().siteSettings.fetchSiteSettings()
    ]);

    if (useAppStore.getState().auth.isAuthenticated) {
        useAppStore.getState().orderHistory.fetchOrderHistory(true);
    }

    // 6. Apply Settings (Hydration)
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

        // Ensure Header is consistent with DB settings (if cache was stale)
        if (settings.headerLogoConfig) {
            uiUtils.applyHeaderLogo(settings.headerLogoConfig);
        }

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