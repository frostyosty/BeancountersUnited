// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
// Add other renderers as needed
// import { renderAuthStatus } from './features/auth/authUI.js';

function renderApp() {
    console.log("--- renderApp() called ---");
    // renderAuthStatus();
    renderMenuPage();
}

console.log("--- main.js script started ---");

const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

useAppStore.subscribe(renderApp);
window.addEventListener('hashchange', renderApp); // For routing later

// Kick off the data fetch
useAppStore.getState().menu.fetchMenu();
// useAppStore.getState().auth.listenToAuthChanges();

// Initial render
renderApp();
console.log("--- main.js script setup finished ---");