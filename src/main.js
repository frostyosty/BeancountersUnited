// src/main.js
import './assets/css/style.css';
import { supabase, supabaseError } from './supabaseClient.js'; // Import both
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';

console.log("--- main.js script started ---");

const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `<main id="main-content"></main>`;
}
const mainContent = document.getElementById('main-content');

// --- CRITICAL CHECK ---
if (supabaseError) {
    mainContent.innerHTML = `
        <div class="error-message" style="border-color: red; background-color: #fff0f0; padding: 20px;">
            <h2 style="color: red;">Application Start Failed</h2>
            <p><strong>Error:</strong> ${supabaseError}</p>
        </div>
    `;
} else {
    // Only run the app if Supabase initialized correctly
    console.log("Supabase client initialized successfully. Starting app...");
    
    // Render initial shell
    mainContent.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <div id="page-content">Loading...</div>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;

    // A simplified render function for this test
    function renderApp() {
        const { isMenuLoading } = useAppStore.getState();
        const pageContent = document.getElementById('page-content');
        if (isMenuLoading) {
            pageContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        } else {
            renderMenuPage(); // Call the real renderer
        }
    }

    useAppStore.subscribe(renderApp);
    useAppStore.getState().fetchMenu();
    renderApp();
}