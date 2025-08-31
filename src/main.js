// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';

async function initializeApp() {
    console.log("--- main.js script started ---");

    const appElement = document.getElementById('app');
    if (appElement) {
        appElement.innerHTML = `
            <header id="main-header"><h1>Mealmates</h1></header>
            <main id="main-content" style="border: 5px dashed red; min-height: 300px;"></main>
            <footer id="main-footer"><p>&copy; 2024</p></footer>
        `;
    }

    // Subscribe to changes. With a flat store, this is reliable.
    useAppStore.subscribe(renderMenuPage);

    // Initial Render (will show loading)
    renderMenuPage();

    // Kick off the fetch
    await useAppStore.getState().fetchMenu();
}

initializeApp();