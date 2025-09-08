// src/features/admin/managerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js'; // Needed for direct API calls
import * as uiUtils from '@/utils/uiUtils.js';

// --- HELPER FUNCTIONS ---

function showEditUserModal(user) {
    const modalContentHTML = `
        <h3>Edit User: ${user.email}</h3>
        <form id="edit-user-form">
            <div class="form-group">
                <label for="user-role">Role</label>
                <select id="user-role" name="role">
                    <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer</option>
                    <option value="owner" ${user.role === 'owner' ? 'selected' : ''}>Owner</option>
                    <option value="manager" ${user.role === 'manager' ? 'selected' : ''}>Manager (God User)</option>
                </select>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="is-verified-buyer" name="isVerifiedBuyer" ${user.is_verified_buyer ? 'checked' : ''}>
                    Verified Buyer Status
                </label>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="can-see-order-history" name="canSeeOrderHistory" ${user.can_see_order_history ? 'checked' : ''}>
                    Enable "Order History" Tab
                </label>
            </div>
            <div class="form-actions">
                <button type="submit" class="button-primary">Save Changes</button>
            </div>
        </form>
    `;
uiUtils.showModal(modalContentHTML);

    document.getElementById('edit-user-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const newRole = document.getElementById('user-role').value;
        const isVerifiedBuyer = document.getElementById('is-verified-buyer').checked;
        const canSeeOrderHistory = document.getElementById('can-see-order-history').checked; // <-- Get new value
        
        // Call the updated store action
        useAppStore.getState().admin.updateUserRole(user.id, newRole, isVerifiedBuyer, canSeeOrderHistory);
        uiUtils.closeModal();
    });
}


async function handleGlobalSettingsSave(event) {
    event.preventDefault();
    const form = event.target;
    const websiteName = form.websiteName.value;
    const hamburgerMenuContent = form.hamburgerMenuContent.value;

    try {
        // We can now save multiple settings at once
        await api.updateSiteSettings({ websiteName, hamburgerMenuContent });
        uiUtils.updateSiteTitles(websiteName); // Still update title live
        uiUtils.showToast('Global settings updated!', 'success');
    } catch (error) {
        alert(`Error saving settings: ${error.message}`);
    }
}

async function handleThemeSettingsSave() {
    const themeVariables = {};
    document.querySelectorAll('[data-css-var]').forEach(input => {
        themeVariables[input.dataset.cssVar] = input.value;
    });
    try {
        await api.updateSiteSettings({ themeVariables });
        uiUtils.showToast('Theme saved!', 'success');
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function attachManagerDashboardListeners() {
    const dashboardContainer = document.querySelector('.dashboard-container');
    if (!dashboardContainer || dashboardContainer.dataset.listenersAttached) return;

    dashboardContainer.addEventListener('click', (event) => {
        if (event.target.closest('.edit-user-btn')) {
            const userId = event.target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }
        if (event.target.matches('#save-theme-settings')) {
            handleThemeSettingsSave();
        }
    });

    dashboardContainer.addEventListener('submit', (event) => {
        if (event.target.matches('#global-settings-form')) {
            handleGlobalSettingsSave(event);
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

export async function renderManagerDashboard() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    mainContent.innerHTML = `<div class="loading-spinner">Loading God Mode Dashboard...</div>`;

    // Fetch all necessary data concurrently
    await Promise.all([
        useAppStore.getState().admin.fetchAllUsers(),
        useAppStore.getState().siteSettings.fetchSiteSettings()
    ]);

    const { users, isLoadingUsers, error: userError } = useAppStore.getState().admin;
    const { settings, error: settingsError } = useAppStore.getState().siteSettings;
    
    if (userError || settingsError) {
        mainContent.innerHTML = `<div class="error-message"><h2>Could not load dashboard data</h2><p>${userError || settingsError}</p></div>`;
        return;
    }

    // --- Prepare HTML chunks ---
const userTableRows = users.map(user => `
        <tr data-user-id="${user.id}">
            <td>${user.email}</td>
                        <td>${user.full_name || 'N/A'}</td>
            <td><span class="role-badge role-${user.role}">${user.role}</span></td>
            <td>${user.is_verified_buyer ? 'Yes' : 'No'}</td>
            <td>${user.can_see_order_history ? 'Yes' : 'No'}</td> <!-- NEW COLUMN -->
            <td>${new Date(user.created_at).toLocaleDateString()}</td>
            <td><button class="button-secondary small edit-user-btn">Edit</button></td>
        </tr>
    `).join('');

    const themeControlsHTML = uiUtils.getThemeControlsHTML(settings.themeVariables || {});

    // --- Assemble Final HTML ---
    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>God Mode Dashboard</h2>

            <section class="dashboard-section">
                <h3>User Management</h3>
                <div class="table-wrapper">
                    <table>
                        <thead>
                            <tr><th>Email</th><th>Full Name</th><th>Role</th><th>Verified Buyer</th><th>Can Re-order?</th><th>Joined</th><th>Actions</th></tr>
                        </thead>
                        <tbody>${isLoadingUsers ? `<tr><td colspan="6">Loading...</td></tr>` : userTableRows}</tbody>
                    </table>
                </div>
            </section>
            
            <section class="dashboard-section">
                <h3>Global Site Settings</h3>
                <form id="global-settings-form">
                    <div class="form-group">
                        <label for="website-name">Website Name</label>
                        <input type="text" id="website-name" name="websiteName" value="${settings.websiteName || 'Mealmates'}">
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Save Site Name</button>
                    </div>
                </form><div class="form-group">
                        <label>Hamburger Menu Content</label>
                        <div>
                            <input type="radio" id="hamburger-main-nav" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig === 'main-nav' ? 'checked' : ''}>
                            <label for="hamburger-main-nav">Show Main Nav Links (Menu, Cart)</label>
                        </div>
                        <div>
                            <input type="radio" id="hamburger-categories" name="hamburgerMenuContent" value="categories" ${hamburgerConfig === 'categories' ? 'checked' : ''}>
                            <label for="hamburger-categories">Show Menu Categories (for filtering)</label>
                        </div>
                    </div>
                    
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Save Site Settings</button>
                    </div>
                </form>
            </section>
            
            <section class="dashboard-section">
                <h3>Theme Customizer</h3>
                ${themeControlsHTML}
            </section>
        </div>
    `;

    attachManagerDashboardListeners();
}