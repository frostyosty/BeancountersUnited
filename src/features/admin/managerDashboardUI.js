// src/features/admin/managerDashboardUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js'; 

// --- HELPER: Upload Logic for Logo ---
async function uploadLogo(file) {
    const fileExt = file.name.split('.').pop();
    const fileName = `logos/site-logo-${Date.now()}.${fileExt}`;

    const { error: uploadError } = await supabase.storage
        .from('menu-images') 
        .upload(fileName, file);

    if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
    }

    const { data } = supabase.storage
        .from('menu-images')
        .getPublicUrl(fileName);
        
    return data.publicUrl;
}

// --- HELPER: Get Token ---
async function getAuthToken() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("You are not logged in.");
    return session.access_token;
}

// --- MAIN RENDER FUNCTION ---
export function renderManagerDashboard() {
    console.log("%c[ManagerDashboardUI] renderManagerDashboard() CALLED.", "color: orange;");
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // 1. Fetch Data
    // Use 'true' to force refresh users so you see new signups immediately
    useAppStore.getState().admin.fetchAllUsers(true); 
    useAppStore.getState().siteSettings.fetchSiteSettings();
    
    const { users, isLoadingUsers, error: userError } = useAppStore.getState().admin;
    const { settings, isLoading: isLoadingSettings, error: settingsError } = useAppStore.getState().siteSettings;

    // 2. Loading / Error States
    if (isLoadingUsers || isLoadingSettings) {
        mainContent.innerHTML = `<div class="loading-spinner">Loading Dashboard...</div>`;
        return;
    }
    if (userError || settingsError) {
        mainContent.innerHTML = `<div class="error-message"><h2>Error</h2><p>${userError || settingsError}</p></div>`;
        return;
    }

    // 3. Prepare Data Variables
    const ownerSettings = settings.ownerPermissions || {};
    const hamburgerConfig = settings.hamburgerMenuContent || 'main-nav';
    const currentLogo = settings.logoUrl || '';

    // 4. Build User Table Rows
    const userTableRows = users.map(user => `
        <tr data-user-id="${user.id}">
            <td>${user.email}</td>
            <td>${user.full_name || 'N/A'}</td>
            <td><span class="role-badge role-${user.role}">${user.role}</span></td>
            <td>${user.is_verified_buyer ? 'Yes' : 'No'}</td>
            <td>${user.can_see_order_history ? 'Yes' : 'No'}</td>
            <td>${new Date(user.created_at).toLocaleDateString()}</td>
            <td><button class="button-secondary small edit-user-btn">Edit</button></td>
        </tr>
    `).join('');

    // 5. Generate Theme Controls HTML (Colors + Fonts)
    const themeControlsHTML = uiUtils.getThemeControlsHTML(settings.themeVariables || {});

    // 6. Render Full Dashboard
    mainContent.innerHTML = `
        <div class="dashboard-container">
            <h2>God Mode Dashboard</h2>
            
            <!-- SECTION 1: Global Site Settings -->
            <section class="dashboard-section">
                <h3>Global Site Settings</h3>
                <form id="global-settings-form">
                    <div class="form-group">
                        <label>Website Name</label>
                        <input type="text" name="websiteName" value="${settings.websiteName || 'Mealmates'}" required>
                    </div>
                    
                    <!-- Logo Upload Area -->
                    <div class="form-group" style="background: #f9f9f9; padding: 15px; border-radius: 8px; border: 1px dashed #ccc; margin-bottom: 15px;">
                        <label style="margin-bottom: 10px; display:block; font-weight:600;">Website Logo</label>
                        
                        <div style="margin-bottom: 10px; text-align: center;">
                            <img id="logo-preview" src="${currentLogo}" style="max-height: 60px; display: ${currentLogo ? 'inline-block' : 'none'}; border: 1px solid #ddd; padding: 5px; background: white; border-radius: 4px;">
                            <p id="no-logo-text" style="display: ${currentLogo ? 'none' : 'block'}; color: #666; font-size: 0.9rem; font-style: italic;">No logo uploaded</p>
                        </div>

                        <div style="display:flex; gap:10px; align-items:center; justify-content:center;">
                            <label for="logo-upload" class="button-secondary small" style="cursor:pointer; margin:0;">Choose File</label>
                            <input type="file" id="logo-upload" name="logoFile" accept="image/*" style="display:none;">
                            <button type="button" id="clear-logo-btn" class="button-danger small" style="${currentLogo ? '' : 'display:none;'}">Remove</button>
                        </div>
                        <input type="hidden" name="logoUrl" value="${currentLogo}">
                    </div>

                     <div class="form-group">
                        <label>Hamburger Menu Content</label>
                        <div style="display:flex; gap: 20px; margin-top: 5px;">
                            <label style="font-weight:normal;">
                                <input type="radio" name="hamburgerMenuContent" value="main-nav" ${hamburgerConfig === 'main-nav' ? 'checked' : ''}> 
                                Show Main Nav Links
                            </label>
                            <label style="font-weight:normal;">
                                <input type="radio" name="hamburgerMenuContent" value="categories" ${hamburgerConfig === 'categories' ? 'checked' : ''}> 
                                Show Menu Categories
                            </label>
                        </div>
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Save Site Settings</button>
                    </div>
                </form>
            </section>

            <!-- SECTION 2: User Management -->
            <section class="dashboard-section">
                <h3>User Management</h3>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Verified</th><th>History?</th><th>Joined</th><th>Actions</th></tr></thead>
                        <tbody>${userTableRows}</tbody>
                    </table>
                </div>
            </section>

            <!-- SECTION 3: Theme Customizer -->
            <section class="dashboard-section">
                <h3>Theme Customizer</h3>
                <p style="color:#666; font-size:0.9rem; margin-bottom:15px;">Control the visual identity of the site.</p>
                ${themeControlsHTML}
            </section>

            <!-- SECTION 4: Owner Permissions -->
            <section class="dashboard-section">
                <h3>Owner Permissions</h3>
                <form id="owner-permissions-form">
                    <div class="form-group">
                        <label style="font-weight:normal;">
                            <input type="checkbox" name="canEditTheme" ${ownerSettings.canEditTheme ? 'checked' : ''}> 
                            Allow owners to edit theme colors/fonts.
                        </label>
                    </div>
                    <div class="form-group">
                        <label style="font-weight:normal;">
                            <input type="checkbox" name="canEditCategories" ${ownerSettings.canEditCategories ? 'checked' : ''}> 
                            Allow owners to manage menu categories.
                        </label>
                    </div>
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Save Permissions</button>
                    </div>
                </form>
            </section>
        </div>
    `;

    attachManagerListeners();
}

// --- EVENT LISTENERS ---
function attachManagerListeners() {
    const container = document.querySelector('.dashboard-container');
    if (!container || container.dataset.listenersAttached) return;

    // 1. Logo Handling
    const logoInput = document.getElementById('logo-upload');
    const logoPreview = document.getElementById('logo-preview');
    const noLogoText = document.getElementById('no-logo-text');
    const clearLogoBtn = document.getElementById('clear-logo-btn');

    logoInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            logoPreview.src = URL.createObjectURL(file);
            logoPreview.style.display = 'inline-block';
            noLogoText.style.display = 'none';
            clearLogoBtn.style.display = 'inline-block';
        }
    });

    clearLogoBtn?.addEventListener('click', () => {
        logoInput.value = '';
        document.querySelector('input[name="logoUrl"]').value = '';
        logoPreview.src = '';
        logoPreview.style.display = 'none';
        noLogoText.style.display = 'block';
        clearLogoBtn.style.display = 'none';
    });

    // 2. Live Previews (Color & Font)
    container.addEventListener('input', (event) => {
        if (event.target.matches('[data-css-var]')) {
            uiUtils.updateCssVariable(event.target.dataset.cssVar, event.target.value);
        }
    });
    container.addEventListener('change', (event) => {
        if (event.target.matches('#font-selector')) {
            uiUtils.applySiteFont(event.target.value);
        }
    });

    // 3. Form Submits
    container.addEventListener('submit', async (event) => {
        // Global Settings (Logo/Name)
        if (event.target.matches('#global-settings-form')) {
            event.preventDefault();
            const btn = event.target.querySelector('button[type="submit"]');
            btn.disabled = true;
            btn.textContent = "Saving...";

            const formData = new FormData(event.target);
            let finalLogoUrl = formData.get('logoUrl');
            const logoFile = formData.get('logoFile');
            const websiteName = formData.get('websiteName');
            const hamburgerMenuContent = formData.get('hamburgerMenuContent');

            try {
                // FIX: Get Token
                const token = await getAuthToken();

                if (logoFile && logoFile.size > 0) {
                    finalLogoUrl = await uploadLogo(logoFile);
                }

                const settingsUpdate = { 
                    websiteName, 
                    hamburgerMenuContent,
                    logoUrl: finalLogoUrl 
                };

                // FIX: Pass token
                await api.updateSiteSettings(settingsUpdate, token);
                
                uiUtils.updateSiteTitles(websiteName, finalLogoUrl);
                uiUtils.showToast('Global settings saved!', 'success');
                useAppStore.getState().siteSettings.fetchSiteSettings();

            } catch (error) {
                alert(`Error: ${error.message}`);
            } finally {
                btn.disabled = false;
                btn.textContent = "Save Site Settings";
            }
        }

        // Owner Permissions
        if (event.target.matches('#owner-permissions-form')) {
            event.preventDefault();
            const form = event.target;
            const permissions = {
                canEditTheme: form.canEditTheme.checked,
                canEditCategories: form.canEditCategories.checked,
            };
            
            try {
                // FIX: Get Token & Pass token
                const token = await getAuthToken();
                await api.updateSiteSettings({ ownerPermissions: permissions }, token);
                uiUtils.showToast('Permissions updated.', 'success');
            } catch(e) { 
                uiUtils.showToast('Error saving permissions', 'error'); 
            }
        }
    });

    // 4. Click Actions
    container.addEventListener('click', async (event) => {
        // Save Theme Button
        if (event.target.matches('#save-theme-settings')) {
            const themeVariables = {};
            document.querySelectorAll('[data-css-var]').forEach(input => {
                themeVariables[input.dataset.cssVar] = input.value;
            });
            const fontSelect = document.getElementById('font-selector');
            if (fontSelect) themeVariables['--font-family-main-name'] = fontSelect.value;

            try {
                // FIX: Get Token & Pass token
                const token = await getAuthToken();
                await api.updateSiteSettings({ themeVariables }, token);
                uiUtils.showToast('Theme saved!', 'success');
            } catch (e) {
                uiUtils.showToast('Theme save failed', 'error');
            }
        }

        // Edit User Modal
        if (event.target.closest('.edit-user-btn')) {
            const userId = event.target.closest('tr').dataset.userId;
            const user = useAppStore.getState().admin.users.find(u => u.id === userId);
            if (user) showEditUserModal(user);
        }
    });

    container.dataset.listenersAttached = 'true';
}

// ... showEditUserModal remains unchanged ...
function showEditUserModal(user) {
    const modalHTML = `
        <div class="modal-form-container">
            <h3>Edit User: ${user.email}</h3>
            <form id="edit-user-form">
                <div class="form-row">
                    <label>Role</label>
                    <select id="user-role">
                        <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer</option>
                        <option value="owner" ${user.role === 'owner' ? 'selected' : ''}>Owner</option>
                        <option value="manager" ${user.role === 'manager' ? 'selected' : ''}>Manager (God)</option>
                    </select>
                </div>
                
                <div class="form-row">
                    <label style="font-weight:normal; display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" id="is-verified" ${user.is_verified_buyer ? 'checked' : ''} style="width:auto;"> 
                        Verified Buyer Status
                    </label>
                </div>
                
                <div class="form-row">
                    <label style="font-weight:normal; display:flex; align-items:center; gap:10px; cursor:pointer;">
                        <input type="checkbox" id="can-see-orders" ${user.can_see_order_history ? 'checked' : ''} style="width:auto;"> 
                        Can See Order History Tab
                    </label>
                </div>

                <div class="form-actions-split" style="justify-content: flex-end; margin-top: 20px;">
                    <button type="submit" class="button-primary">Save Changes</button>
                </div>
            </form>
        </div>
    `;
    
    uiUtils.showModal(modalHTML);
    
    const form = document.getElementById('edit-user-form');
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const newRole = document.getElementById('user-role').value;
        const isVerified = document.getElementById('is-verified').checked;
        const canSeeOrders = document.getElementById('can-see-orders').checked;
        
        useAppStore.getState().admin.updateUserRole(
            user.id, 
            newRole, 
            isVerified, 
            canSeeOrders
        );
        
        uiUtils.closeModal();
        uiUtils.showToast(`User ${user.email} updated.`, 'success');
    });
}