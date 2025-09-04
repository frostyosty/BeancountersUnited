// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { initializeImpersonationToolbar } from './features/admin/godModeUI.js';

// Import all our feature renderers
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderCartPage } from './features/cart/cartUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';


/**
 * This is our single, simple "re-render" function. It reads the LATEST state
 * from the store every time it runs and updates the entire app.
 */
function renderApp() {
    console.log("--- renderApp() called ---");

    // 1. Render persistent UI components that are always visible.
    renderAuthStatus();

    const cartCountSpan = document.getElementById('cart-count');
    if (cartCountSpan) {
        try {
                    cartCountSpan.textContent = useAppStore.getState().cart.getTotalItemCount();
        } catch (e) {
            cartCountSpan.textContent = '0';
        }
    }

    // 2. Act as a router to render the main content area.
    const hash = window.location.hash || '#menu';

    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        if (link.getAttribute('href') === hash) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    switch(hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
        // Add more routes here
        default:
            renderMenuPage();
            break;
    }
}

// --- Application Start ---

console.log("--- main.js script started ---");

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
        <footer id="main-footer"><p>&copy; 2024 Mealmates</p></footer>
    `;
}


// Set up listeners
useAppStore.subscribe(renderApp);
window.addEventListener('hashchange', renderApp);

document.body.addEventListener('click', (e) => {
    const navLink = e.target.closest('a[href^="#"]');
    if (navLink) {
        e.preventDefault();
        const newHash = navLink.getAttribute('href');
        if (window.location.hash !== newHash) window.location.hash = newHash;
    }
});

// Kick off initial asynchronous actions



setupGodModeTrigger();
// --- INITIAL RENDER ---
renderApp();


// --- KICK OFF INITIAL ACTIONS ---
console.log("main.js: ABOUT TO CALL listenToAuthChanges.");
console.log("main.js: Current state of get().auth:", useAppStore.getState().auth);
console.log("main.js: Is get().auth.isImpersonating a function?", typeof useAppStore.getState().auth.isImpersonating);
useAppStore.getState().auth.listenToAuthChanges();

console.log("main.js: ABOUT TO CALL fetchMenu.");
useAppStore.getState().menu.fetchMenu();


console.log("--- main.js script setup finished ---");





/**
 * Sets up a "backdoor" for developers to quickly log in as the god user.
 * It listens for a triple-click on the header or a 3-second long press on mobile.
 * WARNING: This is for development only and should be removed for production.
 * The credentials are hardcoded here for maximum development convenience.
 */
function setupGodModeTrigger() {
    const triggerElement = document.getElementById('main-header');
    if (!triggerElement) return;

    let clickCount = 0;
    let clickTimer = null;
    let longPressTimer = null;
    const longPressDuration = 3000; // 3 seconds

    const activateGodMode = () => {
        console.warn("GOD MODE TRIGGER ACTIVATED");
        // Prevent any other timers from firing
        clearTimeout(clickTimer);
        clearTimeout(longPressTimer);
        clickCount = 0;

        const { login, isAuthenticated } = useAppStore.getState();

        // Don't do anything if already logged in as this user
        if (isAuthenticated && useAppStore.getState().user?.email === 'god@mode.dev') {
            console.log("Already logged in as God User.");
            return;
        }
        
        const email = 'god@mode.dev';
        const password = 'password123';

        login(email, password).then(({ error }) => {
            if (error) {
                alert(`God Mode Login Failed: ${error.message}`);
            } else {
                // The onAuthStateChange listener will handle the UI update.
                console.log("God mode login successful.");
                alert("God Mode Activated!");
            }
        });
    };

    // --- Triple-Click Logic for Desktop ---
    triggerElement.addEventListener('click', () => {
        clickCount++;
        // Reset the counter if clicks are too far apart (more than 1 second)
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);

        if (clickCount === 3) {
            activateGodMode();
        }
    });

    // --- Long-Press Logic for Mobile ---
    triggerElement.addEventListener('touchstart', (e) => {
        e.preventDefault(); // Prevents unwanted browser actions on touch
        longPressTimer = setTimeout(activateGodMode, longPressDuration);
    });

    triggerElement.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
    });
    triggerElement.addEventListener('touchcancel', () => {
        clearTimeout(longPressTimer);
    });

    console.log("God Mode Trigger (triple-click/long-press on header) is active.");
}