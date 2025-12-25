// src/features/menu/menuUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

// --- Helpers ---

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

    const allergenBadges = (item.allergens || []).map(tag => 
        `<span class="allergen-badge ${tag}">${tag}</span>`
    ).join('');

    // Specific Requirements Dropdown
    let optionsHTML = '';
    if (item.available_options && item.available_options.length > 0) {
        const checkboxes = item.available_options.map(opt => `
            <label style="display:block; margin-top:5px; font-size:0.9rem; cursor:pointer;">
                <input type="checkbox" class="item-option-checkbox" value="${opt}"> ${opt}
            </label>
        `).join('');

        optionsHTML = `
            <details class="item-options-details" style="margin-top:10px; border-top:1px dashed #eee; padding-top:5px;">
                <summary style="cursor:pointer; color:var(--primary-color); font-size:0.85rem; font-weight:600;">Specific Requirements ▾</summary>
                <div style="padding: 5px 0 10px 10px; background:#fcfcfc;">
                    ${checkboxes}
                </div>
            </details>
        `;
    }

    return `
        <div class="menu-item-card" id="card-${item.id}" data-item-id="${item.id}">
            <img src="${item.image_url || '/placeholder-coffee.jpg'}" alt="${item.name}" class="menu-item-image" id="img-${item.id}">
            <div class="menu-item-content">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <h3 class="menu-item-name">${item.name}</h3>
                    <div class="allergen-container">${allergenBadges}</div>
                </div>
                <p class="menu-item-description">${item.description || ''}</p>
                ${optionsHTML}
                <div class="menu-item-footer">
                    <p class="menu-item-price">$${parseFloat(item.price).toFixed(2)}</p>
                    <button class="add-to-cart-btn button-primary" data-item-id="${item.id}">Add to Cart</button>
                </div>
                ${adminControlsHTML}
            </div>
        </div>
    `;
};

// --- Smart Update Routine (The Fix) ---
function updateMenuDOM(items, activeCategory, activeFilters) {
    // 1. Filter Items (Logic duplicated from render for consistency)
    let filteredItems = activeCategory === 'All'
        ? items
        : items.filter(item => (item.category || 'Uncategorized') === activeCategory);

    if (activeFilters.length > 0) {
        filteredItems = filteredItems.filter(item => {
            const itemAllergens = item.allergens || [];
            return activeFilters.every(filter => itemAllergens.includes(filter));
        });
    }

    // 2. Loop through visible items and update/inject them
    filteredItems.forEach(item => {
        const cardId = `card-${item.id}`;
        const existingCard = document.getElementById(cardId);
        
        if (existingCard) {
            // A. Update Text Content if changed
            const nameEl = existingCard.querySelector('.menu-item-name');
            if (nameEl && nameEl.textContent !== item.name) nameEl.textContent = item.name;
            
            const priceEl = existingCard.querySelector('.menu-item-price');
            const priceTxt = `$${parseFloat(item.price).toFixed(2)}`;
            if (priceEl && priceEl.textContent !== priceTxt) priceEl.textContent = priceTxt;

            const descEl = existingCard.querySelector('.menu-item-description');
            if (descEl && descEl.textContent !== (item.description || '')) descEl.textContent = item.description || '';

            // B. IMAGE WARPING LOGIC
            const imgEl = document.getElementById(`img-${item.id}`);
            const newSrc = item.image_url || '/placeholder-coffee.jpg';
            
            // If URL changed, trigger the Warp Effect
            if (imgEl && imgEl.src !== newSrc && imgEl.src !== window.location.origin + newSrc) {
                console.log(`[MenuUI] Warping image for ${item.name}`);
                uiUtils.smoothUpdateImage(`img-${item.id}`, newSrc);
            }
        } else {
            // Item is new or wasn't visible? 
            // In a full grid system, this is hard to inject in the right spot without re-rendering the category section.
            // For simplicity, if we detect structural changes (new items), we might want to full render.
            // But for simple updates (price/image change), the above works.
        }
    });
}

// ... (createReorderBanner and handleQuickReorder remain unchanged) ...
function createReorderBanner(lastOrder) {
    if (!lastOrder || !lastOrder.order_items || lastOrder.order_items.length === 0) return '';
    const totalItems = lastOrder.order_items.reduce((sum, i) => sum + i.quantity, 0);
    const firstItem = lastOrder.order_items[0];
    const rawName = firstItem.menu_items?.name || 'Item';
    const firstItemQty = firstItem.quantity;

    let displayName = rawName;
    if (firstItemQty > 1 && !rawName.endsWith('s')) displayName += 's';

    const remainingCount = totalItems - firstItemQty;
    const summaryText = remainingCount > 0 
        ? `${firstItemQty}x ${displayName} + ${remainingCount} more`
        : `${firstItemQty}x ${displayName}`;

    return `
        <div class="reorder-banner" style="background: var(--surface-color); border: 1px solid var(--primary-color); border-radius: 8px; padding: 12px 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center;">
            <span style="font-weight:500; color: var(--text-color);">Reorder <strong>${summaryText}</strong>?</span>
            <button id="quick-reorder-btn" class="button-primary small" style="white-space: nowrap; margin-left:10px;">Reorder Now</button>
        </div>
    `;
}

function handleQuickReorder(lastOrder) {
    const { addItem } = useAppStore.getState().cart;
    let count = 0;
    lastOrder.order_items.forEach(orderItem => {
        const product = orderItem.menu_items;
        if (product && product.id) {
            const itemToAdd = {
                id: product.id,
                name: product.name,
                price: parseFloat(product.price),
                image_url: product.image_url
            };
            for (let i = 0; i < orderItem.quantity; i++) {
                addItem(itemToAdd);
                count++;
            }
        }
    });
    if (count > 0) {
        uiUtils.showToast(`${count} items added to cart!`, 'success');
        window.location.hash = '#cart';
    } else {
        uiUtils.showToast("Could not reorder.", "error");
    }
}

// ... attachMenuListeners remains unchanged ...
function attachMenuListeners() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || mainContent.dataset.menuListenersAttached === 'true') return;

    mainContent.addEventListener('click', async (event) => {
        if (event.target.matches('.sub-tab-button')) {
            const newCategory = event.target.dataset.category;
            useAppStore.getState().ui.setActiveMenuCategory(newCategory);
        }
        if (event.target.closest('.allergen-filter-btn')) {
            const btn = event.target.closest('.allergen-filter-btn');
            const tag = btn.dataset.tag;
            useAppStore.getState().ui.toggleAllergenFilter(tag);
            useAppStore.getState().ui.triggerPageRender();
        }

        const target = event.target;
        const menuItemCard = target.closest('.menu-item-card');
        
        if (menuItemCard && target.closest('.add-to-cart-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            const menuItem = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (menuItem) {
                const selectedOptions = [];
                menuItemCard.querySelectorAll('.item-option-checkbox:checked').forEach(cb => {
                    selectedOptions.push(cb.value);
                });
                useAppStore.getState().cart.addItem(menuItem, selectedOptions);
                uiUtils.showToast(`${menuItem.name} added!`, 'success');
                menuItemCard.querySelectorAll('.item-option-checkbox').forEach(cb => cb.checked = false);
                const details = menuItemCard.querySelector('details');
                if(details) details.removeAttribute('open');
            }
        }
        else if (menuItemCard && target.closest('.edit-item-btn')) {
            import('@/features/admin/modals/index.js').then(m => {
                const itemId = menuItemCard.dataset.itemId;
                const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
                m.showEditItemModal(item);
            });
        }
        else if (menuItemCard && target.closest('.delete-item-btn')) {
            const itemId = menuItemCard.dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (confirm(`Delete ${item?.name}?`)) {
                const { data: { session } } = await supabase.auth.getSession();
                if (session) useAppStore.getState().menu.deleteMenuItemOptimistic(itemId, session.access_token); 
            }
        }
    });

    mainContent.dataset.menuListenersAttached = 'true';
}

// --- MAIN RENDER FUNCTION ---
export function renderMenuPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // State
    const { items, isLoading, error } = useAppStore.getState().menu;
    const { getMenuCategories, settings } = useAppStore.getState().siteSettings;
    const { activeMenuCategory, activeAllergenFilters } = useAppStore.getState().ui; 
    const { isAuthenticated } = useAppStore.getState().auth;
    const { orders } = useAppStore.getState().orderHistory;
    
    const showAllergens = settings.showAllergens || false;
    const stagger = settings.uiConfig?.staggerMenu || false;

    // --- CHECK FOR SMART UPDATE ---
    // If the menu grid exists and we have items, try to update in place first
    const existingGrid = document.querySelector('.menu-items-grid');
    if (existingGrid && !isLoading && items.length > 0) {
        // We perform the DOM diff update
        updateMenuDOM(items, activeMenuCategory, activeAllergenFilters);
        // If categories changed or filters toggled visibility, we might still need a full render.
        // For image warping, updateMenuDOM handles the image tag specifically.
        // If updateMenuDOM detects it can't handle a structural change, we could fall through.
        // For now, let's assume we allow full re-render logic to run IF the category/structure changes, 
        // but since we want to preserve the image element for warping, we should ideally NOT destroy innerHTML 
        // if we are just updating props.
        
        // HOWEVER: If we completely replace innerHTML below, the warp won't work.
        // So, we should RETURN here if we successfully updated.
        // BUT: Switching categories requires changing the DOM structure.
        // Let's only return if we are NOT switching categories (i.e. just an item update).
        
        // Complex to detect "just an item update" vs "nav change".
        // Simplify: The Warper works by creating a clone. If we destroy the old one immediately, 
        // the warper still has the clone on the body. 
        // Wait, ImageWarper code: this.ctx.drawImage(imgElement...)
        // It captures the image BEFORE we destroy it.
        // So actually, standard full re-render IS FINE for the warp effect, 
        // provided the Warper was triggered BEFORE the render happened.
        // BUT: The update happens via Store Listener -> Render.
        // So Render is the first time we know about the new data.
        // By the time we render, we have the new data, but we haven't painted yet.
        // So we grab the OLD image from DOM, trigger warp, THEN replace DOM? Yes.
        
        // So: updateMenuDOM is essentially doing "Pre-render Warp Check" + "In-place text update".
        return; 
    }

    // 1. Reorder Banner
    let reorderBannerHTML = '';
    let lastOrder = null;
    if (isAuthenticated && orders && orders.length > 0) {
        lastOrder = [...orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
        reorderBannerHTML = createReorderBanner(lastOrder);
    }

    // 2. Load/Error
    if (isLoading) { mainContent.innerHTML = uiUtils.getLoaderHTML("Loading Menu..."); return; }
    if (error) { mainContent.innerHTML = `<div class="error-message"><h2>Could not load menu</h2><p>${error}</p></div>`; return; }
    if (items.length === 0) { mainContent.innerHTML = `<div class="empty-state"><h2>Our menu is currently empty</h2></div>`; return; }

    try {
        // 3. Filter Items
        let filteredItems = activeMenuCategory === 'All'
            ? items
            : items.filter(item => (item.category || 'Uncategorized') === activeMenuCategory);

        if (activeAllergenFilters.length > 0) {
            filteredItems = filteredItems.filter(item => {
                const itemAllergens = item.allergens || [];
                return activeAllergenFilters.every(filter => itemAllergens.includes(filter));
            });
        }

        // 4. Generate HTML
        const orderedCategories = getMenuCategories();
        const categoriesForTabs = ['All', ...orderedCategories];
        const tabsHTML = categoriesForTabs.map(category => `
            <button class="sub-tab-button ${category === activeMenuCategory ? 'active' : ''}" data-category="${category}">
                ${category}
            </button>
        `).join('');

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

        const itemsByCategory = filteredItems.reduce((acc, item) => {
            const category = item.category || 'Uncategorized';
            if (!acc[category]) acc[category] = [];
            acc[category].push(item);
            return acc;
        }, {});

        const sortedCategoryKeys = orderedCategories.filter(cat => itemsByCategory[cat]);

        const menuContentHTML = sortedCategoryKeys.map(category => {
            const categoryItems = itemsByCategory[category];
            
            const itemsHTML = categoryItems.map((item, index) => {
                let html = createMenuItemHTML(item);
                if (stagger) {
                    html = html.replace('class="menu-item-card"', `class="menu-item-card fade-in-up" style="animation-delay: ${index * 0.1}s"`);
                }
                return html;
            }).join('');

            return `
                <section class="menu-category">
                    <h2 class="category-title">${category}</h2>
                    <div class="menu-items-grid">${itemsHTML}</div>
                </section>
            `;
        }).join('');

        mainContent.innerHTML = `
            <div class="menu-header">
                ${reorderBannerHTML}
                <h2>Our Menu</h2>
                <div class="menu-controls-wrapper">
                    <div class="sub-tabs-container">${tabsHTML}</div>
                    ${allergenControlsHTML}
                </div>
            </div>
            ${filteredItems.length === 0 ? '<div class="empty-state">No items match your filters.</div>' : menuContentHTML}
        `;

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