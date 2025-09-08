// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus, showLoginSignupModal } from './features/auth/authUI.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

// --- Add new imports at the top ---
import { renderOwnerDashboard } from './features/admin/ownerDashboardUI.js';
import * as uiUtils from './utils/uiUtils.js'; // Make sure this is imported if not already


let isAppInitialized = false;

function renderApp() {
    renderAuthStatus();
    renderPageContent();
    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
            cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) { cartCountSpan.textContent = '0'; }
    }
}

function renderPageContent() {
const hash = window.location.hash || '#menu';
    const { getUserRole } = useAppStore.getState().auth; // Get from auth namespace
    const userRole = getUserRole();

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });
    switch(hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // --- ADD THIS NEW ROUTE ---
        case '#owner-dashboard':
            if (userRole === 'owner' || userRole === 'manager') {
                renderOwnerDashboard();
            } else {
                document.getElementById('main-content').innerHTML = `
                    <div class="error-message"><h2>Access Denied</h2></div>
                `;
            }
            break;
        // --- END NEW ROUTE ---
        default:
            renderMenuPage();
            break;
    }
}

function setupInteractions() {
    document.body.addEventListener('click', (e) => {
        // --- THIS IS THE FIX ---
        // We now check for the correct button IDs from authUI.js
        if (e.target.matches('#login-btn') || e.target.matches('#signup-btn')) {
            showLoginSignupModal();
            return;
        }
        if (e.target.matches('#logout-btn')) {
            useAppStore.getState().auth.logout();
            return;
        }
        // --- END FIX ---

        const navLink = e.target.closest('a[href^="#"]');
        if (navLink) {
            e.preventDefault();
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


/**
 * The main application initialization function.
 */
function main() {
    if (isAppInitialized) return;
    isAppInitialized = true;
    console.log("--- main() started ---");

    const appElement = document.getElementById('app');
    if (appElement) {
        // --- UPDATED SHELL WITH HAMBURGER & PANEL ---
        appElement.innerHTML = `
            <header id="main-header">
                <h1>Mealmates</h1>
                <nav>
                    <a href="#menu" class="nav-link">Menu</a>
                    <a href="#cart" class="nav-link">Cart (<span id="cart-count">0</span>)</a>
                    <div id="auth-status-container"></div>
                    <button id="hamburger-btn" class="hamburger-button">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>
                </nav>
            </header>
            <main id="main-content"></main>
            <footer id="main-footer"><p>&copy; ${new Date().getFullYear()} Mealmates</p></footer>
            
            <div id="mobile-menu-panel" class="mobile-menu-panel">
                <nav id="mobile-nav-links">
                    <!-- Mobile navigation links will be rendered here -->
                </nav>
            </div>
        `;
    }

    // 2. Set up ALL your state subscribers. This is their logical home.
    useAppStore.subscribe(renderApp); // The main "brute-force" renderer
    
    // Subscriber to apply theme variables when they are loaded from the DB
    useAppStore.subscribe(
        (state) => state.siteSettings.settings.themeVariables,
        (themeVariables) => {
            if (themeVariables) {
                console.log("Applying saved theme from database...", themeVariables);
                for (const [varName, value] of Object.entries(themeVariables)) {
                    uiUtils.updateCssVariable(varName, value);
                }
            }
        }
    );
    // Add any other specific subscribers here...


    // 3. Set up listeners for user interaction.
    window.addEventListener('hashchange', renderPageContent);
    setupNavigationAndInteractions();

    // Kick off initial asynchronous actions
    useAppStore.getState().auth.listenToAuthChanges();
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();
    
    initializeImpersonationToolbar();
    setupGodModeTrigger();

    // --- NEW: Attach listener for the hamburger menu ---
    setupHamburgerMenu();
    
    // Perform the very first render
    renderApp();
    
    console.log("--- main.js script setup finished ---");
}




// --- NEW HELPER FUNCTION FOR HAMBURGER ---
function setupHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const mobileMenuPanel = document.getElementById('mobile-menu-panel');
    const mainContent = document.getElementById('main-content'); // To close menu on content click

    if (!hamburgerBtn || !mobileMenuPanel) return;
    
    // The content of the mobile menu will be the same as our main nav for now
    // Later, this can be made configurable by the God User
    const mobileNavContainer = document.getElementById('mobile-nav-links');
    const desktopNav = document.querySelector('#main-header nav');
    if (mobileNavContainer && desktopNav) {
        // Simple clone for now. A more robust solution would build this from a config object.
        const navLinks = desktopNav.querySelectorAll('a.nav-link');
        navLinks.forEach(link => {
            mobileNavContainer.appendChild(link.cloneNode(true));
        });
    }

    const toggleMenu = () => {
        hamburgerBtn.classList.toggle('open');
        mobileMenuPanel.classList.toggle('open');
    };

    hamburgerBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent click from bubbling to other listeners
        toggleMenu();
    });

    // Close menu if a link is clicked
    mobileMenuPanel.addEventListener('click', (e) => {
        if (e.target.matches('a.nav-link')) {
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

main();