// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

function createMenuItemHTML(item) {
    const userRole = useAppStore.getState().auth.getUserRole();
    const adminControls = `...`; // Your admin controls HTML
    const godUserControls = `...`; // Your god user controls HTML

    return `
        <div class="menu-item-card" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-pizza.jpg'}" alt="${item.name}" class="menu-item-image">
            <div class="menu-item-content">
                <h3 class="menu-item-name">${item.name}</h3>
                <p class="menu-item-description">${item.description}</p>
                <div class="menu-item-footer">
                    <p class="menu-item-price">$${parseFloat(item.price).toFixed(2)}</p>
                    <button class="add-to-cart-btn button-primary" data-item-id="${item.id}">Add to Cart</button>
                </div>
                ${(userRole === 'owner' || userRole === 'manager') ? adminControls : ''}
                ${(userRole === 'manager') ? godUserControls : ''}
            </div>
        </div>
    `;
}

export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Read the nested 'menu' slice from the store.
    const { items, isLoading, error } = useAppStore.getState().menu;

    if (isLoading) {
        mainContent.innerHTML = '<div class="loading-spinner">Loading menu...</div>';
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

    const itemsByCategory = items.reduce((acc, item) => {
        const category = item.category || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
        acc[category].push(item);
        return acc;
    }, {});

    const contentHTML = Object.entries(itemsByCategory).map(([category, categoryItems]) => `
        <section class="menu-category">
            <h2 class="category-title">${category}</h2>
            <div class="menu-items-grid">
                ${categoryItems.map(createMenuItemHTML).join('')}
            </div>
        </section>
    `).join('');

    mainContent.innerHTML = contentHTML;
    attachMenuEventListeners();
}

function attachMenuEventListeners() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    mainContent.addEventListener('click', (event) => {
        const target = event.target;
        if (target.matches('.add-to-cart-btn')) {
            const itemId = target.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
        }
        // ... other listeners for admin buttons
    });
}