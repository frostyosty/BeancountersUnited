// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';

console.log("--- main.js script started (Brute Force Test) ---");

// Render the basic HTML shell
const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// This is the main application function
async function initializeApp() {
    // 1. Render the initial loading state
    renderMenuPage(); // This will show "Loading..." because the initial state is isLoading: true

    // 2. Call the fetch action. This is an async function.
    // We will `await` it to ensure it is completely finished.
    console.log("initializeApp: Awaiting fetchMenu()...");
    await useAppStore.getState().menu.fetchMenu();
    console.log("initializeApp: fetchMenu() has completed.");

    // 3. Now that the fetch is done and the state is updated,
    //    call the render function again.
    console.log("initializeApp: Calling renderMenuPage() with final state.");
    renderMenuPage();
}
