// src/features/admin/ownerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the main Owner Dashboard interface.
 */
export function renderOwnerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Get the current menu items from the store to display
    const { items: menuItems } = useAppStore.getState().menu;

    // Generate the HTML for the list of manageable menu items
    const menuItemsTableRows = menuItems.map(item => `
        <tr data-item-id="${item.id}">
            <td>${item.name}</td>
            <td>${item.category || 'N/A'}</td>
            <td>$${item.price.toFixed(2)}</td>
            <td>
                <button class="edit-item-btn" data-item-id="${item.id}">Edit</button>
            </td>
        </tr>
    `).join('');

    const dashboardHTML = `
        <div class="dashboard-container">
            <h2>Owner Dashboard</h2>
            <section class="dashboard-section menu-management">
                <h3>Menu Management</h3>
                <div class="table-actions">
                    <button id="add-new-item-btn" class="button-primary">Add New Item</button>
                </div>
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Category</th>
                                <th>Price</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${menuItemsTableRows}
                        </tbody>
                    </table>
                </div>
            </section>
            <!-- We will add other sections like Order Management here later -->
        </div>
    `;

    mainContent.innerHTML = dashboardHTML;
    attachOwnerDashboardListeners();
}

/**
 * Attaches event listeners for the owner dashboard.
 */
function attachOwnerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer) return;

    dashboardContainer.addEventListener('click', (event) => {
        const target = event.target;

        if (target.matches('#add-new-item-btn')) {
            showMenuItemModal(); // Show modal for creating a new item
        }
        if (target.matches('.edit-item-btn')) {
            const itemId = target.dataset.itemId;
            const item = useAppStore.getState().menu.items.find(i => i.id === itemId);
            if (item) {
                showMenuItemModal(item); // Show modal for editing an existing item
            }
        }
    });
}

/**
 * Shows a modal to add or edit a menu item.
 * @param {object|null} [item=null] - The item to edit, or null to create a new one.
 */
function showMenuItemModal(item = null) {
    const isEditing = item !== null;
    const modalTitle = isEditing ? `Edit "${item.name}"` : 'Add New Menu Item';
    const buttonText = isEditing ? 'Save Changes' : 'Create Item';

    const modalContentHTML = `
        <h3>${modalTitle}</h3>
        <form id="menu-item-form">
            <input type="hidden" name="id" value="${isEditing ? item.id : ''}">
            <div class="form-group">
                <label for="item-name">Name</label>
                <input type="text" id="item-name" name="name" value="${isEditing ? item.name : ''}" required>
            </div>
            <div class="form-group">
                <label for="item-description">Description</label>
                <textarea id="item-description" name="description">${isEditing ? (item.description || '') : ''}</textarea>
            </div>
            <div class="form-group">
                <label for="item-price">Price</label>
                <input type="number" id="item-price" name="price" step="0.01" value="${isEditing ? item.price : ''}" required>
            </div>
            <div class="form-group">
                <label for="item-category">Category</label>
                <input type="text" id="item-category" name="category" value="${isEditing ? (item.category || '') : ''}">
            </div>
            <div class="form-group">
                <label for="item-image-url">Image URL</label>
                <input type="text" id="item-image-url" name="image_url" placeholder="e.g., /placeholder-pizza.jpg" value="${isEditing ? (item.image_url || '') : ''}">
            </div>
            <div class="form-actions-split">
                ${isEditing ? `<button type="button" id="delete-item-btn" class="button-danger">Delete Item</button>` : '<div></div>'}
                <button type="submit" class="button-primary">${buttonText}</button>
            </div>
        </form>
    `;
    uiUtils.showModal(modalContentHTML);

    const form = document.getElementById('menu-item-form');
    form.addEventListener('submit', handleMenuItemFormSubmit);

    if (isEditing) {
        const deleteBtn = document.getElementById('delete-item-btn');
        deleteBtn.addEventListener('click', () => handleDeleteMenuItem(item.id, item.name));
    }
}

/**
 * Handles the submission of the add/edit menu item form.
 * @param {Event} event
 */
async function handleMenuItemFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const formData = new FormData(form);
    const itemData = Object.fromEntries(formData.entries());
    const isEditing = !!itemData.id;
    const { fetchMenu } = useAppStore.getState();

    try {
        if (isEditing) {
            await api.updateMenuItem(itemData.id, itemData);
            uiUtils.showToast('Item updated successfully!', 'success');
        } else {
            await api.addMenuItem(itemData);
            uiUtils.showToast('Item added successfully!', 'success');
        }
        uiUtils.closeModal();
        await fetchMenu(); // Re-fetch the entire menu to get the latest data
    } catch (error) {
        alert(`Error: ${error.message}`); // Show a simple alert for API errors
    }
}

/**
 * Handles the deletion of a menu item.
 * @param {string} itemId
 * @param {string} itemName
 */
async function handleDeleteMenuItem(itemId, itemName) {
    if (!confirm(`Are you sure you want to delete "${itemName}"? This cannot be undone.`)) {
        return;
    }
    const { fetchMenu } = useAppStore.getState();
    try {
        await api.deleteMenuItem(itemId);
        uiUtils.showToast('Item deleted successfully.', 'info');
        uiUtils.closeModal();
        await fetchMenu(); // Re-fetch menu to reflect the deletion
    } catch (error) {
        alert(`Error deleting item: ${error.message}`);
    }
}