// src/features/menu/menuUI.js - FINAL VERSION
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

// --- HELPER FUNCTIONS (DEFINED AS CONSTANTS BEFORE USE) ---

const createMenuItemHTML = (item) => {
    const { getUserRole } = useAppStore.getState();
    const userRole = getUserRole();

    const ownerControls = `
        <div class="item-admin-controls" style="margin-top: 10px; display: flex; gap: 10px;">
            <button class="button-secondary edit-item-btn" data-item-id="${item.id}">Edit</button>
        </div>
    `;
    const godUserControls = `
        <button class="button-danger delete-item-btn" data-item-id="${item.id}">Delete</button>
    `;
    let adminControlsHTML = '';
    if (userRole === 'owner' || userRole === 'manager') {
        adminControlsHTML = ownerControls;
    }
    if (userRole === 'manager') {
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
};

const attachMenuEventListeners = () => {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Use a single, persistent event listener
    if (!mainContent.dataset.menuListenersAttached) {
        mainContent.addEventListener('click', (event) => {
            const target = event.target;
            const menuItemCard = target.closest('.menu-item-card');
            if (!menuItemCard) return;
            const itemId = menuItemCard.dataset.itemId;

            if (target.closest('.add-to-cart-btn')) {
                const menuItem = useAppStore.getState().menuItems.find(i => i.id === itemId);
                if (menuItem) {
                    useAppStore.getState().addItem(menuItem);
                    uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
                }
            } else if (target.closest('.edit-item-btn')) {
                alert(`Editing item ${itemId} - Feature coming soon!`);
            } else if (target.closest('.delete-item-btn')) {
                const menuItem = useAppStore.getState().menuItems.find(i => i.id === itemId);
                if (confirm(`Are you sure you want to delete "${menuItem.name}"?`)) {
                    alert(`Deleting item ${itemId} - Feature coming soon!`);
                }
            }
        });
        mainContent.dataset.menuListenersAttached = 'true';
    }
};

// --- EXPORTED RENDER FUNCTION ---
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

    const itemsByCategory = menuItems.reduce((acc, item) => {
        const category = item.category || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
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
}