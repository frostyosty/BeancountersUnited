// src/main.js (Updated with Name Change)

import './assets/css/static.css'; // Import the CSS
import { renderStaticSite } from './features/static/staticUI.js';
import './utils/debugLogger.js';
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as uiUtils from './utils/uiUtils.js';
import { applyHeaderLogo } from './utils/uiUtils.js';

import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage, renderCheckoutPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import { renderGodDashboard } from './features/admin/godDashboardUI.js';
import { initializeImpersonationToolbar } from './features/admin/godTaskbarUI.js';
import { renderOrderHistoryPage } from './features/user/orderHistoryUI.js';
import { renderAboutUsPage } from './features/about/aboutUsUI.js';

uiUtils.initGlobalSpinner();

const SPINNER_SVG = `
<div class="auth-loading-spinner">
    <svg viewBox="0 0 100 100">
        <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" stroke-linejoin="round" />
        <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
        <path class="mini-steam" d="M38 35 C 34 28, 42 22, 38 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
        <path class="mini-steam" d="M50 35 C 54 28, 46 22, 50 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
        <path class="mini-steam" d="M62 35 C 58 28, 66 22, 62 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
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
            // FIX: Dynamic Naming
            const label = (profile.role === 'god' || profile.role === 'owner') ? 'Orders' : 'Order History';
            html += makeLink('#order-history', label);
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
    
    if (isAuthLoading) {
        console.log("[Router] Auth loading... waiting.");
        return; 
    }
    
    const userRole = getUserRole();

    renderDesktopNav();

    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#about-us': renderAboutUsPage(); break;
        case '#cart': 
        case '#checkout': renderCartPage(); break;
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
                import('./features/user/userProfileUI.js').then(m => m.renderUserProfilePage());
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
        const aboutEnabled = settings?.aboutUs?.enabled || false;
        const siteName = settings?.websiteName || 'Mealmates';

        let navHTML = `<a href="#menu" class="nav-link">Menu</a>`;
        navHTML += `<a href="#cart" class="nav-link">Cart (${useAppStore.getState().cart.getTotalItemCount()})</a>`;

        if (isAuthenticated && profile) {
            // FIX: Dynamic Naming
            const label = (profile.role === 'god' || profile.role === 'owner') ? 'Orders' : 'Order History';
            
            navHTML += `<a href="#my-account" class="nav-link">My ${siteName}</a>`;
            
            if (profile.can_see_order_history) navHTML += `<a href="#order-history" class="nav-link">${label}</a>`;
            if (profile.role === 'owner' || profile.role === 'god') navHTML += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
            if (profile.role === 'god') navHTML += `<a href="#god-dashboard" class="nav-link">God Mode</a>`;
        }

        if (aboutEnabled) navHTML += `<a href="#about-us" class="nav-link">About Us</a>`;

        let authSectionHTML = isAuthenticated 
            ? `<div class="mobile-auth-section"><button id="logout-btn" class="button-secondary">Logout</button></div>`
            : `<div class="mobile-auth-section"><button id="login-signup-btn" class="button-primary">Login / Sign Up</button></div>`;

        mobileNavContainer.innerHTML = navHTML + authSectionHTML;
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

    // --- CHECK FOR ADMIN OVERRIDE ---
    const urlParams = new URLSearchParams(window.location.search);
    const forceAdmin = urlParams.get('mode') === 'admin';

    // --- 0. STATIC MODE CHECK ---
    let isStaticMode = false;
    try {
        const cachedSettings = localStorage.getItem('cached_site_settings'); 
        if (cachedSettings) {
            const parsed = JSON.parse(cachedSettings);
            isStaticMode = parsed.staticMode === true;
        }
    } catch(e) {}

    // IF STATIC & NOT ADMIN OVERRIDE -> RENDER STATIC & STOP
    if (isStaticMode && !forceAdmin) {
        renderStaticSite();
        return; // Stop the rest of the app from loading
    }

    // --- 1. PRE-CALCULATE LOGO (Anti-Jolt Fix) ---
     let logoHTML = 'Mealmates';
    let logoStyle = '';
    let headerStyle = '';
    
    // 1. Try to get HEIGHT from Site Settings Cache
    try {
        const cachedSettings = localStorage.getItem('cached_site_settings');
        if (cachedSettings) {
            const parsed = JSON.parse(cachedSettings);
            const h = parsed.headerSettings?.height;
            if (h) {
                // Pre-set the CSS variable inline
                headerStyle += `--header-height: ${h}px; height: ${h}px; `;
            }
        }
    } catch (e) {}

    // 2. Try to get LOGO & BG COLOR from Header Config Cache
    const cachedHeader = localStorage.getItem('cached_header_config');
    if (cachedHeader) {
        try {
            const config = JSON.parse(cachedHeader);
            logoHTML = uiUtils.generateHeaderSVG(config);
            logoStyle = 'padding:0; line-height:0; display:flex; align-items:center; width:100%; height:100%; justify-content:center; overflow:hidden;';
            if (config.bgColor) {
                headerStyle += `background-color: ${config.bgColor};`;
            }
        } catch (e) { console.error("Cache load failed", e); }
    }

    // --- RENDER SHELL ---
    const appElement = document.getElementById('app');
    if (appElement) {
        // Inject the combined headerStyle
        appElement.innerHTML = `
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

    // 5. Initial Data (With Caching Logic)
    await Promise.all([
        useAppStore.getState().auth.listenToAuthChanges(),
        
        // Fetch Menu & Cache it
        useAppStore.getState().menu.fetchMenu().then(() => {
            const items = useAppStore.getState().menu.items;
            localStorage.setItem('backup_menu_items', JSON.stringify(items));
        }),
        
        // Fetch Settings & Cache it
        useAppStore.getState().siteSettings.fetchSiteSettings().then(() => {
            const current = useAppStore.getState().siteSettings.settings;
            localStorage.setItem('cached_site_settings', JSON.stringify(current));
        })
    ]);

    if (useAppStore.getState().auth.isAuthenticated) {
        useAppStore.getState().orderHistory.fetchOrderHistory(true); 
    }
    
    // 6. Apply Settings
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
        if (settings.headerLogoConfig) uiUtils.applyHeaderLogo(settings.headerLogoConfig);
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