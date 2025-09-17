// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Generates the HTML for a single menu item card.
 */
const createMenuItemHTML = (item) => {
    const { getUserRole } = useAppStore.getState().auth;
    const userRole = getUserRole();
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
    if (userRole === 'owner' || userRole === 'manager') { adminControlsHTML = ownerControls; }
    if (userRole === 'manager') { adminControlsHTML = adminControlsHTML.replace('</div>', ` ${godUserControls}</div>`); }

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
 * Attaches event listeners for the category filter tabs.
 */
function attachCategoryTabListeners() {
    const tabsContainer = document.querySelector('.sub-tabs-container');
    if (!tabsContainer || tabsContainer.dataset.listenerAttached) return;

    tabsContainer.addEventListener('click', (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            // Call the action from the uiSlice to change the state
            useAppStore.getState().ui.setActiveMenuCategory(newCategory);
        }
    });
    tabsContainer.dataset.listenerAttached = 'true';
}

/**
 * Attaches event listeners for the menu item cards.
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
 * Renders the entire menu page.
 */
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // --- Get ALL necessary state from the store ---
    const { items, isLoading, error } = useAppStore.getState().menu;
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const { activeMenuCategory } = useAppStore.getState().ui; // <-- THE FIX IS HERE

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

    try {
        const orderedCategories = getMenuCategories();
        const categoriesForTabs = ['All', ...orderedCategories];

        const tabsHTML = categoriesForTabs.map(category => `
            <button
                class="sub-tab-button ${category === activeMenuCategory ? 'active' : ''}"
                data-category="${category}">
                ${category}
            </button>
        `).join('');

        const filteredItems = activeMenuCategory === 'All'
            ? items
            : items.filter(item => (item.category || 'Uncategorized') === activeMenuCategory);

        const itemsByCategory = filteredItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});

        const sortedCategoryKeys = orderedCategories.filter(cat => itemsByCategory[cat]);

        const menuContentHTML = sortedCategoryKeys.map(category => {
            const categoryItems = itemsByCategory[category];
            const itemsHTML = categoryItems.map(createMenuItemHTML).join('');
            return `
                <section class="menu-category">
                    <h2 class="category-title">${category}</h2>
                    <div class="menu-items-grid">${itemsHTML}</div>
                </section>
            `;
        }).join('');

        const finalHTML = `
            <div class="menu-header">
                <h2>Our Menu</h2>
                <div class="sub-tabs-container">${tabsHTML}</div>
            </div>
            ${menuContentHTML}
        `;

        mainContent.innerHTML = finalHTML;
        
        attachMenuEventListeners();
        attachCategoryTabListeners();

    } catch (e) {
        console.error("CRITICAL RENDER ERROR in renderMenuPage:", e);
        mainContent.innerHTML = `<div class="error-message">A critical error occurred while rendering the menu.</div>`;
    }
}