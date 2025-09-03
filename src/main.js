// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

console.log("--- main.js script started (Auth Integration Test) ---");

// Render the basic HTML shell
const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header">
            <h1>Mealmates</h1>
            <nav>
                <a href="#menu" class="nav-link">Menu</a>
                <div id="auth-status-container"></div>
            </nav>
        </header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

/**
 * This is our single "re-render" function.
 * It's called on any state change.
 */
function renderApp() {
    console.log("--- renderApp() called ---");
    // Render all components
    renderAuthStatus();
    renderMenuPage();
}

// --- SUBSCRIBER ---
// Subscribe to ALL state changes. When anything in the store changes, re-render the app.
useAppStore.subscribe(renderApp);


// --- KICK OFF INITIAL ACTIONS ---
// "Fire and forget" - the subscriber will handle the UI updates when they complete.
console.log("main.js: Kicking off listenToAuthChanges()...");
useAppStore.getState().listenToAuthChanges();

console.log("main.js: Kicking off fetchMenu()...");
useAppStore.getState().fetchMenu();


// --- INITIAL RENDER ---
// Perform the very first render to show the initial "Loading..." states.
console.log("main.js: Performing initial renderApp() call.");
renderApp();

console.log("--- main.js script setup finished ---");