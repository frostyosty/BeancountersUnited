// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
import { renderAuthStatus } from './features/auth/authUI.js';

function renderApp() {
    console.log("--- renderApp() called ---");
    renderAuthStatus();
    renderMenuPage();
}

console.log("--- main.js script started ---");

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

useAppStore.subscribe(renderApp);

// Kick off initial actions
useAppStore.getState().listenToAuthChanges();
useAppStore.getState().fetchMenu();

// Initial render
renderApp();

console.log("--- main.js script setup finished ---");