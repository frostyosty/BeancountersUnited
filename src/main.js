// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import * as api from './services/apiService.js';
import * as uiUtils from './utils/uiUtils.js';

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


function renderApp() {
    console.log("--- renderApp() called ---");
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) { cartCountSpan.textContent = '0'; }
    }
}

function renderPageContent() {
    const hash = window.location.hash || '#menu';
    document.body.className = `page-${hash.substring(1) || 'menu'}`;
    const { getUserRole } = useAppStore.getState().auth;
    const userRole = getUserRole();

    // Re-style the active nav link every time the route changes
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch (hash) {
        case '#menu': renderMenuPage(); break;
        case '#cart': renderCartPage(); break;
        case '#checkout': renderCheckoutPage(); break;
        case '#order-confirmation': renderOrderConfirmationPage(); break;
        case '#order-history':
            if (useAppStore.getState().auth.isAuthenticated) {
                renderOrderHistoryPage();
            } else { window.location.hash = '#menu'; }
            break;
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') {
                renderOwnerDashboard();
            } else { window.location.hash = '#menu'; }
            break;
        case '#manager-dashboard':
            if (userRole === 'manager') {
                renderManagerDashboard();
            } else { window.location.hash = '#menu'; }
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

    // This function will be called to build/rebuild the menu content
    const buildMobileMenu = () => {
        // Get the configuration from our siteSettingsSlice
        const { getHamburgerMenuConfig, getMenuCategories } = useAppStore.getState().siteSettings;
        const config = getHamburgerMenuConfig();
        
        let navHTML = '';

        if (config === 'categories') {
            console.log("Building hamburger menu with: Menu Categories");
            const categories = getMenuCategories();
            // Create a link for 'All' items, plus each category
            const allLink = `<a href="#menu" class="nav-link" data-category-filter="All">All Items</a>`;
            navHTML = allLink + categories.map(cat => 
                `<a href="#menu" class="nav-link" data-category-filter="${cat}">${cat}</a>`
            ).join('');
        } else { // Default to 'main-nav'
            console.log("Building hamburger menu with: Main Nav Links");
            const desktopNav = document.querySelector('#main-header nav');
            // Clone the main nav links (Menu, Cart, etc.)
            const navLinks = desktopNav.querySelectorAll('a.nav-link');
            navLinks.forEach(link => {
                navHTML += link.outerHTML;
            });
        }
        
        mobileNavContainer.innerHTML = navHTML;
    };

    const toggleMenu = () => {
        hamburgerBtn.classList.toggle('open');
        mobileMenuPanel.classList.toggle('open');
    };

    hamburgerBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Rebuild the menu every time it's opened to ensure it's up-to-date
        if (!mobileMenuPanel.classList.contains('open')) {
            buildMobileMenu();
        }
        toggleMenu();
    });

    // Listener for the panel itself to handle clicks
    mobileMenuPanel.addEventListener('click', (e) => {
        const link = e.target.closest('a.nav-link');
        if (link) {
            const categoryFilter = link.dataset.categoryFilter;
            if (categoryFilter) {
                // This is a category filter link. We need to set the filter and navigate.
                // We'll use the 'window.activeMenuCategory' variable from menuUI.js
                window.activeMenuCategory = categoryFilter;
                // Ensure we navigate to the menu page
                if (window.location.hash !== '#menu') {
                    window.location.hash = '#menu';
                } else {
                    // If already on the menu, just re-render it
                    useAppStore.getState().menu.fetchMenu().then(renderMenuPage);
                }
            }
            toggleMenu(); // Close menu after any link click
        }
    });

    // Close menu if user clicks on the main content area
    mainContent.addEventListener('click', () => {
        if (mobileMenuPanel.classList.contains('open')) {
            toggleMenu();
        }
    });
}
/**
 * Fetches global settings from the API and applies them to the UI.
 * This includes the website name and any custom theme variables.
 */
async function loadAndApplySiteSettings() {
    console.log("--- 1. Starting loadAndApplySiteSettings ---");
    try {
        console.log("--- 2. Calling api.getSiteSettings() ---");
        const settings = await api.getSiteSettings();
        console.log("--- 3. api.getSiteSettings() FINISHED. Received:", settings);

        if (settings) {
            if (settings.websiteName) {
                console.log("--- 4a. Applying websiteName:", settings.websiteName);
                uiUtils.updateSiteTitles(settings.websiteName);
            }
            if (settings.themeVariables) {
                console.log("--- 4b. Applying themeVariables:", settings.themeVariables);
                Object.entries(settings.themeVariables).forEach(([varName, value]) => {
                    uiUtils.updateCssVariable(varName, value);
                });
            }
        }
        console.log("--- 5. Finished applying settings ---");
    } catch (error) {
        console.error("--- X. CRITICAL ERROR in loadAndApplySiteSettings ---", error);
    }
}



// In src/main.js
async function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("--- main() started ---");

    // 1. Render static shell
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

    // 2. Set up a SINGLE subscriber that will handle ALL updates.
    useAppStore.subscribe(renderApp);

    // 3. Set up listeners for user interaction.
    window.addEventListener('hashchange', renderPageContent);
    setupNavigationAndInteractions();

    // 4. Perform the FIRST render to show initial loading states.
    renderApp();
    
    // 5. Kick off all initial asynchronous actions.
    // We "fire and forget". The subscriber will do the rest.
    useAppStore.getState().auth.listenToAuthChanges();
    initializeImpersonationToolbar();
    setupGodModeTrigger();
    await loadAndApplySiteSettings(); // Wait for settings for branding
    useAppStore.getState().menu.fetchMenu(); // Fire off menu fetch

    console.log("--- main() finished ---");
}

main();
