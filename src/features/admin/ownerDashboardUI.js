import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';

// --- HELPER FUNCTIONS ---

function getMenuLayoutHTML() {
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    
    const listItems = categories.map(cat => `
        <li class="category-list-item" data-category-name="${cat}">
            <span class="drag-handle">☰</span>
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
    const modalTitle = isEditing ? `Edit "${item.name}"` : 'Add New Menu Item';
    
    // FIX: Corrected typo 'useAppAppStore' -> 'useAppStore'
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    
    const categories = getMenuCategories();
    const categoryOptions = categories.map(cat => `<option value="${cat}" ${item?.category === cat ? 'selected' : ''}>${cat}</option>`).join('');

    const modalContentHTML = `
        <h3>${modalTitle}</h3>
        <form id="menu-item-form">
            <input type="hidden" name="id" value="${isEditing ? item.id : ''}">
            <div class="form-group"><label>Name</label><input type="text" name="name" value="${isEditing ? item.name : ''}" required></div>
            <div class="form-group"><label>Description</label><textarea name="description">${isEditing ? (item.description || '') : ''}</textarea></div>
            <div class="form-group"><label>Price</label><input type="number" name="price" step="0.01" value="${isEditing ? item.price : ''}" required></div>
            <div class="form-group"><label>Category</label><select name="category">${categoryOptions}</select></div>
            
            <div class="form-group image-upload-group">
                <label>Item Image</label>
                <img id="image-preview" src="${item?.image_url || '/placeholder-coffee.jpg'}" alt="Preview" />
                <input type="file" id="item-image-upload" name="imageFile" accept="image/png, image/jpeg, image/webp" class="visually-hidden">
                <label for="item-image-upload" class="button-secondary">Choose File</label>
                <span id="image-upload-filename">No new file selected.</span>
                <input type="hidden" id="item-image-url" name="image_url" value="${isEditing ? (item.image_url || '') : ''}">
                <div id="image-upload-progress" style="display: none;">Uploading...</div>
            </div>

            <div class="form-actions-split">
                ${isEditing ? `<button type="button" id="delete-item-btn-modal" class="button-danger">Delete Item</button>` : '<div></div>'}
                <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
            </div>
        </form>
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

    const itemData = Object.fromEntries(new FormData(form).entries());
    const imageFile = itemData.imageFile;
    const isEditing = !!itemData.id;
    const { fetchMenu } = useAppStore.getState().menu;

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

        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        if (isEditing) {
            await api.updateMenuItem(itemData.id, itemData, token);
            uiUtils.showToast('Item updated!', 'success');
        } else {
            await api.addMenuItem(itemData, token);
            uiUtils.showToast('Item added!', 'success');
        }
        uiUtils.closeModal();
        await fetchMenu();
    } catch (error) {
        alert(`Error: ${error.message}`);
        submitButton.disabled = false;
    }
}

async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"?`)) return;
    const { fetchMenu } = useAppStore.getState().menu;
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;

    try {
        await api.deleteMenuItem(itemId, token);
        uiUtils.showToast('Item deleted.', 'info');
        uiUtils.closeModal();
        await fetchMenu();
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list) return;
    new Sortable(list, {
        animation: 150,
        handle: '.drag-handle',
        onEnd: handleCategoryReorder,
    });
}

function handleCategoryReorder() {
    const { updateSiteSettings } = useAppStore.getState().siteSettings;
    const listItems = document.querySelectorAll('#category-list .category-list-item');
    const newCategoryOrder = Array.from(listItems).map(li => li.dataset.categoryName);
    
    // Fetch token for update
    supabase.auth.getSession().then(({ data: { session } }) => {
        if(session) updateSiteSettings({ menuCategories: newCategoryOrder }, session.access_token);
    });
    
    uiUtils.showToast('Category order saved!', 'success');
}

async function handleThemeSettingsSave() {
    const { updateSiteSettings } = useAppStore.getState().siteSettings;
    const saveButton = document.getElementById('save-theme-settings');
    saveButton.textContent = 'Saving...';
    saveButton.disabled = true;
    
    const themeVariables = {};
    document.querySelectorAll('[data-css-var]').forEach(input => {
        themeVariables[input.dataset.cssVar] = input.value;
    });

    const { data: { session } } = await supabase.auth.getSession();
    
    await updateSiteSettings({ themeVariables }, session?.access_token);
    uiUtils.showToast('Theme saved successfully!', 'success');
    saveButton.textContent = 'Save Theme Settings';
    saveButton.disabled = false;
}

async function handleBusinessDetailsSave(form) {
    const saveButton = form.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    const formData = new FormData(form);
    const detailsToUpdate = Object.fromEntries(formData.entries());

    try {
        const { data: { session } } = await supabase.auth.getSession();
        await api.updateSiteSettings(detailsToUpdate, session?.access_token);
        uiUtils.showToast('Business details saved!', 'success');
    } catch (error) {
        console.error(error);
        uiUtils.showToast('Failed to save details.', 'error');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Details';
    }
}

function attachOwnerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer || dashboardContainer.dataset.listenersAttached === 'true') return;

    dashboardContainer.addEventListener('submit', (event) => {
        if (event.target.matches('#business-details-form')) {
            event.preventDefault();
            handleBusinessDetailsSave(event.target);
        }
    });
    
    dashboardContainer.addEventListener('click', (event) => {
        const target = event.target;
        if (target.matches('#add-new-item-btn') || target.closest('.edit-item-btn-table')) {
            const row = target.closest('tr');
            const itemId = row?.dataset.itemId;
            const item = itemId ? useAppStore.getState().menu.items.find(i => i.id === itemId) : null;
            showMenuItemModal(item);
        }
        if (target.matches('#save-theme-settings')) {
            handleThemeSettingsSave();
        }
        
        const categoryManager = target.closest('#category-manager');
        if (categoryManager) {
            const { getMenuCategories } = useAppStore.getState().siteSettings;
            let categories = getMenuCategories();
            
            // Helper to run update
            const runUpdate = async (newCats) => {
                const { data: { session } } = await supabase.auth.getSession();
                api.updateSiteSettings({ menuCategories: newCats }, session?.access_token);
                // Manually trigger local state update or refetch? 
                // For simplicity, triggering a refetch usually safest:
                useAppStore.getState().siteSettings.fetchSiteSettings(); // Force refresh
            };

            if (target.matches('#add-category-btn')) {
                const input = document.getElementById('new-category-name');
                const newName = input.value.trim();
                if (newName && !categories.includes(newName)) {
                    runUpdate([...categories, newName]);
                    input.value = '';
                }
            }
            const listItem = target.closest('.category-list-item');
            if (listItem) {
                const oldName = listItem.dataset.categoryName;
                if (target.matches('.rename-category-btn')) {
                    const newName = prompt(`Rename category "${oldName}":`, oldName);
                    if (newName && newName.trim() !== oldName) {
                        runUpdate(categories.map(c => c === oldName ? newName.trim() : c));
                    }
                }
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

    dashboardContainer.addEventListener('input', (event) => {
        if (event.target.matches('[data-css-var]')) {
            uiUtils.updateCssVariable(event.target.dataset.cssVar, event.target.value);
        }
    });
    dashboardContainer.dataset.listenersAttached = 'true';
}

// --- MAIN RENDER FUNCTION ---
export function renderOwnerDashboard() {
    console.log("%c[OwnerDashboardUI] renderOwnerDashboard() CALLED.", "color: orange;");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    
    // FIX: Define ownerPermissions before using it
    const ownerPermissions = settings.ownerPermissions || { canEditTheme: true, canEditCategories: true };

    if (isLoadingMenu || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error loading settings</h2><p>${error}</p></div>`;
        return;
    }

    const themeControlsHTML = ownerPermissions.canEditTheme
        ? uiUtils.getThemeControlsHTML(settings.themeVariables || {})
        : '';

    // FIX: getMenuLayoutHTML is now defined
    const menuLayoutHTML = ownerPermissions.canEditCategories
        ? getMenuLayoutHTML()
        : '';

    const menuItemsTableRows = menuItems.map(item => `
        <tr data-item-id="${item.id}">
            <td>${item.name}</td>
            <td>${item.category || 'N/A'}</td>
            <td>$${parseFloat(item.price).toFixed(2)}</td>
            <td><button class="button-secondary small edit-item-btn-table">Edit</button></td>
        </tr>
    `).join('');

    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>Owner Dashboard</h2>
            
            <section class="dashboard-section">
             <h3>Menu Management</h3>
                <div class="table-actions">
                    <button id="add-new-item-btn" class="button-primary">Add New Item</button>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Actions</th></tr></thead>
                        <tbody>${menuItemsTableRows}</tbody>
                    </table>
                </div>
            </section>

            ${ownerPermissions.canEditCategories ? `
            <section class="dashboard-section">
                <h3>Menu Layout & Categories</h3>
                <p>Add, rename, delete, and reorder your menu categories. Drag and drop to reorder.</p>
                ${menuLayoutHTML}
            </section>
            ` : ''}
            
            ${ownerPermissions.canEditTheme ? `
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                <p>Change the look and feel of your website.</p>
                <div class="theme-controls-wrapper">${themeControlsHTML}</div>
            </section>
            ` : ''}
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) {
        initializeSortable();
    }
}