// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

const createMenuItemHTML = (item) => {
    const { getUserRole } = useAppStore.getState().auth;
    const userRole = getUserRole();

    // Define the HTML for the owner's controls
    const ownerControls = `
        <div class="item-admin-controls" style="margin-top: 10px; display: flex; gap: 10px;">
            <button class="button-secondary edit-item-btn" data-item-id="${item.id}">Edit</button>
        </div>
    `;

    // Define the HTML for the god user's additional controls
    const godUserControls = `
        <button class="button-danger delete-item-btn" data-item-id="${item.id}">Delete</button>
    `;

    let adminControlsHTML = '';

    // If the user is an owner or manager, add the owner controls
    if (userRole === 'owner' || userRole === 'manager') {
        adminControlsHTML = ownerControls;
    }

    // If the user is a manager, inject the delete button into the owner controls div
    if (userRole === 'manager') {
        // This is a simple but effective way to add the button
        adminControlsHTML = adminControlsHTML.replace('</div>', `${godUserControls}</div>`);
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

const attachMenuEventListeners = () => {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // To prevent adding multiple listeners, we set a flag.
    if (mainContent.dataset.menuListenersAttached === 'true') {
        return;
    }

    mainContent.addEventListener('click', (event) => {
        const target = event.target;
        // Use .closest() to find the button or card even if an inner element (like text) is clicked
        const menuItemCard = target.closest('.menu-item-card');
        if (!menuItemCard) return; // Exit if the click was not inside a menu item card

        const itemId = menuItemCard.dataset.itemId;

        // Handle "Add to Cart" button clicks
        if (target.closest('.add-to-cart-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
        }

        // Handle "Edit" button clicks (for owners/managers)
        else if (target.closest('.edit-item-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            console.log(`TODO: Show item details edit modal for item:`, menuItem);
            alert(`Editing "${menuItem.name}" - Feature coming soon!`);
        }

        // Handle "Delete" button clicks (for managers only)
        else if (target.closest('.delete-item-btn')) {
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Are you sure you want to permanently delete "${menuItem.name}"?`)) {
                console.log(`TODO: Call API to delete item ID: ${itemId}`);
                alert(`Deleting "${menuItem.name}" - Feature coming soon!`);
            }
        }
    });

    // Set the flag to true so we don't add the listener again.
    mainContent.dataset.menuListenersAttached = 'true';
};




export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Correctly read from the 'menu' namespace
    const { items, isLoading, error } = useAppStore.getState().menu;

    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`;
        return;
    }
    else if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${error}</p></div>`;
        return;
    }
    else if (items.length === 0) {
        mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`;
        return;
    }
    else {
        const itemsByCategory = items.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});

        const contentHTML = Object.entries(itemsByCategory).map(([category, categoryItems]) => `...`).join('');
        mainContent.innerHTML = contentHTML;
        attachMenuEventListeners();
    }
}