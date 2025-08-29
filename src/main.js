// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';

function renderApp() {
    console.log("--- renderApp() called ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { menuItems, isMenuLoading, menuError } = useAppStore.getState();
    console.log("Rendering with state:", { isMenuLoading, hasError: !!menuError, itemCount: menuItems.length });

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu from API...</div>`;
        return;
    }
    if (menuError) {
        mainContent.innerHTML = `<div class="error-message">Error: ${menuError}</div>`;
        return;
    }
    if (menuItems.length === 0) {
        mainContent.innerHTML = `<div class="empty-state">The menu is empty.</div>`;
        return;
    }

    const menuHTML = menuItems.map(item => `
        <div class="menu-item-card" style="border: 1px solid green; padding: 10px; margin: 5px;">
            <h3>${item.name}</h3>
            <p>${item.description}</p>
            <p><strong>$${parseFloat(item.price).toFixed(2)}</strong></p>
        </div>
    `).join('');
    mainContent.innerHTML = `<div class="menu-items-grid">${menuHTML}</div>`;
}

// --- Application Start ---
console.log("--- main.js script started ---");

const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// Subscribe to ALL state changes. When anything in the store changes, re-render the app.
useAppStore.subscribe(renderApp);

// Kick off the initial data fetch.
useAppStore.getState().fetchMenu();

// Perform the initial render, which will show the "Loading..." state.
renderApp();

console.log("--- main.js script setup finished ---");