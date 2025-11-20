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
 * Generates the simplified HTML for the "Reorder" banner.
 */
function createReorderBanner(lastOrder) {
    if (!lastOrder || !lastOrder.order_items || lastOrder.order_items.length === 0) return '';
    
    // Calculate totals
    const totalItems = lastOrder.order_items.reduce((sum, i) => sum + i.quantity, 0);
    
    // Get the first item's name safely
    const firstItem = lastOrder.order_items[0];
    const firstItemName = firstItem.menu_items?.name || 'Item';
    const firstItemQty = firstItem.quantity;

    // Determine the " + X more" text
    const remainingCount = totalItems - firstItemQty;
    const summaryText = remainingCount > 0 
        ? `${firstItemQty}x ${firstItemName} + ${remainingCount} more`
        : `${firstItemQty}x ${firstItemName}`;

    return `
        <div class="reorder-banner" style="
            background: var(--surface-color); 
            border: 1px solid var(--primary-color); 
            border-radius: 8px; 
            padding: 12px 15px; 
            margin-bottom: 20px; 
            display: flex; 
            justify-content: space-between; 
            align-items: center;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
        ">
            <span style="font-weight:500; color: var(--text-color);">
                Reorder <strong>${summaryText}</strong>?
            </span>
            <button id="quick-reorder-btn" class="button-primary small" style="white-space: nowrap; margin-left:10px;">
                Reorder Now
            </button>
        </div>
    `;
}

/**
 * Logic to add previous items to cart and go to checkout.
 */
function handleQuickReorder(order) {
    const { addItem } = useAppStore.getState().cart;
    
    let count = 0;
    order.order_items.forEach(item => {
        if (item.menu_items) {
            // Add the item 'quantity' times
            for (let i = 0; i < item.quantity; i++) {
                addItem(item.menu_items);
                count++;
            }
        }
    });

    if (count > 0) {
        uiUtils.showToast(`${count} items added to cart!`, 'success');
        window.location.hash = '#checkout';
    } else {
        uiUtils.showToast("Could not reorder items (items may no longer exist).", "error");
    }
}

/**
 * Attaches event listeners for the category filter tabs.
 */
function attachCategoryTabListeners() {
    const tabsContainer = document.querySelector('.sub-tabs-container');
    if (!tabsContainer || tabsContainer.dataset.listenerAttached) return;

    tabsContainer.addEventListener('click', (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            useAppStore.getState().setActiveMenuCategory(newCategory);
        }
    });
    tabsContainer.dataset.listenerAttached = 'true';
}

/**
 * Attaches event listeners for the menu item cards.
 */
const attachMenuEventListeners = () => {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.dataset.menuListenersAttached === 'true') return;

    mainContent.addEventListener('click', (event) => {
        const target = event.target;
        const menuItemCard = target.closest('.menu-item-card');
        
        // 1. Add to Cart
        if (menuItemCard && target.closest('.add-to-cart-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
        }

        // 2. Edit Item (Owner/Manager)
        else if (menuItemCard && target.closest('.edit-item-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            alert(`Use the Owner Dashboard to edit this item.`);
        }

        // 3. Delete Item (Manager)
        else if (menuItemCard && target.closest('.delete-item-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Are you sure you want to delete "${menuItem?.name}"?`)) {
                useAppStore.getState().menu.deleteMenuItemOptimistic(itemId); 
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
    const { activeMenuCategory } = useAppStore.getState().ui;
    const { isAuthenticated } = useAppStore.getState().auth;
    const { orders } = useAppStore.getState().orderHistory;

    // --- 1. Logic: Reorder Banner ---
    let reorderBannerHTML = '';
    let lastOrder = null;

    // Only calculate if logged in and history exists
    if (isAuthenticated && orders && orders.length > 0) {
        // Sort descending by date to get the newest one
        lastOrder = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        reorderBannerHTML = createReorderBanner(lastOrder);
    }

    // --- 2. Loading / Error / Empty States ---
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
        // --- 3. Logic: Categories & Filtering ---
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

        // Group by category
        const itemsByCategory = filteredItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});

        const sortedCategoryKeys = orderedCategories.filter(cat => itemsByCategory[cat]);

        // --- 4. Assemble Content ---
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
                ${reorderBannerHTML}
                <h2>Our Menu</h2>
                <div class="sub-tabs-container">${tabsHTML}</div>
            </div>
            ${menuContentHTML}
        `;

        mainContent.innerHTML = finalHTML;
        
        // --- 5. Attach Listeners ---
        attachMenuEventListeners();
        attachCategoryTabListeners();
        
        // Attach Reorder Listener (only if banner was rendered)
        const reorderBtn = document.getElementById('quick-reorder-btn');
        if (reorderBtn && lastOrder) {
            reorderBtn.addEventListener('click', () => handleQuickReorder(lastOrder));
        }

    } catch (e) {
        console.error("CRITICAL RENDER ERROR in renderMenuPage:", e);
        mainContent.innerHTML = `<div class="error-message">A critical error occurred while rendering the menu.</div>`;
    }
}