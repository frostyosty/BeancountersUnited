// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';

// --- CSS STYLES FOR MODALS ---
// We inject this string into the modal content to style the form nicely.
const MODAL_CSS = `
<style>
    .modal-form-container {
        font-family: inherit;
        color: #333;
    }
    .modal-form-container h3 {
        margin-top: 0;
        border-bottom: 2px solid #eee;
        padding-bottom: 10px;
        margin-bottom: 20px;
    }
    .form-row {
        display: flex;
        flex-direction: column;
        margin-bottom: 15px;
        text-align: left;
    }
    .form-row label {
        font-weight: 600;
        font-size: 0.9rem;
        margin-bottom: 6px;
        color: #444;
    }
    .form-row input[type="text"],
    .form-row input[type="number"],
    .form-row select,
    .form-row textarea {
        width: 100%;
        padding: 10px;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 1rem;
        box-sizing: border-box;
        transition: border-color 0.2s;
    }
    .form-row input:focus,
    .form-row select:focus,
    .form-row textarea:focus {
        border-color: var(--primary-color, #007bff);
        outline: none;
    }
    .form-row textarea {
        min-height: 80px;
        resize: vertical;
    }
    .image-upload-wrapper {
        background: #f9f9f9;
        border: 2px dashed #ddd;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        margin-bottom: 20px;
    }
    .image-preview-container img {
        max-height: 150px;
        border-radius: 6px;
        box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        margin-bottom: 10px;
        display: block;
        margin-left: auto;
        margin-right: auto;
    }
    .file-info {
        font-size: 0.85rem;
        color: #666;
        margin-top: 5px;
    }
    .form-actions-split {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 25px;
        border-top: 1px solid #eee;
        padding-top: 15px;
    }
    /* Helper to hide default file input */
    .visually-hidden {
        position: absolute !important;
        height: 1px; 
        width: 1px;
        overflow: hidden;
        clip: rect(1px 1px 1px 1px); /* IE6, IE7 */
        clip: rect(1px, 1px, 1px, 1px);
    }
    .upload-btn-label {
        display: inline-block;
        padding: 8px 16px;
        background-color: #e9ecef;
        color: #333;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
        border: 1px solid #ced4da;
    }
    .upload-btn-label:hover {
        background-color: #dde0e3;
    }
</style>
`;

// --- HELPER FUNCTIONS ---

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
    
    // Get current categories dynamically so dropdown is always fresh
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
                    <textarea name="description" placeholder="Ingredients, allergens, or details...">${isEditing ? (item.description || '') : ''}</textarea>
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
                    <label style="display:block; margin-bottom:10px; font-weight:600; color:#444;">Item Image</label>
                    <div class="image-preview-container">
                        <img id="image-preview" src="${item?.image_url || '/placeholder-coffee.jpg'}" alt="Preview" />
                    </div>
                    
                    <input type="file" id="item-image-upload" name="imageFile" accept="image/png, image/jpeg, image/webp" class="visually-hidden">
                    <label for="item-image-upload" class="upload-btn-label">Choose New Image</label>
                    
                    <div id="image-upload-filename" class="file-info">No file selected</div>
                    <input type="hidden" id="item-image-url" name="image_url" value="${isEditing ? (item.image_url || '') : ''}">
                    <div id="image-upload-progress" style="display: none; color: var(--primary-color); font-weight: bold; margin-top: 8px;">Uploading...</div>
                </div>

                <div class="form-actions-split">
                    ${isEditing ? `<button type="button" id="delete-item-btn-modal" class="button-danger">Delete Item</button>` : '<div></div>'}
                    <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
                </div>
            </form>
        </div>
    `;
    uiUtils.showModal(modalContentHTML);

    // Handle File Selection UI
    document.getElementById('item-image-upload')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            document.getElementById('image-preview').src = URL.createObjectURL(file);
            document.getElementById('image-upload-filename').textContent = file.name;
        }
    });

    // Attach Submit Handler
    document.getElementById('menu-item-form')?.addEventListener('submit', handleMenuItemFormSubmit);
    
    // Attach Delete Handler (if editing)
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

    // Get Actions
    const { addMenuItemOptimistic, fetchMenu } = useAppStore.getState().menu;

    try {
        // 1. Handle Image Upload (if a file was selected)
        if (imageFile && imageFile.size > 0) {
            document.getElementById('image-upload-progress').style.display = 'block';
            
            const fileExt = imageFile.name.split('.').pop();
            const filePath = `public/${Date.now()}.${fileExt}`; // Unique name

            const { error: uploadError } = await supabase.storage.from('menu-images').upload(filePath, imageFile);
            if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

            const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(filePath);
            itemData.image_url = publicUrl;
        }

        // Remove the file object from the data we send to the API
        delete itemData.imageFile;

        // 2. Get Token
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;

        // 3. Execute Action
        if (isEditing) {
            // Standard update for edits
            await api.updateMenuItem(itemData.id, itemData, token);
            uiUtils.showToast('Item updated successfully!', 'success');
            uiUtils.closeModal();
            fetchMenu(); // Sync with DB
        } else {
            // Optimistic update for adding
            await addMenuItemOptimistic(itemData, token);
            uiUtils.showToast('Item added to menu!', 'success');
            uiUtils.closeModal();
        }
        
    } catch (error) {
        console.error(error);
        uiUtils.showToast(`Error: ${error.message}`, 'error');
        submitButton.disabled = false;
        submitButton.textContent = isEditing ? 'Save Changes' : 'Create Item';
    }
}

async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"?`)) return;
    
    const { deleteMenuItemOptimistic } = useAppStore.getState().menu;
    const { data: { session } } = await supabase.auth.getSession();
    
    try {
        // Optimistic Delete
        await deleteMenuItemOptimistic(itemId, session?.access_token);
        uiUtils.showToast('Item deleted.', 'info');
        uiUtils.closeModal();
    } catch (error) {
        uiUtils.showToast(`Error: ${error.message}`, 'error');
    }
}

function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list) return;
    
    // Prevent re-initializing if already done
    if (list.dataset.sortableInitialized === 'true') return;

    new Sortable(list, {
        animation: 150,
        handle: '.drag-handle-wrapper', // updated handle selector
        onEnd: handleCategoryReorder,
    });
    list.dataset.sortableInitialized = 'true';
}

function handleCategoryReorder() {
    const { updateSiteSettings } = useAppStore.getState().siteSettings;
    const listItems = document.querySelectorAll('#category-list .category-list-item');
    const newCategoryOrder = Array.from(listItems).map(li => li.dataset.categoryName);
    
    supabase.auth.getSession().then(({ data: { session } }) => {
        if(session) updateSiteSettings({ menuCategories: newCategoryOrder }, session.access_token);
    });
    
    uiUtils.showToast('Category order updated!', 'success');
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
        
        // Add / Edit Item
        if (target.matches('#add-new-item-btn') || target.closest('.edit-item-btn-table')) {
            const row = target.closest('tr');
            const itemId = row?.dataset.itemId;
            const item = itemId ? useAppStore.getState().menu.items.find(i => i.id === itemId) : null;
            showMenuItemModal(item);
        }
        
        // Save Theme
        if (target.matches('#save-theme-settings')) {
            handleThemeSettingsSave();
        }
        
        // Category Management
        const categoryManager = target.closest('#category-manager');
        if (categoryManager) {
            const { getMenuCategories, updateSiteSettings } = useAppStore.getState().siteSettings;
            let categories = getMenuCategories();
            
            // Helper to run update with token
            const runUpdate = async (newCats) => {
                const { data: { session } } = await supabase.auth.getSession();
                // Updating site settings will update the slice state optimistically
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
                
                // Rename Category
                if (target.matches('.rename-category-btn')) {
                    const newName = prompt(`Rename category "${oldName}":`, oldName);
                    if (newName && newName.trim() !== oldName) {
                        runUpdate(categories.map(c => c === oldName ? newName.trim() : c));
                    }
                }
                
                // Delete Category
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

    // Safely fetch data (loops handled in slice)
    useAppStore.getState().menu.fetchMenu();
    useAppStore.getState().siteSettings.fetchSiteSettings();

    const { items: menuItems, isLoading: isLoadingMenu } = useAppStore.getState().menu;
    const { settings, isLoading: isLoadingSettings, error } = useAppStore.getState().siteSettings;
    
    // Default permissions if settings not loaded yet
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

    const menuLayoutHTML = ownerPermissions.canEditCategories
        ? getMenuLayoutHTML()
        : '';

    const menuItemsTableRows = menuItems.map(item => `
        <tr data-item-id="${item.id}">
            <td style="font-weight:500;">${item.name}</td>
            <td><span class="badge" style="background:#eee; color:#333;">${item.category || 'None'}</span></td>
            <td>$${parseFloat(item.price).toFixed(2)}</td>
            <td><button class="button-secondary small edit-item-btn-table">Edit</button></td>
        </tr>
    `).join('');

    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>Owner Dashboard</h2>
            
            <section class="dashboard-section">
             <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3>Menu Items</h3>
                <button id="add-new-item-btn" class="button-primary">+ Add New Item</button>
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
                <h3>Menu Categories</h3>
                <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                    Drag and drop to reorder categories. These determine the tabs on your menu page.
                </p>
                ${menuLayoutHTML}
            </section>
            ` : ''}
            
            ${ownerPermissions.canEditTheme ? `
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                <p style="font-size:0.9rem; color:#666; margin-bottom:15px;">
                    Customize the colors and branding of your website.
                </p>
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