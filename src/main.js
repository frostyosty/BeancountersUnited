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
// In /src/main.js



// THIS IS THE MISSING FUNCTION DEFINITION
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



function renderApp() {
    console.log("--- renderApp() called ---");

    // 1. Render persistent UI components that are always visible.
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            // --- THIS IS THE FIX ---
            cartCountSpan.textContent = '0'; // Corrected variable name
            // --- END OF FIX ---
        }
    }

    // 2. Call the router to render the main content area.
    renderPageContent();
}

function renderPageContent() {
    console.log("--- renderPageContent() called ---");
    const hash = window.location.hash || '#menu';

    console.log("DEBUG: Getting auth slice...");
    const authSlice = useAppStore.getState().auth;
    console.log("DEBUG: Auth slice retrieved. Does it have getUserRole?", typeof authSlice?.getUserRole);
    
    // This is the line that is likely failing
    const userRole = authSlice.getUserRole();
    console.log("DEBUG: User role is:", userRole);

    console.log("DEBUG: Styling nav links...");
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });
    console.log("DEBUG: Nav links styled.");

    console.log("--- about to engage in the switch stuff ---");
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
                // Call the action from the uiSlice
                useAppStore.getState().ui.setActiveMenuCategory(categoryFilter);

                if (window.location.hash !== '#menu') {
                    window.location.hash = '#menu';
                }
            }
            toggleMenu();
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


async function main() {
    // Initialization guard to prevent running twice
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("--- main() started ---");

    // 1. Render the static HTML shell immediately.
    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header">
                <h1>Mealmates</h1>
                <nav>
                    <a href="#menu" class="nav-link">Menu</a>
                    <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                    <div id="auth-status-container"></div>
                    <a id="phone-icon-link" class="phone-icon" href="#" style="display: none;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
                        </svg>
                    </a>
                    <button id="hamburger-btn" class="hamburger-button">
                        <span></span><span></span><span></span>
                    </button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            <div id="mobile-menu-panel" class="mobile-menu-panel">
                <nav id="mobile-nav-links"></nav>
            </div>
        `;
    }

    // 2. Set up a SINGLE subscriber to handle ALL UI updates.
    // This is the core of the reactive system.
    useAppStore.subscribe(renderApp);

    // 3. Set up listeners for user interaction.
    window.addEventListener('hashchange', renderApp); // Re-render on navigation
    setupNavigationAndInteractions();

    // 4. Kick off initial asynchronous actions.
    // These run in the background. The subscriber will update the UI when they complete.
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    
    // 5. Initialize UI modules that need to attach listeners.
    initializeImpersonationToolbar();
    setupGodModeTrigger();
    setupHamburgerMenu();

    // 6. Perform the very first render.
    // This will show the initial "Loading..." states correctly.
    renderApp();
    
    console.log("--- main() finished ---");
}

main();

