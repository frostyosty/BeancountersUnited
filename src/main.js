// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';

console.log("--- main.js script started (Menu Only Test) ---");

// Render the basic HTML shell
const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// Subscribe to the 'menu' slice. Only re-render if it changes.
useAppStore.subscribe(
    (state) => state.menu, // The selector
    renderMenuPage        // The callback
);

// Kick off the initial data fetch.
useAppStore.getState().menu.fetchMenu();

// Perform the initial render.
renderMenuPage();

console.log("--- main.js script setup finished ---");