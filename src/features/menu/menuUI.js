// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';


// This is a small piece of state local to the menu feature
let activeCategory = 'All';

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
 * Renders the entire menu page, now with owner-configurable category tabs and order.
 */

export function renderMenuPage() {
        console.log("--- 1. renderMenuPage() CALLED ---");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
console.log("renderMenuPage() defensive check started");
    // --- DEFENSIVE CHECK ---
    // First, check if the entire 'menu' slice exists.
    const menuSlice = useAppStore.getState().menu;
    if (!menuSlice) {
        // This can happen during the first few milliseconds of startup.
        // It's safe to just show loading and wait for the next render.
        mainContent.innerHTML = `<div class="loading-spinner">Initializing menu...</div>`;
        return;
    }
    // --- END CHECK ---
console.log("renderMenuPage() destrucutring about to begin");
    // Now it's safe to destructure the properties.
    const { items, isLoading, error } = menuSlice;
console.log("renderMenuPage() isLoading about to begin");
    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }
    if (error) {
        console.log("--- 3b. renderMenuPage: Rendering ERROR state ---");
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${error}</p></div>`;
        return;
    }
    if (items.length === 0) {
        console.log("--- 3c. renderMenuPage: Rendering EMPTY state ---");
        mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`;
        return;
    }

    // If we get here, we are in the SUCCESS state.
    console.log("--- 4. renderMenuPage: Preparing to render SUCCESS state ---");

    try {
        const { getMenuCategories } = useAppStore.getState().siteSettings;
        const orderedCategories = getMenuCategories();
        console.log("--- 5. Got categories:", orderedCategories);

        let activeCategory = window.activeMenuCategory || 'All';
        const categoriesForTabs = ['All', ...orderedCategories];

const tabsHTML = categoriesForTabs.map(category => `
        <button
            class="sub-tab-button ${category === activeMenuCategory ? 'active' : ''}"
            data-category="${category}">
            ${category}
        </button>
    `).join('');
        const filteredItems = activeCategory === 'All'
            ? items
            : items.filter(item => (item.category || 'Uncategorized') === activeCategory);
        console.log(`--- 6. Filtered down to ${filteredItems.length} items for category "${activeCategory}"`);

        const itemsByCategory = filteredItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});
        console.log("--- 7. Grouped items by category.");

        const sortedCategoryKeys = orderedCategories.filter(cat => itemsByCategory[cat]);
        console.log("--- 8. Created sorted key list for rendering:", sortedCategoryKeys);

        const menuContentHTML = sortedCategoryKeys.map(category => {
            const categoryItems = itemsByCategory[category];
            // This is the only place left for the error to hide.
            const itemsHTML = categoryItems.map(createMenuItemHTML).join('');
            return `
                <section class="menu-category">
                    <h2 class="category-title">${category}</h2>
                    <div class="menu-items-grid">${itemsHTML}</div>
                </section>
            `;
        }).join('');
        console.log("--- 9. Successfully generated final HTML. Length:", menuContentHTML.length);

        const finalHTML = `
            <div class="menu-header">
                <h2>Our Menu</h2>
                <div class="sub-tabs-container">${tabsHTML}</div>
            </div>
            ${menuContentHTML}
        `;

        mainContent.innerHTML = finalHTML;
        console.log("--- 10. SUCCESSFULLY SET innerHTML ---");
        
        attachMenuEventListeners();
        attachCategoryTabListeners();

    } catch (e) {
        console.error("--- X. CRITICAL RENDER ERROR in renderMenuPage ---", e);
        mainContent.innerHTML = `<div class="error-message">A critical error occurred while rendering the menu. Check the console.</div>`;
    }
}


/**
 * Attaches event listeners for the category filter tabs.
 */
function attachCategoryTabListeners() {
    const tabsContainer = document.querySelector('.sub-tabs-container');
    if (!tabsContainer) return;

    // Use a new listener that calls the store action
    tabsContainer.addEventListener('click', (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            // Call the action from the uiSlice to change the state
            useAppStore.getState().ui.setActiveMenuCategory(newCategory);
        }
    });
}