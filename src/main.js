// src/main.js
import './assets/css/style.css';
import { useAppStore } from './store/appStore.js';
import { renderMenuPage } from './features/menu/menuUI.js';
// We'll bring back the real files for these later. For now, they are simple functions.
function renderCartPage() {
    const mainContent = document.getElementById('main-content');
    if(mainContent) mainContent.innerHTML = '<h2>Cart Page</h2><p>Coming soon...</p>';
}

function renderApp() {
    const hash = window.location.hash || '#menu';

    // Style the active link in the nav
    document.querySelectorAll('#main-header nav a.nav-link').forEach(link => {
        link.getAttribute('href') === hash ? link.classList.add('active') : link.classList.remove('active');
    });

    switch(hash) {
        case '#menu':
            renderMenuPage();
            break;
        case '#cart':
            renderCartPage();
            break;
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
                <a href="#cart" class="nav-link">Cart</a>
            </nav>
        </header>
        <main id="main-content" style="border: 5px dashed red; min-height: 300px;"></main>
        <footer id="main-footer"><p>&copy; 2024</p></footer>
    `;
}

// Set up listeners
useAppStore.subscribe(renderApp);
window.addEventListener('hashchange', renderApp);

// Add a simple navigation handler
document.body.addEventListener('click', (e) => {
    if (e.target.matches('a[href^="#"]')) {
        e.preventDefault();
        const newHash = e.target.getAttribute('href');
        if (window.location.hash !== newHash) {
            window.location.hash = newHash;
        }
    }
});

// Initial data fetch
useAppStore.getState().fetchMenu();

// Initial render
renderApp();