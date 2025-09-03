// src/main.js - MENU ONLY TEST
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';

console.log("--- main.js script started (Menu Only Test) ---");

// --- Render the basic HTML shell ---
const appElement = document.getElementById('app');
if (appElement) {
    appElement.innerHTML = `
        <header id="main-header"><h1>Mealmates</h1></header>
        <main id="main-content"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// --- SUBSCRIBER ---
// We subscribe to the entire store. When menu data arrives, this will fire.
useAppStore.subscribe(renderMenuPage);

// --- KICK OFF INITIAL ACTIONS ---
// We only call the action to fetch the menu.
useAppStore.getState().fetchMenu();

// --- INITIAL RENDER ---
// We call renderMenuPage() once to show the initial "Loading..." state.
renderMenuPage();

console.log("--- main.js script setup finished ---");