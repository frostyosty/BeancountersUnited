// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import Sortable from 'sortablejs';
import { supabase } from '@/supabaseClient.js';

// --- HELPER FUNCTIONS FOR THIS MODULE ---

/**
 * Shows a modal to add or edit a menu item, now with a rich image uploader.
 */
function showMenuItemModal(item = null) {
    const isEditing = item !== null;
    const modalTitle = isEditing ? `Edit "${item.name}"` : 'Add New Menu Item';
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();
    const categoryOptions = categories.map(cat =>
        `<option value="${cat}" ${item?.category === cat ? 'selected' : ''}>${cat}</option>`
    ).join('');

    const modalContentHTML = `
        <h3>${modalTitle}</h3>
        <form id="menu-item-form">
            <input type="hidden" name="id" value="${isEditing ? item.id : ''}">
            <div class="form-group">
                <label for="item-name">Name</label>
                <input type="text" id="item-name" name="name" value="${isEditing ? item.name : ''}" required>
            </div>
            <div class="form-group"><label for="item-description">Description</label><textarea id="item-description" name="description">${isEditing ? (item.description || '') : ''}</textarea></div>
            <div class="form-group"><label for="item-price">Price</label><input type="number" id="item-price" name="price" step="0.01" value="${isEditing ? item.price : ''}" required></div>
            <div class="form-group"><label for="item-category">Category</label><select id="item-category" name="category">${categoryOptions}</select></div>
             <!-- === NEW IMAGE UPLOAD SECTION === -->
            <div class="form-group image-upload-group">
                <label>Item Image</label>
                <img id="image-preview" src="${item?.image_url || '/placeholder-coffee.jpg'}" alt="Image preview" />
                <input type="file" id="item-image-upload" name="imageFile" accept="image/png, image/jpeg, image/webp" class="visually-hidden">
                <label for="item-image-upload" class="button-secondary">Choose File</label>
                <span id="image-upload-filename">No new file selected.</span>
                <input type="hidden" id="item-image-url" name="image_url" value="${isEditing ? (item.image_url || '') : ''}">
                <div id="image-upload-progress" class="progress-bar" style="display: none;"><div class="progress-bar-inner"></div></div>
            </div>
            <!-- === END NEW SECTION === -->

            <div class="form-actions-split">
                ${isEditing ? `<button type="button" id="delete-item-btn-modal" class="button-danger">Delete Item</button>` : '<div></div>'}
                <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
            </div>
        </form>
    `;
    uiUtils.showModal(modalContentHTML);

    // Attach listener to the new file input for live preview
    const imageUploadInput = document.getElementById('item-image-upload');
    imageUploadInput.addEventListener('change', () => {
        const file = imageUploadInput.files[0];
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



/**
 * Handles form submission, now with client-side image upload logic.
 */
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
        // --- NEW UPLOAD LOGIC ---
        if (imageFile && imageFile.size > 0) {
            const progressIndicator = document.getElementById('image-upload-progress');
            progressIndicator.style.display = 'block';

            const fileExt = imageFile.name.split('.').pop();
            const fileName = `${Date.now()}.${fileExt}`;
            const filePath = `public/${fileName}`;

            // Upload directly to Supabase Storage from the client
            const { error: uploadError } = await supabase.storage
                .from('menu-images')
                .upload(filePath, imageFile, {
                    cacheControl: '3600',
                    upsert: false
                });

            if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

            // Get the public URL of the uploaded file
            const { data: { publicUrl } } = supabase.storage
                .from('menu-images')
                .getPublicUrl(filePath);

            itemData.image_url = publicUrl; // Set the URL to be saved in the database
        }
        // --- END UPLOAD LOGIC ---

        if (isEditing) {
            await api.updateMenuItem(itemData.id, itemData);
            uiUtils.showToast('Item updated successfully!', 'success');
        } else {
            await api.addMenuItem(itemData);
            uiUtils.showToast('Item added successfully!', 'success');
        }
        uiUtils.closeModal();
        await fetchMenu();
    } catch (error) {
        alert(`Error: ${error.message}`);
        submitButton.disabled = false;
        submitButton.textContent = isEditing ? 'Save Changes' : 'Create Item';
    }
}




async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"?`)) return;
    const { fetchMenu } = useAppStore.getState().menu;
    try {
        await api.deleteMenuItem(itemId);
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
    updateSiteSettings({ menuCategories: newCategoryOrder });
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
    await updateSiteSettings({ themeVariables });
    uiUtils.showToast('Theme saved successfully!', 'success');
    saveButton.textContent = 'Save Theme Settings';
    saveButton.disabled = false;
}


/**
 * NEW: Handles saving the business details form.
 * @param {HTMLFormElement} form
 */
async function handleBusinessDetailsSave(form) {
    const saveButton = form.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';
    
    const formData = new FormData(form);
    const detailsToUpdate = Object.fromEntries(formData.entries()); // { restaurantPhoneNumber: '...' }

    try {
        await useAppStore.getState().siteSettings.updateSiteSettings(detailsToUpdate);
        uiUtils.showToast('Business details saved!', 'success');
    } catch (error) {
        // The slice handles optimistic revert, so just show a message
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Details';
    }
}


function attachOwnerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer || dashboardContainer.dataset.listenersAttached === 'true') return;
    
    // --- Event Delegation for all clicks and submits ---
    dashboardContainer.addEventListener('submit', (event) => {
        // --- NEW: Handle Business Details Form Submission ---
        if (event.target.matches('#business-details-form')) {
            event.preventDefault();
            handleBusinessDetailsSave(event.target);
        }
        // --- End New ---
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
            const { getMenuCategories, updateSiteSettings } = useAppStore.getState().siteSettings;
            let categories = getMenuCategories();
            if (target.matches('#add-category-btn')) {
                const input = document.getElementById('new-category-name');
                const newName = input.value.trim();
                if (newName && !categories.includes(newName)) {
                    updateSiteSettings({ menuCategories: [...categories, newName] });
                    input.value = '';
                }
            }
            const listItem = target.closest('.category-list-item');
            if (listItem) {
                const oldName = listItem.dataset.categoryName;
                if (target.matches('.rename-category-btn')) {
                    const newName = prompt(`Rename category "${oldName}":`, oldName);
                    if (newName && newName.trim() !== oldName) {
                        updateSiteSettings({ menuCategories: categories.map(c => c === oldName ? newName.trim() : c) });
                    }
                }
                if (target.matches('.delete-category-btn')) {
                    if (categories.length <= 1) {
                        alert('You must have at least one category.');
                        return;
                    }
                    if (confirm(`Delete the "${oldName}" category?`)) {
                        updateSiteSettings({ menuCategories: categories.filter(c => c !== oldName) });
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


// --- EXPORTED RENDER FUNCTION ---

export function renderOwnerDashboard() {
const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { settings, isLoading, error } = useAppStore.getState().siteSettings;

    if (isLoading) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        return;
    }
    if (error) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error loading settings</h2><p>${error}</p></div>`;
        return;
    }

    const { items: menuItems } = useAppStore.getState().menu;
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories();

    const themeControlsHTML = uiUtils.getThemeControlsHTML(settings.themeVariables || {});
    const categoryListItems = categories.map(category => `
        <li class="category-list-item" data-category-name="${category}">
            <span class="drag-handle">::</span>
            <span class="category-name">${category}</span>
            <div class="category-actions">
                <button class="button-secondary small rename-category-btn">Rename</button>
                <button class="button-danger small delete-category-btn">Delete</button>
            </div>
        </li>
    `).join('');
    const menuLayoutHTML = `
        <div id="category-manager">
            <ul id="category-list">${categoryListItems}</ul>
            <div class="add-category-form">
                <input type="text" id="new-category-name" placeholder="New category name...">
                <button id="add-category-btn" class="button-primary">Add Category</button>
            </div>
        </div>
    `;
    // --- END OF `getMenuLayoutHTML()` LOGIC ---

    // --- THIS IS THE FORMERLY MISSING `menuItemsTableRows` LOGIC ---
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

            <!-- NEW: Business Details Section -->
            <section class="dashboard-section">
                <h3>Business Details</h3>
                <form id="business-details-form">
                    <div class="form-group">
                        <label for="phone-number">Public Phone Number</label>
                        <input type="tel" id="phone-number" name="restaurantPhoneNumber" 
                               value="${settings.restaurantPhoneNumber || ''}" 
                               placeholder="e.g., +1-555-123-4567">
                        <small>This number will be used for the "click-to-call" icon in the header.</small>
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Save Details</button>
                    </div>
                </form>
            </section>
            
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

            <section class="dashboard-section">
                <h3>Menu Layout & Categories</h3>
                <p>Add, rename, delete, and reorder categories. Drag and drop to reorder.</p>
                ${menuLayoutHTML}
            </section>
            
            <section class="dashboard-section">
                <h3>Visual Customization</h3>
                <p>Change the look and feel of your website.</p>
                <div class="theme-controls-wrapper">${themeControlsHTML}</div>
            </section>
        </div>
    `;

    attachOwnerDashboardListeners();
    initializeSortable();
}