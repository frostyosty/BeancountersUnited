import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';


export async function showCustomerCRMModal(userId) {
    uiUtils.showModal(`<div class="loading-spinner">Fetching Client History...</div>`);

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        // 1. Fetch Data (Now includes 'logs')
        const { profile, history, logs } = await api.getCustomerDetails(userId, session.access_token);

        // 2. Build History HTML (Same as before)
        const historyRows = history.map(order => {
            const date = new Date(order.created_at).toLocaleDateString();
            const itemsSummary = order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name}`).join(', ');
            return `<tr style="border-bottom:1px solid #eee; font-size:0.9rem;"><td style="padding:8px;">${date}</td><td style="padding:8px; color:#666;">${itemsSummary}</td><td style="padding:8px;">$${order.total_amount.toFixed(2)}</td></tr>`;
        }).join('');

        // 3. Build Audit Log HTML (NEW)
        const auditRows = (logs || []).map(log => {
            const date = new Date(log.created_at).toLocaleString();
            const actorName = log.profiles?.email || 'Unknown God';
            
            // Format the change message nicely
            let changeMsg = '';
            if (log.action_type === 'UPDATE_NICKNAME') {
                changeMsg = `Changed nickname from <strong>"${log.old_value}"</strong> to <strong>"${log.new_value}"</strong>`;
            } else if (log.action_type === 'UPDATE_NOTE') {
                changeMsg = `Updated staff note`;
            } else {
                changeMsg = `Changed ${log.action_type.toLowerCase().replace('update_', '')} to "${log.new_value}"`;
            }

            return `
                <div style="padding: 10px; border-bottom: 1px solid #eee; font-size: 0.85rem;">
                    <div style="display:flex; justify-content:space-between; color:#888; margin-bottom:4px;">
                        <span>${date}</span>
                        <span>by ${actorName}</span>
                    </div>
                    <div style="color:#333;">${changeMsg}</div>
                </div>
            `;
        }).join('');

        // 4. Build Modal Content
        const modalHTML = `
            <div class="crm-modal-container" style="min-width:350px;">
                <!-- Header -->
                <div style="border-bottom:1px solid #eee; padding-bottom:15px; margin-bottom:15px;">
                    <h3 style="margin:0 0 5px 0;">${profile.full_name || profile.email}</h3>
                    <p style="margin:0; font-size:0.85rem; color:#666;">${profile.email}</p>
                    
                    <div style="margin-top:10px; display:flex; gap:10px; align-items:center;">
                        <label style="font-size:0.9rem;">Nickname:</label>
                        <input type="text" id="crm-nickname" value="${profile.internal_nickname || ''}" placeholder="e.g. Latte John" style="padding:5px; border:1px solid #ccc; border-radius:4px; flex:1;">
                    </div>
                </div>

                <!-- Staff Notes -->
                <div style="background:#f9f9f9; padding:15px; border-radius:6px; margin-bottom:20px;">
                    <label style="font-weight:bold; font-size:0.9rem; display:block; margin-bottom:5px;">Staff Note</label>
                    <textarea id="crm-note" rows="3" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">${profile.staff_note || ''}</textarea>
                    
                    <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; gap:15px;">
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer;">
                                <input type="radio" name="noteUrgency" value="info" ${profile.staff_note_urgency !== 'alert' ? 'checked' : ''}> Info
                            </label>
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer; color:#d00;">
                                <input type="radio" name="noteUrgency" value="alert" ${profile.staff_note_urgency === 'alert' ? 'checked' : ''}> Important
                            </label>
                        </div>
                        <button id="crm-save-btn" class="button-primary small">Save Note</button>
                    </div>
                </div>

                <!-- Tabs for History / Audit -->
                <div style="margin-bottom:10px;">
                    <button id="tab-orders" class="button-secondary small" style="background:#ddd; color:#333;">Order History</button>
                    <button id="tab-audit" class="button-secondary small" style="background:transparent; color:#666; border:1px solid #ddd;">Audit Log</button>
                </div>

                <!-- Tab Content: Orders -->
                <div id="content-orders" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead style="background:#f5f5f5; position:sticky; top:0;">
                            <tr><th style="padding:8px; text-align:left; font-size:0.8rem;">Date</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Items</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Total</th></tr>
                        </thead>
                        <tbody>${historyRows || '<tr><td colspan="3" style="text-align:center;">No history</td></tr>'}</tbody>
                    </table>
                </div>

                <!-- Tab Content: Audit Log (Hidden by default) -->
                <div id="content-audit" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px; display:none;">
                    ${auditRows || '<div style="padding:15px; text-align:center; color:#999; font-size:0.9rem;">No changes recorded.</div>'}
                </div>

            </div>
        `;

        uiUtils.showModal(modalHTML);

        // --- TAB SWITCHING LOGIC ---
        const tabOrders = document.getElementById('tab-orders');
        const tabAudit = document.getElementById('tab-audit');
        const contentOrders = document.getElementById('content-orders');
        const contentAudit = document.getElementById('content-audit');

        tabOrders.onclick = () => {
            contentOrders.style.display = 'block';
            contentAudit.style.display = 'none';
            tabOrders.style.background = '#ddd'; tabOrders.style.color = '#333';
            tabAudit.style.background = 'transparent'; tabAudit.style.color = '#666';
        };
        tabAudit.onclick = () => {
            contentOrders.style.display = 'none';
            contentAudit.style.display = 'block';
            tabAudit.style.background = '#ddd'; tabAudit.style.color = '#333';
            tabOrders.style.background = 'transparent'; tabOrders.style.color = '#666';
        };

        // --- SAVE LOGIC (Same as before) ---
        document.getElementById('crm-save-btn').addEventListener('click', async (e) => {
            const btn = e.target;
            btn.textContent = 'Saving...'; btn.disabled = true;
            
            const nickname = document.getElementById('crm-nickname').value;
            const note = document.getElementById('crm-note').value;
            const urgency = document.querySelector('input[name="noteUrgency"]:checked').value;

            try {
                await api.updateCustomerDetails({ userId, nickname, note, urgency }, session.access_token);
                uiUtils.showToast("Updated!", "success");
                useAppStore.getState().ui.triggerPageRender(); 
                // Refresh modal content to see the new log entry? 
                // Ideally yes, but closing/reopening is fine for now.
                uiUtils.closeModal(); 
            } catch (err) {
                console.error(err);
                uiUtils.showToast("Failed.", "error");
                btn.textContent = 'Save Note'; btn.disabled = false;
            }
        });

    } catch (e) {
        console.error("CRM Modal Error:", e);
        uiUtils.showModal(`<div class="error-message">Could not load client details.</div>`);
    }
}

// --- NEW: EDIT ITEM MODAL WITH ALLERGENS ---
export function showEditItemModal(item) {
    const isEditing = !!item;
    const itemData = item || { name: '', price: '', category: '', description: '', allergens: [] };
    const categories = useAppStore.getState().siteSettings.getMenuCategories();
    const currentAllergens = itemData.allergens || [];

    // FIX: Variable name must be modalHTML
    const modalHTML = `
        <div class="modal-form-container">
            <h3>${isEditing ? 'Edit Item' : 'Add New Item'}</h3>
            <form id="edit-item-form">
                <div class="form-row">
                    <label>Name</label>
                    <input type="text" name="name" value="${itemData.name}" required>
                </div>
                <div class="form-row">
                    <label>Price ($)</label>
                    <input type="number" name="price" value="${itemData.price}" step="0.01" required>
                </div>
                <div class="form-row">
                    <label>Category</label>
                    <select name="category" required>
                        <option value="">Select Category...</option>
                        ${categories.map(cat => `<option value="${cat}" ${itemData.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                    </select>
                </div>
                <div class="form-row">
                    <label>Description</label>
                    <textarea name="description">${itemData.description || ''}</textarea>
                </div>

                <div class="form-group" style="background:#f9f9f9; padding:10px; border-radius:5px; margin-top:10px;">
                    <label style="margin-bottom:8px;">Dietary Tags</label>
                    <div style="display:flex; gap:15px; flex-wrap:wrap;">
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="allergen" value="GF" ${currentAllergens.includes('GF') ? 'checked' : ''}> Gluten Free
                        </label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="allergen" value="V" ${currentAllergens.includes('V') ? 'checked' : ''}> Vegetarian
                        </label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="allergen" value="VG" ${currentAllergens.includes('VG') ? 'checked' : ''}> Vegan
                        </label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;">
                            <input type="checkbox" name="allergen" value="DF" ${currentAllergens.includes('DF') ? 'checked' : ''}> Dairy Free
                        </label>
                    </div>
                </div>

                <div class="form-actions-split" style="justify-content: flex-end; margin-top:20px;">
                    <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
                </div>
            </form>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    document.getElementById('edit-item-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Saving...";

        const formData = new FormData(e.target);
        const selectedAllergens = [];
        e.target.querySelectorAll('input[name="allergen"]:checked').forEach(cb => selectedAllergens.push(cb.value));

        const newItemData = {
            name: formData.get('name'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            description: formData.get('description'),
            allergens: selectedAllergens
        };

        const { data: { session } } = await supabase.auth.getSession();
        
        try {
            if (isEditing) {
                await api.updateMenuItem(item.id, newItemData, session.access_token);
            } else {
                await useAppStore.getState().menu.addMenuItemOptimistic(newItemData, session.access_token);
            }
            uiUtils.showToast('Item saved successfully!', 'success');
            uiUtils.closeModal();
            useAppStore.getState().menu.fetchMenu(); 
        } catch (err) {
            console.error(err);
            uiUtils.showToast('Failed to save item.', 'error');
            btn.disabled = false;
        }
    });
}



// --- NEW: User Edit Modal (Migrated from godDashboard) ---
export function showEditUserModal(user) {
    const modalHTML = `
        <div class="modal-form-container">
            <h3>Edit User: ${user.email}</h3>
            <form id="edit-user-form">
                <div class="form-row">
                    <label>Role</label>
                    <select id="user-role">
                        <option value="customer" ${user.role === 'customer' ? 'selected' : ''}>Customer</option>
                        <option value="owner" ${user.role === 'owner' ? 'selected' : ''}>Owner</option>
                        <option value="god" ${user.role === 'god' ? 'selected' : ''}>God (God)</option>
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
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newRole = document.getElementById('user-role').value;
        const isVerified = document.getElementById('is-verified').checked;
        const canSeeOrders = document.getElementById('can-see-orders').checked;
        
        await useAppStore.getState().admin.updateUserRole(user.id, newRole, isVerified, canSeeOrders);
        uiUtils.closeModal();
        uiUtils.showToast(`User updated.`, 'success');
    });
}