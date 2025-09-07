// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';


// This is a small piece of state local to the menu feature
let activeCategory = 'All'; // Default to showing all categories


/**
 * Generates the HTML for a single menu item card.
 * This helper function reads the current user role to show/hide admin controls.
 */
const createMenuItemHTML = (item) => {
    // Get the selector from the correct namespace
    const { getUserRole } = useAppStore.getState().auth;
    const userRole = getUserRole(); // This will reflect the IMPERSONATED role

    // Define the HTML for the owner's controls
    const ownerControls = `
        <div class="item-admin-controls">
            <button class="button-secondary edit-item-btn" data-item-id="${item.id}">Edit</button>
        </div>
    `;
    // Define the HTML for the god user's additional controls
    const godUserControls = `
        <button class="button-danger delete-item-btn" data-item-id="${item.id}">Delete</button>
    `;
    let adminControlsHTML = '';

    // If the currently viewed role is owner or manager, show owner controls
    if (userRole === 'owner' || userRole === 'manager') {
        adminControlsHTML = ownerControls;
    }
    // If the currently viewed role is manager, add the god user controls
    if (userRole === 'manager') {
        // A simple but effective way to add the button
        adminControlsHTML = adminControlsHTML.replace('</div>', ` ${godUserControls}</div>`);
    }

    return `
        <div class="menu-item-card" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" class="menu-item-image">
            <div class="menu-item-content">
                <h3 class="menu-item-name">${item.name}</h3>
                <p class="menu-item-description">${item.description || ''}</p>
                <div class="menu-item-footer">
                    <p class="menu-item-price">$${parseFloat(item.price).toFixed(2)}</p>
                    <button class="add-to-cart-btn button-primary" data-item-id="${item.id}">Add to Cart</button>
                </div>
                ${adminControlsHTML}
            </div>
        </div>
    `;
};

/**
 * Attaches event listeners for all interactive elements on the menu page.
 */
const attachMenuEventListeners = () => {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use a flag to prevent attaching the listener more than once
    if (mainContent.dataset.menuListenersAttached === 'true') return;

    mainContent.addEventListener('click', (event) => {
        const target = event.target;
        const menuItemCard = target.closest('.menu-item-card');
        if (!menuItemCard) return;
        
        const itemId = menuItemCard.dataset.itemId;

        if (target.closest('.add-to-cart-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
        }
        
        else if (target.closest('.edit-item-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            alert(`Editing "${menuItem.name}" - Feature coming soon!`);
        }
        
        else if (target.closest('.delete-item-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Are you sure you want to delete "${menuItem.name}"?`)) {
                alert(`Deleting "${menuItem.name}" - Feature coming soon!`);
            }
        }
    });

    mainContent.dataset.menuListenersAttached = 'true';
};

/**
 * Renders the entire menu page into the main content area.
 */
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { items, isLoading, error } = useAppStore.getState().menu;

    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${error}</p></div>`;
        return;
    }


    if (items.length === 0) {
        mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`;
        return;
    }



    // 1. Get all unique categories from the menu data
    const categories = ['All', ...new Set(items.map(item => item.category || 'Uncategorized'))];

    // 2. Build the HTML for the tab buttons
    const tabsHTML = categories.map(category => `
        <button
            class="sub-tab-button ${category === activeCategory ? 'active' : ''}"
            data-category="${category}">
            ${category}
        </button>
    `).join('');

    // 3. Filter the items to be displayed based on the active category
    const filteredItems = activeCategory === 'All'
        ? items
        : items.filter(item => (item.category || 'Uncategorized') === activeCategory);

    // 4. Group the *filtered* items by category for rendering
    const itemsByCategory = filteredItems.reduce((acc, item) => {
        const category = item.category || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
        acc[category].push(item);
        return acc;
    }, {});

    // --- END NEW LOGIC ---

    const menuContentHTML = Object.entries(itemsByCategory).map(([category, categoryItems]) => `
        <section class="menu-category">
            <h2 class="category-title">${category}</h2>
            <div class="menu-items-grid">
                ${categoryItems.map(createMenuItemHTML).join('')}
            </div>
        </section>
    `).join('');

    // Assemble the final page HTML
    mainContent.innerHTML = `
        <div class="menu-header">
            <h2>Our Menu</h2>
            <div class="sub-tabs-container">
                ${tabsHTML}
            </div>
        </div>
        ${items.length === 0 ? `<div class="empty-state"><h2>Our menu is currently empty</h2></div>` : menuContentHTML}
    `;

    attachMenuEventListeners();
    attachCategoryTabListeners(); // Attach listeners for our new tabs
}




/**
 * Attaches event listeners for the category filter tabs.
 */
function attachCategoryTabListeners() {
    const tabsContainer = document.querySelector('.sub-tabs-container');
    if (!tabsContainer) return;

    tabsContainer.addEventListener('click', (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            if (newCategory !== activeCategory) {
                activeCategory = newCategory;
                // Re-render the entire menu page to reflect the new filter
                renderMenuPage();
            }
        }
    });
}