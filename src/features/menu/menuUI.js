// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js'; // We'll create this file next for generic helpers

/**
 * Generates the HTML for a single menu item card.
 * This function also checks the user's role to add owner/god user controls.
 *
 * @param {object} item - The menu item data (e.g., { id, name, price, ... }).
 * @returns {string} The HTML string for the menu item.
 */
function createMenuItemHTML(item) {
    // Get the current user's role from our Zustand store.
    const userRole = useAppStore.getState().auth?.profile?.role || 'guest';

    // --- In-situ editing controls for Owner and God User ---
    // These are only added to the HTML if the role is 'owner' or 'manager' (god user).
    const adminControls = `
        <div class="item-admin-controls">
            <button class="edit-price-btn" data-item-id="${item.id}">Edit Price</button>
            <button class="edit-item-btn" data-item-id="${item.id}">Edit Details</button>
        </div>
    `;

    // --- God User ONLY controls ---
    const godUserControls = `
        <div class="item-god-controls">
            <button class="delete-item-btn" data-item-id="${item.id}">DELETE</button>
        </div>
    `;

    return `
        <div class="menu-item-card" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" class="menu-item-image">
            <div class="menu-item-content">
                <h3 class="menu-item-name">${item.name}</h3>
                <p class="menu-item-description">${item.description}</p>
                <div class="menu-item-footer">
                    <p class="menu-item-price">$${item.price.toFixed(2)}</p>
                    <button class="add-to-cart-btn" data-item-id="${item.id}">Add to Cart</button>
                </div>
                ${(userRole === 'owner' || userRole === 'manager') ? adminControls : ''}
                ${(userRole === 'manager') ? godUserControls : ''}
            </div>
        </div>
    `;
}

/**
 * Renders the entire menu page into the main content area.
 * It intelligently displays loading, error, or content states based on the store.
 */
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) {
        console.error("Fatal error: #main-content element not found.");
        return;
    }

    // Get the entire menu state object from our Zustand store.
    const { items, isLoading, error } = useAppStore.getState().menu;

    let contentHTML = '';

    if (isLoading) {
        // --- Loading State ---
        contentHTML = '<div class="loading-spinner">Loading menu...</div>';
    } else if (error) {
        // --- Error State (handles offline case gracefully) ---
        contentHTML = `
            <div class="error-message">
                <h2>Could not load menu</h2>
                <p>${error}</p>
                <p>Please check your internet connection and try again.</p>
            </div>
        `;
    } else if (items.length === 0) {
        // --- Empty State ---
        contentHTML = `
            <div class="empty-state">
                <h2>Our menu is currently empty</h2>
                <p>We're busy cooking up something new. Please check back later!</p>
            </div>
        `;
    } else {
        // --- Success State ---
        // Group items by category
        const itemsByCategory = items.reduce((acc, item) => {
            const category = item.category || 'Other';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(item);
            return acc;
        }, {});

        // Build the HTML for each category section
        contentHTML = Object.entries(itemsByCategory).map(([category, categoryItems]) => `
            <section class="menu-category" id="category-${category.toLowerCase().replace(' ', '-')}">
                <h2 class="category-title">${category}</h2>
                <div class="menu-items-grid">
                    ${categoryItems.map(createMenuItemHTML).join('')}
                </div>
            </section>
        `).join('');
    }

    mainContent.innerHTML = contentHTML;
    // After rendering, attach event listeners for the new buttons
    attachMenuEventListeners();
}

/**
 * Attaches event listeners for interactive elements on the menu page.
 * This should be called *after* the menu HTML has been rendered.
 */
function attachMenuEventListeners() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use event delegation for better performance
    mainContent.addEventListener('click', (event) => {
        const target = event.target;

        // --- Public User Actions ---
        if (target.matches('.add-to-cart-btn')) {
            const itemId = target.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                // Call the addItem action from our cartSlice (we'll build this next)
                // For now, let's just log it.
                console.log(`TODO: Add item to cart:`, menuItem);
                // useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`);
            }
        }

        // --- Owner Actions ---
        if (target.matches('.edit-price-btn')) {
            const itemId = target.dataset.itemId;
            console.log(`TODO: Show price edit modal for item ID: ${itemId}`);
            // uiUtils.showModal(...);
        }
        if (target.matches('.edit-item-btn')) {
            const itemId = target.dataset.itemId;
            console.log(`TODO: Show item details edit modal for item ID: ${itemId}`);
        }

        // --- God User Actions ---
        if (target.matches('.delete-item-btn')) {
            const itemId = target.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Are you sure you want to permanently delete "${menuItem.name}"? This cannot be undone.`)) {
                console.log(`TODO: Call API to delete item ID: ${itemId}`);
                // api.deleteMenuItem(itemId).then(() => useAppStore.getState().fetchMenu());
            }
        }
    });
}