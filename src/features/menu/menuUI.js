// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

/**
 * Generates the HTML for a single menu item card.
 */
const createMenuItemHTML = (item) => {
    const { getUserRole } = useAppStore.getState().auth;
    const userRole = getUserRole();
    
    // Admin Controls
    const ownerControls = `
        <div class="item-admin-controls">
            <button class="button-secondary edit-item-btn" data-item-id="${item.id}">Edit</button>
        </div>
    `;
    const godUserControls = `
        <button class="button-danger delete-item-btn" data-item-id="${item.id}">Delete</button>
    `;
    
    let adminControlsHTML = '';
    if (userRole === 'owner' || userRole === 'god') { adminControlsHTML = ownerControls; }
    if (userRole === 'god') { adminControlsHTML = adminControlsHTML.replace('</div>', ` ${godUserControls}</div>`); }

    // NEW: Allergen Badges on Card
    const allergenBadges = (item.allergens || []).map(tag => 
        `<span class="allergen-badge ${tag}">${tag}</span>`
    ).join('');

    return `
        <div class="menu-item-card" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" class="menu-item-image">
            <div class="menu-item-content">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <h3 class="menu-item-name">${item.name}</h3>
                    <div class="allergen-container">${allergenBadges}</div>
                </div>
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

// ... (createReorderBanner and handleQuickReorder remain unchanged) ...
function createReorderBanner(lastOrder) {
    if (!lastOrder || !lastOrder.order_items || lastOrder.order_items.length === 0) return '';
    const totalItems = lastOrder.order_items.reduce((sum, i) => sum + i.quantity, 0);
    const firstItem = lastOrder.order_items[0];
    const firstItemName = firstItem.menu_items?.name || 'Item';
    const firstItemQty = firstItem.quantity;
    const remainingCount = totalItems - firstItemQty;
    const summaryText = remainingCount > 0 
        ? `${firstItemQty}x ${firstItemName} + ${remainingCount} more`
        : `${firstItemQty}x ${firstItemName}`;

    return `
        <div class="reorder-banner" style="background: var(--surface-color); border: 1px solid var(--primary-color); border-radius: 8px; padding: 12px 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight:500; color: var(--text-color);">Reorder <strong>${summaryText}</strong>?</span>
            <button id="quick-reorder-btn" class="button-primary small" style="white-space: nowrap; margin-left:10px;">Reorder Now</button>
        </div>
    `;
}

function handleQuickReorder(order) {
    const { addItem } = useAppStore.getState().cart;
    let count = 0;
    order.order_items.forEach(item => {
        if (item.menu_items) {
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
        uiUtils.showToast("Could not reorder items.", "error");
    }
}

// --- LISTENERS ---
function attachMenuListeners() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.dataset.menuListenersAttached === 'true') return;

    // 1. Category Tabs
    mainContent.addEventListener('click', async (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            useAppStore.getState().ui.setActiveMenuCategory(newCategory);
            // Trigger render is handled by subscription in main.js
        }

        // 2. Allergen Toggles (NEW)
        if (event.target.closest('.allergen-filter-btn')) {
            const btn = event.target.closest('.allergen-filter-btn');
            const tag = btn.dataset.tag;
            useAppStore.getState().ui.toggleAllergenFilter(tag);
            useAppStore.getState().ui.triggerPageRender();
        }

        // 3. Add to Cart / Edit / Delete
        const target = event.target;
        const menuItemCard = target.closest('.menu-item-card');
        
        if (menuItemCard && target.closest('.add-to-cart-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                useAppStore.getState().cart.addItem(menuItem);
                uiUtils.showToast(`${menuItem.name} added to cart!`, 'success');
            }
        }
        else if (menuItemCard && target.closest('.edit-item-btn')) {
            alert(`Use the Owner Dashboard to edit this item.`);
        }
        else if (menuItemCard && target.closest('.delete-item-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            if (confirm(`Delete this item?`)) {
                const { data: { session } } = await supabase.auth.getSession();
                if (session) {
                    useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token); 
                }
            }
        }
    });

    mainContent.dataset.menuListenersAttached = 'true';
}


/**
 * Renders the entire menu page.
 */
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // --- State ---
    const { items, isLoading, error } = useAppStore.getState().menu;
    const { getMenuCategories, settings } = useAppStore.getState().siteSettings; // Fix: Get settings here
    const { activeMenuCategory, activeAllergenFilters } = useAppStore.getState().ui; 
    const { isAuthenticated } = useAppStore.getState().auth;
    const { orders } = useAppStore.getState().orderHistory;
    
    const showAllergens = settings.showAllergens || false; // Fix: Check property on settings object

    // --- 1. Reorder Banner Logic ---
    let reorderBannerHTML = '';
    let lastOrder = null;
    if (isAuthenticated && orders && orders.length > 0) {
        lastOrder = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        reorderBannerHTML = createReorderBanner(lastOrder);
    }

    // --- 2. Load States ---
    if (isLoading) { mainContent.innerHTML = `<div class="loading-spinner">Loading menu...</div>`; return; }
    if (error) { mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${error}</p></div>`; return; }
    if (items.length === 0) { mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`; return; }

    try {
        // --- 3. Filter Items (Category + Allergens) ---
        
        // A. Category Filter
        let filteredItems = activeMenuCategory === 'All'
            ? items
            : items.filter(item => (item.category || 'Uncategorized') === activeMenuCategory);

        // B. Allergen Filter (NEW)
        if (activeAllergenFilters.length > 0) {
            filteredItems = filteredItems.filter(item => {
                const itemAllergens = item.allergens || [];
                return activeAllergenFilters.every(filter => itemAllergens.includes(filter));
            });
        }

        // --- 4. Render HTML ---
        
        // Category Tabs
        const orderedCategories = getMenuCategories();
        const categoriesForTabs = ['All', ...orderedCategories];
        const tabsHTML = categoriesForTabs.map(category => `
            <button class="sub-tab-button ${category === activeMenuCategory ? 'active' : ''}" data-category="${category}">
                ${category}
            </button>
        `).join('');

        // Allergen Toggles HTML
        let allergenControlsHTML = '';
        if (showAllergens) {
            const allergenTags = ['GF', 'V', 'VG', 'DF'];
            const toggles = allergenTags.map(tag => {
                const isActive = activeAllergenFilters.includes(tag);
                return `<button class="allergen-filter-btn ${isActive ? 'active' : ''}" data-tag="${tag}">${isActive ? '✅' : '⬜'} ${tag}</button>`;
            }).join('');
            
            allergenControlsHTML = `
                <div class="allergen-filters-container" style="margin-top:15px; display:flex; gap:10px; align-items:center;">
                    <span style="font-size:0.9rem; font-weight:bold; color:var(--secondary-color);">Filters:</span>
                    ${toggles}
                </div>`;
        }

        // Group Items
        const itemsByCategory = filteredItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});

        const sortedCategoryKeys = orderedCategories.filter(cat => itemsByCategory[cat]);

        // Build Grid
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

        // Final Assembly
        mainContent.innerHTML = `
            <div class="menu-header">
                ${reorderBannerHTML}
                <h2>Our Menu</h2>
                
                <div class="menu-controls-wrapper">
                    <!-- Categories -->
                    <div class="sub-tabs-container">${tabsHTML}</div>
                    
                    <!-- Dietary Filters (Conditional) -->
                    ${allergenControlsHTML}
                </div>
            </div>
            ${filteredItems.length === 0 ? '<div class="empty-state">No items match your filters.</div>' : menuContentHTML}
        `;

        // --- 5. Attach Listeners ---
        attachMenuListeners();
        
        const btn = document.getElementById('quick-reorder-btn');
        if (btn && lastOrder) {
            btn.onclick = () => handleQuickReorder(lastOrder);
        }

    } catch (e) {
        console.error("Menu Render Error:", e);
        mainContent.innerHTML = `<div class="error-message">Menu Error. Check console.</div>`;
    }
}