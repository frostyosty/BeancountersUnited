import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import Sortable from 'sortablejs';

// --- LOCAL STATE FOR SORTING ---
let currentSort = { column: 'name', direction: 'asc' };

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
    
    const { getMenuCategories } = useAppStore.getState().siteSettings;
    const categories = getMenuCategories() || ['Uncategorized'];
    
    const categoryOptions = categories.map(cat => 
        `<option value="${cat}" ${item?.category === cat ? 'selected' : ''}>${cat}</option>`
    ).join('');

    // Note: CSS is now in style.css
    const modalContentHTML = `
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
                    <!-- We moved delete to the table, but kept it here optionally -->
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
        console.error(error);
        uiUtils.showToast(`Error: ${error.message}`, 'error');
        submitButton.disabled = false;
        submitButton.textContent = isEditing ? 'Save Changes' : 'Create Item';
    }
}

async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Delete "${itemName}"?`)) return;
    
    const { deleteMenuItemOptimistic } = useAppStore.getState().menu;
    const { data: { session } } = await supabase.auth.getSession();
    
    try {
        await deleteMenuItemOptimistic(itemId, session?.access_token);
        uiUtils.showToast('Item deleted.', 'info');
        // If modal is open, close it
        if (document.querySelector('.modal-overlay')) {
            uiUtils.closeModal();
        }
    } catch (error) {
        uiUtils.showToast(`Error: ${error.message}`, 'error');
    }
}

function initializeSortable() {
    const list = document.getElementById('category-list');
    if (!list) return;
    if (list.dataset.sortableInitialized === 'true') return;

    new Sortable(list, {
        animation: 150,
        handle: '.drag-handle-wrapper',
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

function attachOwnerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer || dashboardContainer.dataset.listenersAttached === 'true') return;

    dashboardContainer.addEventListener('click', (event) => {
        const target = event.target;
        
        // Add Item
        if (target.matches('#add-new-item-btn')) {
            showMenuItemModal(null);
        }
        // Edit Item
        else if (target.closest('.edit-item-btn-table')) {
            const row = target.closest('tr');
            const item = useAppStore.getState().menu.items.find(i => i.id === row.dataset.itemId);
            showMenuItemModal(item);
        }
        // Delete Item (Small X)
        else if (target.closest('.delete-icon-btn')) {
            const row = target.closest('tr');
            const item = useAppStore.getState().menu.items.find(i => i.id === row.dataset.itemId);
            handleDeleteMenuItem(item.id, item.name);
        }
        // Sorting Headers
        else if (target.matches('th.sortable')) {
            const column = target.dataset.sortCol;
            if (currentSort.column === column) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.column = column;
                currentSort.direction = 'asc';
            }
            renderOwnerDashboard(); // Re-render with new sort
        }

        // --- Category Management ---
        const categoryManager = target.closest('#category-manager');
        if (categoryManager) {
            const { getMenuCategories, updateSiteSettings } = useAppStore.getState().siteSettings;
            let categories = getMenuCategories();
            
            const runUpdate = async (newCats) => {
                const { data: { session } } = await supabase.auth.getSession();
                updateSiteSettings({ menuCategories: newCats }, session?.access_token);
            };

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

    dashboardContainer.dataset.listenersAttached = 'true';
}

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

    // Helper for sort indicators
    const getSortClass = (col) => currentSort.column === col ? currentSort.direction : '';

    const menuItemsTableRows = sortedItems.map(item => `
        <tr data-item-id="${item.id}">
            <td style="font-weight:500;">${item.name}</td>
            <td><span class="badge" style="background:#eee; color:#333;">${item.category || 'None'}</span></td>
            <td>$${parseFloat(item.price).toFixed(2)}</td>
            <td>
                <button class="button-secondary small edit-item-btn-table">Edit</button>
                <button class="delete-icon-btn" title="Delete Item">×</button>
            </td>
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
                        <thead>
                            <tr>
                                <th class="sortable ${getSortClass('name')}" data-sort-col="name">Name</th>
                                <th class="sortable ${getSortClass('category')}" data-sort-col="category">Category</th>
                                <th class="sortable ${getSortClass('price')}" data-sort-col="price">Price</th>
                                <th>Actions</th>
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
        </div>
    `;

    attachOwnerDashboardListeners();
    if (ownerPermissions.canEditCategories) initializeSortable();
}