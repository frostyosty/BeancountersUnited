// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Generates the HTML for a single menu item card.
 * This function also checks the user's role to add owner/god user controls.
 *
 * @param {object} item - The menu item data (e.g., { id, name, price, ... }).
 * @returns {string} The HTML string for the menu item.
 */
function createMenuItemHTML(item) {
    // Get the current user's role from our Zustand store.
    const { getUserRole } = useAppStore.getState();
    const userRole = getUserRole();

    // --- In-situ editing controls for Restaurant Owner and God User ---
    const ownerControls = `
        <div class="item-admin-controls" style="margin-top: 10px; display: flex; gap: 10px;">
            <button class="button-secondary edit-item-btn" data-item-id="${item.id}">Edit Details</button>
        </div>
    `;

    // --- God User ONLY controls ---
    const godUserControls = `
        <button class="button-danger delete-item-btn" data-item-id="${item.id}">Delete</button>
    `;

    let adminControlsHTML = '';
    if (userRole === 'owner' || userRole === 'manager') {
        adminControlsHTML = ownerControls;
    }
    // For the god user, we can append their special controls
    if (userRole === 'manager') {
        // A simple way to inject the delete button into the owner controls div
        adminControlsHTML = adminControlsHTML.replace('</div>', `${godUserControls}</div>`);
    }


    return `
        <div class="menu-item-card" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" class="menu-item-image">
            <div class="menu-item-content">
                <h3 class="menu-item-name">${item.name}</h3>
                <p class="menu-item-description">${item.description}</p>
                <div class="menu-item-footer">
                    <p class="menu-item-price">$${parseFloat(item.price).toFixed(2)}</p>
                    <button class="add-to-cart-btn button-primary" data-item-id="${item.id}">Add to Cart</button>
                </div>
                ${adminControlsHTML}
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
    if (!mainContent) return;

    const { menuItems, isMenuLoading, menuError } = useAppStore.getState();

    if (isMenuLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }

    if (menuError) {
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${menuError}</p></div>`;
        return;
    }

    if (menuItems.length === 0) {
        mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`;
        return;
    }

    try {
        const itemsByCategory = menuItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(item);
            return acc;
        }, {});

        const contentHTML = Object.entries(itemsByCategory).map(([category, items]) => `
            <section class="menu-category" id="category-${category.toLowerCase().replace(/\s+/g, '-')}">
                <h2 class="category-title">${category}</h2>
                <div class="menu-items-grid">
                    ${items.map(createMenuItemHTML).join('')}
                </div>
            </section>
        `).join('');

        mainContent.innerHTML = contentHTML;
        attachMenuEventListeners();

    } catch (error) {
        console.error("Error while building menu HTML:", error);
        mainContent.innerHTML = `<div class="error-message"><h2>There was a problem displaying the menu.</h2></div>`;
    }
}


/**
 * Attaches event listeners for interactive elements on the menu page.
 */
function attachMenuEventListeners() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use a single event listener with delegation
    mainContent.addEventListener('click', (event) => {
        const target = event.target;
        // Use .closest() to find the button even if an inner element is clicked
        const addToCartButton = target.closest('.add-to-cart-btn');
        const editItemButton = target.closest('.edit-item-btn');
        const deleteItemButton = target.closest('.delete-item-btn');

        if (addToCartButton) {
            const itemId = addToCartButton.dataset.itemId;
            const menuItem = useAppStore.getState().menuItems.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
            return; // Stop further processing
        }

        if (editItemButton) {
            const itemId = editItemButton.dataset.itemId;
            console.log(`TODO: Show item details edit modal for item ID: ${itemId}`);
            // Later this will call uiUtils.showModal(...) with the edit form
            alert(`Editing item ${itemId} - Feature coming soon!`);
            return;
        }

        if (deleteItemButton) {
            const itemId = deleteItemButton.dataset.itemId;
            const menuItem = useAppStore.getState().menuItems.find(i => i.id === itemId);
            if (confirm(`Are you sure you want to permanently delete "${menuItem.name}"?`)) {
                console.log(`TODO: Call API to delete item ID: ${itemId}`);
                alert(`Deleting item ${itemId} - Feature coming soon!`);
            }
            return;
        }
    });
}