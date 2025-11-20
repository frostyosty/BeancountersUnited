// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';

// --- LOCAL STATE FOR SORTING ---
let currentSort = { column: 'name', direction: 'asc' };

// --- CSS STYLES FOR MODALS ---
const MODAL_CSS = `
<style>
    /* Kept the same as previous version */
    .modal-form-container { font-family: inherit; color: #333; }
    .modal-form-container h3 { margin-top: 0; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 20px; }
    .form-row { display: flex; flex-direction: column; margin-bottom: 15px; text-align: left; }
    .form-row label { font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; color: #444; }
    .form-row input, .form-row select, .form-row textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; box-sizing: border-box; }
    .form-row textarea { min-height: 80px; resize: vertical; }
    .image-upload-wrapper { background: #f9f9f9; border: 2px dashed #ddd; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 20px; }
    .image-preview-container img { max-height: 150px; border-radius: 6px; display: block; margin: 0 auto 10px; }
    .visually-hidden { position: absolute !important; height: 1px; width: 1px; overflow: hidden; clip: rect(1px 1px 1px 1px); }
    .upload-btn-label { display: inline-block; padding: 8px 16px; background-color: #e9ecef; color: #333; border-radius: 4px; cursor: pointer; border: 1px solid #ced4da; }
    .form-actions-split { display: flex; justify-content: space-between; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px; }
</style>
`;

// --- 1. SUBTLE CATEGORY COLOR HELPER ---
function getCategoryColor(str) {
    if (!str) return '#ffffff';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash % 360);
    // HSL: Lower saturation (40%), Higher lightness (96%) = Very Subtle Pastel
    return `hsl(${h}, 40%, 96%)`;
}

// ... (Keep other functions: getMenuLayoutHTML, showMenuItemModal, etc.) ...

// --- 2. UPDATE: handleThemeSettingsSave to capture Font ---
async function handleThemeSettingsSave() {
    const { updateSiteSettings } = useAppStore.getState().siteSettings;
    const saveButton = document.getElementById('save-theme-settings');

    saveButton.textContent = 'Saving...';
    saveButton.disabled = true;

    const themeVariables = {};
    // 1. Capture CSS Variables (colors)
    document.querySelectorAll('[data-css-var]').forEach(input => {
        themeVariables[input.dataset.cssVar] = input.value;
    });

    // 2. Capture Selected Font
    const fontSelect = document.getElementById('font-selector');
    if (fontSelect) {
        const fontName = fontSelect.value;
        themeVariables['--font-family-main-name'] = fontName;
        // Apply immediately
        uiUtils.applySiteFont(fontName);
    }

    const { data: { session } } = await supabase.auth.getSession();

    try {
        await updateSiteSettings({ themeVariables }, session?.access_token);
        uiUtils.showToast('Theme saved successfully!', 'success');
    } catch (e) {
        uiUtils.showToast('Failed to save theme.', 'error');
    } finally {
        saveButton.textContent = 'Save Theme Settings';
        saveButton.disabled = false;
    }
}


function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();

    if (!categories || categories.length === 0) {
        return `
            <div id="category-manager">
                <p>No categories defined yet.</p>
                <div class="add-category-row">
                    <input type="text" id="new-category-name" placeholder="New Category Name">
                    <button id="add-category-btn" class="button-primary small">Add</button>
                </div>
                <ul id="category-list"></ul>
            </div>`;
    }

    const listItems = categories.map(cat => `
        <li class="category-list-item" data-category-name="${cat}">
            <div class="drag-handle-wrapper"><span class="drag-handle">☰</span></div>
            <span class="category-name">${cat}</span>
            <div class="item-actions">
                <button class="button-secondary small rename-category-btn">Rename</button>
                <button class="button-danger small delete-category-btn">Delete</button>
            </div>
        </li>
    `).join('');

    return `
        <div id="category-manager">
            <div class="add-category-row">
                <input type="text" id="new-category-name" placeholder="New Category Name">
                <button id="add-category-btn" class="button-primary small">Add</button>
            </div>
            <ul id="category-list">${listItems}</ul>
        </div>
    `;
}

function showMenuItemModal(item = null) {
    const isEditing = item !== null;
    const modalTitle = isEditing ? `Edit Item` : 'Add New Item';
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories() || ['Uncategorized'];

    const categoryOptions = categories.map(cat =>
        `<option value="${cat}" ${item?.category === cat ? 'selected' : ''}>${cat}</option>`
    ).join('');

    const modalContentHTML = `
        ${MODAL_CSS}
        <div class="modal-form-container">
            <h3>${modalTitle}</h3>
            <form id="menu-item-form">
                <input type="hidden" name="id" value="${isEditing ? item.id : ''}">
                <div class="form-row">
                    <label>Item Name</label>
                    <input type="text" name="name" value="${isEditing ? item.name : ''}" required placeholder="e.g. Avocado Toast">
                </div>
                <div class="form-row">
                    <label>Description</label>
                    <textarea name="description" placeholder="Ingredients...">${isEditing ? (item.description || '') : ''}</textarea>
                </div>
                <div class="form-row">
                    <label>Price ($)</label>
                    <input type="number" name="price" step="0.01" value="${isEditing ? item.price : ''}" required placeholder="0.00">
                </div>
                <div class="form-row">
                    <label>Category</label>
                    <select name="category">
                        <option value="" disabled ${!item ? 'selected' : ''}>Select Category...</option>
                        ${categoryOptions}
                    </select>
                </div>
                <div class="image-upload-wrapper">
                    <div class="image-preview-container">
                        <img id="image-preview" src="${item?.image_url || '/placeholder-coffee.jpg'}" alt="Preview" />
                    </div>
                    <input type="file" id="item-image-upload" name="imageFile" accept="image/png, image/jpeg, image/webp" class="visually-hidden">
                    <label for="item-image-upload" class="upload-btn-label">Choose New Image</label>
                    <div id="image-upload-filename" style="font-size:0.8rem; color:#666; margin-top:5px;">No file selected</div>
                    <input type="hidden" id="item-image-url" name="image_url" value="${isEditing ? (item.image_url || '') : ''}">
                    <div id="image-upload-progress" style="display: none; color: blue; font-weight: bold; margin-top: 8px;">Uploading...</div>
                </div>
                <div class="form-actions-split">
                    ${isEditing ? `<button type="button" id="delete-item-btn-modal" class="button-danger">Delete Item</button>` : '<div></div>'}
                    <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
                </div>
            </form>
        </div>
    `;
    uiUtils.showModal(modalContentHTML);

    document.getElementById('item-image-upload')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            document.getElementById('image-preview').src = URL.createObjectURL(file);
            document.getElementById('image-upload-filename').textContent = file.name;
        }
    });

    document.getElementById('menu-item-form')?.addEventListener('submit', handleMenuItemFormSubmit);
    if (isEditing) {
        document.getElementById('delete-item-btn-modal')?.addEventListener('click', () => handleDeleteMenuItem(item.id, item.name));
    }
}

async function handleMenuItemFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    const formData = new FormData(form);
    const itemData = Object.fromEntries(formData.entries());
    const imageFile = formData.get('imageFile');
    const isEditing = !!itemData.id;

    const { addMenuItemOptimistic, fetchMenu } = useAppStore.getState().menu;

    try {
        if (imageFile && imageFile.size > 0) {
            document.getElementById('image-upload-progress').style.display = 'block';
            const fileExt = imageFile.name.split('.').pop();
            const filePath = `public/${Date.now()}.${fileExt}`;
            const { error: uploadError } = await supabase.storage.from('menu-images').upload(filePath, imageFile);
            if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);
            const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(filePath);
            itemData.image_url = publicUrl;
        }
        delete itemData.imageFile;

        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        if (isEditing) {
            await api.updateMenuItem(itemData.id, itemData, token);
            uiUtils.showToast('Item updated!', 'success');
            uiUtils.closeModal();
            fetchMenu();
        } else {
            await addMenuItemOptimistic(itemData, token);
            uiUtils.showToast('Item added!', 'success');
            uiUtils.closeModal();
        }
    } catch (error) {
        uiUtils.showToast(`Error: ${error.message}`, 'error');
        submitButton.disabled = false;
    }
}

async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Delete "${itemName}"?`)) return;
    const { deleteMenuItemOptimistic } = useAppStore.getState().menu;
    const { data: { session } } = await supabase.auth.getSession();
    try {
        await deleteMenuItemOptimistic(itemId, session?.access_token);
        uiUtils.showToast('Item deleted.', 'info');
        if (document.querySelector('.modal-overlay')) uiUtils.closeModal();
    } catch (error) {
        uiUtils.showToast(`Error: ${error.message}`, 'error');
    }
}

function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list || list.dataset.sortableInitialized === 'true') return;
    new Sortable(list, { animation: 150, handle: '.drag-handle-wrapper', onEnd: handleCategoryReorder });
    list.dataset.sortableInitialized = 'true';
}

async function handleCategoryReorder() {
    const { updateSiteSettings } = useAppStore.getState().siteSettings;
    const listItems = document.querySelectorAll('#category-list .category-list-item');
    const newCategoryOrder = Array.from(listItems).map(li => li.dataset.categoryName);
    
    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
            await updateSiteSettings({ menuCategories: newCategoryOrder }, session.access_token);
            uiUtils.showToast('Category order updated!', 'success');
        }
    } catch (error) {
        console.error("Reorder failed:", error);
        uiUtils.showToast('Failed to save order.', 'error');
    }
}

function attachOwnerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer || dashboardContainer.dataset.listenersAttached === 'true') return;

    // --- 1. Form Submissions ---
    // CRITICAL FIX: Added 'async' here because we use 'await' inside
    dashboardContainer.addEventListener('submit', async (event) => {
        
        // Header Layout Settings
        if (event.target.matches('#header-settings-form')) {
            event.preventDefault();
            const formData = new FormData(event.target);
            const newSettings = {
                logoAlignment: formData.get('logoAlignment'),
                hamburgerPosition: formData.get('hamburgerPosition')
            };

            // Optimistic Update
            uiUtils.applyHeaderLayout(newSettings);

            // Save to DB
            const { data: { session } } = await supabase.auth.getSession();
            useAppStore.getState().siteSettings.updateSiteSettings({ headerSettings: newSettings }, session?.access_token);
            uiUtils.showToast('Header layout saved!', 'success');
        }

        // Business Details
        if (event.target.matches('#business-details-form')) {
            event.preventDefault();
            handleBusinessDetailsSave(event.target);
        }

        // Payment Settings
        if (event.target.matches('#payment-settings-form')) {
            event.preventDefault();
            const formData = new FormData(event.target);
            const config = {
                enableCash: formData.get('enableCash') === 'on',
                maxCashAmount: parseFloat(formData.get('maxCashAmount')),
                maxCashItems: parseInt(formData.get('maxCashItems'))
            };
            const { updateSiteSettings } = useAppStore.getState().siteSettings;
            const { data: { session } } = await supabase.auth.getSession();

            updateSiteSettings({ paymentConfig: config }, session?.access_token);
            uiUtils.showToast('Payment rules saved!', 'success');
        }
    });

    // --- 2. Click Handlers ---
    dashboardContainer.addEventListener('click', (event) => {
        const target = event.target;

        // -- Menu Item Actions --
        if (target.matches('#add-new-item-btn')) {
            showMenuItemModal(null);
        }
        else if (target.closest('.edit-item-btn-table')) {
            const row = target.closest('tr');
            const item = useAppStore.getState().menu.items.find(i => i.id === row.dataset.itemId);
            showMenuItemModal(item);
        }
        else if (target.closest('.delete-icon-btn')) {
            const row = target.closest('tr');
            const item = useAppStore.getState().menu.items.find(i => i.id === row.dataset.itemId);
            handleDeleteMenuItem(item.id, item.name);
        }

        // -- Table Sorting --
        else if (target.matches('th.sortable')) {
            const column = target.dataset.sortCol;
            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = 'asc';
            }
            renderOwnerDashboard();
        }

        // -- Save Theme Button --
        else if (target.matches('#save-theme-settings')) {
            handleThemeSettingsSave();
        }

        // -- Category Management --
        const categoryManager = target.closest('#category-manager');
        if (categoryManager) {
            const { getMenuCategories, updateSiteSettings } = useAppStore.getState().siteSettings;
            let categories = getMenuCategories();

            const runUpdate = async (newCats) => {
                const { data: { session } } = await supabase.auth.getSession();
                updateSiteSettings({ menuCategories: newCats }, session?.access_token);
            };

            // Add Category
            if (target.matches('#add-category-btn')) {
                const input = document.getElementById('new-category-name');
                const newName = input.value.trim();
                if (newName && !categories.includes(newName)) {
                    runUpdate([...categories, newName]);
                    input.value = '';
                    uiUtils.showToast('Category added!', 'success');
                }
            }

            const listItem = target.closest('.category-list-item');
            if (listItem) {
                const oldName = listItem.dataset.categoryName;

                // Rename
                if (target.matches('.rename-category-btn')) {
                    const newName = prompt(`Rename category "${oldName}":`, oldName);
                    if (newName && newName.trim() !== oldName) {
                        runUpdate(categories.map(c => c === oldName ? newName.trim() : c));
                    }
                }

                // Delete
                if (target.matches('.delete-category-btn')) {
                    if (categories.length <= 1) {
                        alert('You must have at least one category.');
                        return;
                    }
                    if (confirm(`Delete the "${oldName}" category?`)) {
                        runUpdate(categories.filter(c => c !== oldName));
                    }
                }
            }
        }
    });

    // --- 3. Font Selection Live Preview ---
    dashboardContainer.addEventListener('change', (event) => {
        // Preview Header Layout
        if (event.target.closest('#header-settings-form')) {
            const form = document.getElementById('header-settings-form');
            const formData = new FormData(form);
            const previewSettings = {
                logoAlignment: formData.get('logoAlignment'),
                hamburgerPosition: formData.get('hamburgerPosition')
            };
            uiUtils.applyHeaderLayout(previewSettings);
        }
        // Preview Font
        if (event.target.matches('#font-selector')) {
            const fontName = event.target.value;
            uiUtils.applySiteFont(fontName);
        }
    });

    // --- 4. Color Picker Live Preview ---
    dashboardContainer.addEventListener('input', (event) => {
        if (event.target.matches('[data-css-var]')) {
            uiUtils.updateCssVariable(event.target.dataset.cssVar, event.target.value);
        }
    });

    dashboardContainer.dataset.listenersAttached = 'true';
}

// --- MAIN RENDER FUNCTION ---
export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;

    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${error}</p></div>`;
        return;
    }

    const menuLayoutHTML = ownerPermissions.canEditCategories ? getMenuLayoutHTML() : '';

    // --- SORTING LOGIC ---
    const sortedItems = [...menuItems].sort((a, b) => {
        const col = currentSort.column;
        const valA = col === 'price' ? parseFloat(a[col]) : (a[col] || '').toLowerCase();
        const valB = col === 'price' ? parseFloat(b[col]) : (b[col] || '').toLowerCase();
        if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
        if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
        return 0;
    });

    const getSortClass = (col) => currentSort.column === col ? currentSort.direction : '';

    // --- RENDER ROWS WITH COLORS ---
    const menuItemsTableRows = sortedItems.map(item => {
        // NEW: Generate hue based on category name
        const categoryColor = getCategoryColor(item.category || 'Uncategorized');

        return `
        <tr data-item-id="${item.id}" style="background-color: ${categoryColor}; border-bottom:1px solid #fff;">
            <td style="font-weight:500; padding: 10px;">${item.name}</td>
            <td style="padding: 10px;">
                <span style="font-weight:600; opacity:0.7;">${item.category || 'None'}</span>
            </td>
            <td style="padding: 10px;">$${parseFloat(item.price).toFixed(2)}</td>
            <td style="padding: 10px;">
                <button class="button-secondary small edit-item-btn-table" style="background: rgba(255,255,255,0.6); border:1px solid rgba(0,0,0,0.1);">Edit</button>
                <button class="delete-icon-btn" title="Delete Item">×</button>
            </td>
        </tr>
    `}).join('');

    
    // Retrieve current settings
    const headerSettings = settings.headerSettings || { logoAlignment: 'center', hamburgerPosition: 'right' };

    // HTML for the Header Controls
    const headerControlsHTML = `
        <section class="dashboard-section">
            <h3>Header Layout</h3>
            <form id="header-settings-form">
                <div class="form-row">
                    <label>Logo Alignment</label>
                    <select name="logoAlignment">
                        <option value="center" ${headerSettings.logoAlignment === 'center' ? 'selected' : ''}>Center</option>
                        <option value="left" ${headerSettings.logoAlignment === 'left' ? 'selected' : ''}>Left</option>
                    </select>
                </div>
                <div class="form-row">
                    <label>Hamburger Menu Position</label>
                    <select name="hamburgerPosition">
                        <option value="right" ${headerSettings.hamburgerPosition === 'right' ? 'selected' : ''}>Right</option>
                        <option value="left" ${headerSettings.hamburgerPosition === 'left' ? 'selected' : ''}>Left</option>
                    </select>
                </div>
                <button type="submit" class="button-primary">Save Layout</button>
            </form>
        </section>
    `;


    // 1. Get current Payment Settings (default if missing)
    const paymentConfig = settings.paymentConfig || { enableCash: true, maxCashAmount: 100, maxCashItems: 10 };

    // 2. Create HTML for the Payment Settings Section
    const paymentSettingsHTML = `
        <section class="dashboard-section">
            <h3>Payment Settings</h3>
            <form id="payment-settings-form">
                <div class="form-group" style="margin-bottom: 15px;">
                    <label style="display:flex; align-items:center; font-weight:600; cursor:pointer;">
                        <input type="checkbox" name="enableCash" ${paymentConfig.enableCash ? 'checked' : ''} style="width:20px; height:20px; margin-right:10px;">
                        Enable "Pay on Pickup" (Cash/EFTPOS)
                    </label>
                </div>
                <div class="form-row">
                    <label>Max Order Value for Cash ($)</label>
                    <input type="number" name="maxCashAmount" value="${paymentConfig.maxCashAmount}" min="0" step="1">
                    <small style="color:#666;">Orders above this amount must use Stripe.</small>
                </div>
                <div class="form-row">
                    <label>Max Items for Cash</label>
                    <input type="number" name="maxCashItems" value="${paymentConfig.maxCashItems}" min="1" step="1">
                    <small style="color:#666;">Large orders (catering?) might require prepayment.</small>
                </div>
                <button type="submit" class="button-primary">Save Payment Rules</button>
            </form>
        </section>
    `;

    // 3. Inject into main HTML (Add ${paymentSettingsHTML} where you want it, e.g., before Theme Customization)
    mainContent.innerHTML = `
        <div class="dashboard-container">
            
            <section class="dashboard-section">
             <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3>Menu Items</h3>
                <button id="add-new-item-btn" class="button-primary">+ Add New Item</button>
             </div>
             
                <div class="table-wrapper">
                    <table style="border-collapse: collapse; width: 100%;">
                        <thead style="background: white; border-bottom: 2px solid #ddd;">
                            <tr>
                                <th class="sortable ${getSortClass('name')}" data-sort-col="name" style="padding:10px;">Name</th>
                                <th class="sortable ${getSortClass('category')}" data-sort-col="category" style="padding:10px;">Category</th>
                                <th class="sortable ${getSortClass('price')}" data-sort-col="price" style="padding:10px;">Price</th>
                                <th style="padding:10px;">Actions</th>
                            </tr>
                        </thead>
                        <tbody>${menuItemsTableRows}</tbody>
                    </table>
                </div>
            </section>

            ${ownerPermissions.canEditCategories ? `
            <section class="dashboard-section">
                <h3>Menu Categories</h3>
                <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                    Drag and drop to reorder categories.
                </p>
                ${menuLayoutHTML}
            </section>
            ` : ''}
            ${paymentSettingsHTML}
            ${headerControlsHTML}
            ${ownerPermissions.canEditTheme ? `
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                    Customize the colors and branding of your website.
                </p>
                <div class="theme-controls-wrapper">
                     ${uiUtils.getThemeControlsHTML(settings.themeVariables || {})}
                </div>
            </section>
            ` : ''}
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) initializeSortable();
}