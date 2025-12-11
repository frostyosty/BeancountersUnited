import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';

// --- 1. DYNAMIC OPTION LOGIC ---
const OPTION_GROUPS = {
    "Milk Alternatives": ["Soy Milk", "Almond Milk", "Oat Milk", "Coconut Milk", "Lactose Free"],
    "Coffee Adjustments": ["Extra Hot", "Warm", "Decaf", "Weak", "Strong", "Double Shot", "Ristretto", "Long Pour"],
    "Syrups & Sweeteners": ["Vanilla", "Caramel", "Hazelnut", "No Sugar", "1 Sugar", "2 Sugars"],
    "Food Modifications": ["Toasted", "Fresh (Not Toasted)", "No Butter", "Extra Butter", "No Sauce", "Tomato Sauce", "BBQ Sauce", "Mayo", "Salt & Pepper"],
    "General": ["Takeaway Cup", "Dine-in", "No Chocolate", "Extra Chocolate", "Cinnamon"]
};

const LOGIC_RULES = {
    "Milk Alternatives": ["coffee", "latte", "flat", "cappuccino", "mocha", "tea", "chai", "drink", "beverage", "hot", "iced", "shake", "smoothie"],
    "Coffee Adjustments": ["coffee", "latte", "flat", "cappuccino", "mocha", "espresso", "long black", "hot", "piccolo", "macchiato"],
    "Syrups & Sweeteners": ["coffee", "latte", "tea", "chai", "iced", "shake", "smoothie", "chocolate"],
    "Food Modifications": ["sandwich", "toast", "burger", "panini", "croissant", "bagel", "roll", "lunch", "breakfast", "food", "pastry", "bakery", "snack"],
    "General": []
};

function getGroupsForCategory(categoryName) {
    const cat = (categoryName || "").toLowerCase();
    if (!cat) return ["General"];
    const activeGroups = [];
    Object.entries(LOGIC_RULES).forEach(([groupName, keywords]) => {
        if (keywords.length === 0) { activeGroups.push(groupName); return; }
        if (keywords.some(k => cat.includes(k))) activeGroups.push(groupName);
    });
    if (activeGroups.length <= 1 && activeGroups.includes("General")) return Object.keys(OPTION_GROUPS);
    return activeGroups;
}

function renderOptionsHTML(activeGroups, currentOptions) {
    return activeGroups.map(groupName => {
        const options = OPTION_GROUPS[groupName];
        if (!options) return '';
        const checkboxes = options.map(opt => `
            <label style="font-weight:normal; display:flex; gap:6px; align-items:center; cursor:pointer; margin-bottom:4px; font-size:0.9rem; color:#444;">
                <input type="checkbox" name="option_tag" value="${opt}" ${currentOptions.includes(opt) ? 'checked' : ''}> ${opt}
            </label>
        `).join('');
        return `
            <div style="flex: 1 1 45%; margin-bottom:15px; min-width: 140px; border:1px solid #eee; padding:10px; border-radius:4px; background:white;">
                <h5 style="margin:0 0 8px 0; color:var(--primary-color); font-size:0.85rem; border-bottom:1px solid #eee; padding-bottom:4px; text-transform:uppercase;">${groupName}</h5>
                <div style="display:flex; flex-direction:column;">${checkboxes}</div>
            </div>`;
    }).join('');
}


// --- 2. EDIT ITEM MODAL (DYNAMIC) ---
export function showEditItemModal(item) {
    const isEditing = !!item;
    const itemData = item || { name: '', price: '', category: '', description: '', allergens: [], available_options: [] };
    const categories = useAppStore.getState().siteSettings.getMenuCategories();
    const currentAllergens = itemData.allergens || [];
    const currentOptions = itemData.available_options || [];

    // Calculate Initial Options
    const initialGroups = getGroupsForCategory(itemData.category);
    const initialOptionsHTML = renderOptionsHTML(initialGroups, currentOptions);

    const modalHTML = `
        <div class="modal-form-container" style="max-width: 800px;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding-bottom:15px; margin-bottom:20px;">
                <h3 style="margin:0;">${isEditing ? 'Edit Item' : 'Add New Item'}</h3>
                <label style="font-size:0.8rem; display:flex; gap:5px; align-items:center; cursor:pointer;">
                    <input type="checkbox" id="force-show-all"> Show All Options
                </label>
            </div>

            <form id="edit-item-form">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                    <!-- LEFT COLUMN -->
                    <div>
                        <div class="form-row"><label>Name</label><input type="text" name="name" value="${itemData.name}" required></div>
                        <div class="form-row"><label>Category</label><select name="category" id="item-category-select" required><option value="">Select...</option>${categories.map(cat => `<option value="${cat}" ${itemData.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}</select></div>
                        <div class="form-row"><label>Price ($)</label><input type="number" name="price" value="${itemData.price}" step="0.01" required></div>
                        <div class="form-row"><label>Description</label><textarea name="description" style="height:80px;">${itemData.description || ''}</textarea></div>
                    </div>

                    <!-- RIGHT COLUMN: Options -->
                    <div style="background:#f8f9fa; padding:15px; border-radius:6px; border:1px solid #e9ecef; display:flex; flex-direction:column;">
                        <label style="margin-bottom:10px; display:block; font-weight:bold;">Customizations</label>
                        <div id="dynamic-options-container" style="display:flex; flex-wrap:wrap; gap:10px; max-height:400px; overflow-y:auto;">
                            ${initialOptionsHTML}
                        </div>
                    </div>
                </div>

                <!-- Dietary Tags -->
                <div class="form-group" style="background:#fff; border:1px solid #eee; padding:10px; border-radius:5px; margin-top:20px;">
                    <label style="margin-bottom:8px;">Dietary Tags</label>
                    <div style="display:flex; gap:15px; flex-wrap:wrap;">
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;"><input type="checkbox" name="allergen" value="GF" ${currentAllergens.includes('GF') ? 'checked' : ''}> Gluten Free</label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;"><input type="checkbox" name="allergen" value="V" ${currentAllergens.includes('V') ? 'checked' : ''}> Vegetarian</label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;"><input type="checkbox" name="allergen" value="VG" ${currentAllergens.includes('VG') ? 'checked' : ''}> Vegan</label>
                        <label style="font-weight:normal; display:flex; gap:5px; align-items:center; cursor:pointer;"><input type="checkbox" name="allergen" value="DF" ${currentAllergens.includes('DF') ? 'checked' : ''}> Dairy Free</label>
                    </div>
                </div>

                <div class="form-actions-split" style="justify-content: flex-end; margin-top:20px;">
                    <button type="submit" class="button-primary">${isEditing ? 'Save Changes' : 'Create Item'}</button>
                </div>
            </form>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // --- Dynamic Logic ---
    const catSelect = document.getElementById('item-category-select');
    const optionsContainer = document.getElementById('dynamic-options-container');
    const forceToggle = document.getElementById('force-show-all');

    const refreshOptions = () => {
        const cat = catSelect.value;
        const force = forceToggle.checked;
        const groupsToShow = force ? Object.keys(OPTION_GROUPS) : getGroupsForCategory(cat);
        const currentlyChecked = Array.from(optionsContainer.querySelectorAll('input:checked')).map(i => i.value);
        const allChecked = [...new Set([...currentOptions, ...currentlyChecked])];
        optionsContainer.innerHTML = renderOptionsHTML(groupsToShow, allChecked);
    };

    catSelect.addEventListener('change', refreshOptions);
    forceToggle.addEventListener('change', refreshOptions);

    // --- Save Logic ---
    document.getElementById('edit-item-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = "Saving...";
        const formData = new FormData(e.target);
        
        const selectedAllergens = [];
        e.target.querySelectorAll('input[name="allergen"]:checked').forEach(cb => selectedAllergens.push(cb.value));
        const selectedOptions = [];
        // Only save visible checked options
        optionsContainer.querySelectorAll('input[name="option_tag"]:checked').forEach(cb => selectedOptions.push(cb.value));

        const newItemData = {
            name: formData.get('name'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            description: formData.get('description'),
            allergens: selectedAllergens,
            available_options: selectedOptions
        };

        const { data: { session } } = await supabase.auth.getSession();
        try {
            if (isEditing) await api.updateMenuItem(item.id, newItemData, session.access_token);
            else await useAppStore.getState().menu.addMenuItemOptimistic(newItemData, session.access_token);
            uiUtils.showToast('Item saved!', 'success');
            uiUtils.closeModal();
            useAppStore.getState().menu.fetchMenu(); 
        } catch (err) {
            uiUtils.showToast('Failed to save.', 'error');
            btn.disabled = false;
        }
    });
}


// --- 3. CUSTOMER CRM MODAL (With Fixes) ---
export async function showCustomerCRMModal(userId, manualNameOverride = null) {
    uiUtils.showModal(`<div class="loading-spinner">Fetching Client History...</div>`);

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        const { profile, history, logs } = await api.getCustomerDetails(userId, session.access_token);

        const historyRows = history.map(order => {
            const date = new Date(order.created_at).toLocaleDateString();
            const itemsSummary = order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name}`).join(', ');
            return `<tr style="border-bottom:1px solid #eee; font-size:0.9rem;"><td style="padding:8px;">${date}</td><td style="padding:8px; color:#666;">${itemsSummary}</td><td style="padding:8px;">$${order.total_amount.toFixed(2)}</td></tr>`;
        }).join('');

        const auditRows = (logs || []).map(log => {
            const date = new Date(log.created_at).toLocaleString();
            const actorName = log.profiles?.email || 'Manager';
            let changeMsg = log.action_type;
            if (log.action_type === 'UPDATE_NICKNAME') changeMsg = `Nickname: "${log.old_value}" → "${log.new_value}"`;
            if (log.action_type === 'UPDATE_NOTE') changeMsg = `Updated Note`;
            return `<div style="padding:8px; border-bottom:1px solid #eee; font-size:0.85rem;"><div style="color:#888; font-size:0.8rem;">${date} by ${actorName}</div><div>${changeMsg}</div></div>`;
        }).join('');

        const displayName = manualNameOverride || profile.full_name || profile.email || 'Guest';
        const subText = manualNameOverride 
            ? `(Phone/Walk-in Record linked to ${profile.email})` 
            : (profile.email || 'No Email');

        const modalHTML = `
            <div class="crm-modal-container" style="min-width:350px; padding-bottom: 50px;">
                <div style="border-bottom:1px solid #eee; padding-bottom:15px; margin-bottom:15px;">
                    <h3 style="margin:0 0 5px 0;">${displayName}</h3>
                    <p style="margin:0; font-size:0.85rem; color:#666;">${subText}</p>
                    ${!manualNameOverride ? `
                    <div style="margin-top:10px; display:flex; gap:10px; align-items:center;">
                        <label style="font-size:0.9rem;">Nickname:</label>
                        <input type="text" id="crm-nickname" value="${profile.internal_nickname || ''}" placeholder="e.g. Latte John" style="padding:5px; border:1px solid #ccc; border-radius:4px; flex:1;">
                    </div>` : ''}
                </div>

                <div style="background:#f9f9f9; padding:15px; border-radius:6px; margin-bottom:20px;">
                    <label style="font-weight:bold; font-size:0.9rem; display:block; margin-bottom:5px;">Staff Note</label>
                    <textarea id="crm-note" rows="3" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">${profile.staff_note || ''}</textarea>
                    <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; gap:15px;">
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer;"><input type="radio" name="noteUrgency" value="info" ${profile.staff_note_urgency !== 'alert' ? 'checked' : ''}> Info</label>
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer; color:#d00;"><input type="radio" name="noteUrgency" value="alert" ${profile.staff_note_urgency === 'alert' ? 'checked' : ''}> Important</label>
                        </div>
                        <button id="crm-save-btn" class="button-primary small">Save</button>
                    </div>
                </div>

                <div style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <button id="tab-orders" class="button-secondary small" style="background:#ddd; color:#333;">Order History</button>
                        <button id="tab-audit" class="button-secondary small" style="background:transparent; color:#666; border:1px solid #ddd;">Audit Log</button>
                    </div>
                    <button id="crm-add-order-btn" class="button-primary small" style="padding: 4px 10px; font-weight:bold;" title="Add Past Order">+</button>
                </div>

                <div id="content-orders" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead style="background:#f5f5f5; position:sticky; top:0;">
                            <tr><th style="padding:8px; text-align:left; font-size:0.8rem;">Date</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Items</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Total</th></tr>
                        </thead>
                        <tbody>${historyRows || '<tr><td colspan="3" style="text-align:center; padding:10px;">No history</td></tr>'}</tbody>
                    </table>
                </div>

                <div id="content-audit" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px; display:none;">
                    ${auditRows || '<div style="padding:15px; text-align:center; color:#999; font-size:0.9rem;">No changes recorded.</div>'}
                </div>

                <!-- Sticky Footer -->
                <div style="position: sticky; bottom: -20px; margin: 20px -20px -20px -20px; padding: 15px; background: white; border-top: 1px solid #eee; text-align: right; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
                    <button id="crm-save-footer-btn" class="button-primary" style="width:100%;">Save Changes</button>
                </div>
            </div>
        `;

        uiUtils.showModal(modalHTML);

        // Listeners
        const tabOrders = document.getElementById('tab-orders');
        const tabAudit = document.getElementById('tab-audit');
        const contentOrders = document.getElementById('content-orders');
        const contentAudit = document.getElementById('content-audit');

        tabOrders.onclick = () => {
            contentOrders.style.display = 'block'; contentAudit.style.display = 'none';
            tabOrders.style.background = '#ddd'; tabOrders.style.color = '#333';
            tabAudit.style.background = 'transparent'; tabAudit.style.color = '#666';
        };
        tabAudit.onclick = () => {
            contentOrders.style.display = 'none'; contentAudit.style.display = 'block';
            tabAudit.style.background = '#ddd'; tabAudit.style.color = '#333';
            tabOrders.style.background = 'transparent'; tabOrders.style.color = '#666';
        };

        const saveHandler = async (e) => {
            const btn = e.target;
            btn.textContent = 'Saving...'; btn.disabled = true;
            const nicknameInput = document.getElementById('crm-nickname');
            const nickname = nicknameInput ? nicknameInput.value : null; 
            const note = document.getElementById('crm-note').value;
            const urgency = document.querySelector('input[name="noteUrgency"]:checked').value;
            try {
                await api.updateCustomerDetails({ userId, nickname: nickname !== null ? nickname : undefined, note, urgency }, session.access_token);
                uiUtils.showToast("Updated!", "success");
                useAppStore.getState().ui.triggerPageRender(); 
                setTimeout(() => { btn.textContent = 'Save Changes'; btn.disabled = false; }, 1000);
            } catch (err) { uiUtils.showToast("Failed.", "error"); btn.textContent = 'Save'; btn.disabled = false; }
        };

        document.getElementById('crm-save-btn').addEventListener('click', saveHandler);
        document.getElementById('crm-save-footer-btn').addEventListener('click', saveHandler);

        document.getElementById('crm-add-order-btn').onclick = () => {
            const targetProfile = { id: userId, full_name: profile.full_name, internal_nickname: profile.internal_nickname };
            window.showAddPastOrderModal(targetProfile);
        };

    } catch (e) {
        console.error("CRM Modal Error:", e);
        uiUtils.showModal(`<div class="error-message">Could not load client details.</div>`);
    }
}


// --- 4. EDIT USER MODAL ---
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
                        <option value="god" ${user.role === 'god' ? 'selected' : ''}>God</option>
                    </select>
                </div>
                <div class="form-row"><label style="font-weight:normal; display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="is-verified" ${user.is_verified_buyer ? 'checked' : ''} style="width:auto;"> Verified Buyer Status</label></div>
                <div class="form-row"><label style="font-weight:normal; display:flex; align-items:center; gap:10px; cursor:pointer;"><input type="checkbox" id="can-see-orders" ${user.can_see_order_history ? 'checked' : ''} style="width:auto;"> Can See Order History Tab</label></div>
                <div class="form-actions-split" style="justify-content: flex-end; margin-top: 20px;">
                    <button type="submit" class="button-primary">Save Changes</button>
                </div>
            </form>
        </div>
    `;
    
    uiUtils.showModal(modalHTML);
    
    document.getElementById('edit-user-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const newRole = document.getElementById('user-role').value;
        const isVerified = document.getElementById('is-verified').checked;
        const canSeeOrders = document.getElementById('can-see-orders').checked;
        await useAppStore.getState().admin.updateUserRole(user.id, newRole, isVerified, canSeeOrders);
        uiUtils.closeModal();
        uiUtils.showToast(`User updated.`, 'success');
    });
}

// --- 5. IMAGE EDITOR MODAL (WITH CROPPER.JS) ---
export async function showImageEditorModal(item) {
    const currentImg = item.image_url || '/placeholder-coffee.jpg';

    // 1. Load Cropper.js Dependencies if not present
    if (!window.Cropper) {
        uiUtils.showToast("Loading editor tools...", "info");
        await loadCSS('https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.css');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.js');
    }

    const modalHTML = `
        <div class="modal-form-container" style="max-width: 600px; text-align:center;">
            <h3>Edit Image: ${item.name}</h3>
            
            <!-- EDITOR CANVAS -->
            <!-- We put the background color on this wrapper div during preview -->
            <div id="cropper-wrapper" style="margin: 20px auto; width: 300px; height: 300px; background-color: transparent; overflow: hidden; border-radius: 8px; position: relative; border: 1px solid #ccc;">
                <!-- Checkerboard pattern (always behind the color) for transparency reference -->
                <div style="position: absolute; inset: 0; background-image: linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; z-index: 0; pointer-events:none;"></div>
                
                <!-- The Image -->
                <img id="img-editor-target" src="${currentImg}" crossorigin="anonymous" style="max-width: 100%; display: block; position: relative; z-index: 1;">
            </div>

            <!-- CONTROLS ROW 1: Movement -->
            <div style="display:flex; gap:10px; justify-content:center; margin-bottom:15px;">
                <button type="button" class="button-secondary small" id="btn-zoom-in" title="Zoom In">➕</button>
                <button type="button" class="button-secondary small" id="btn-zoom-out" title="Zoom Out">➖</button>
                <button type="button" class="button-secondary small" id="btn-rotate" title="Rotate">🔄</button>
                <button type="button" class="button-secondary small" id="btn-reset" title="Reset">Reset</button>
            </div>

            <!-- CONTROLS ROW 2: Background -->
            <div style="background: #f9f9f9; padding: 10px; border-radius: 8px; margin-bottom: 20px; display: inline-flex; align-items: center; gap: 15px; border: 1px solid #eee;">
                <span style="font-size: 0.9rem; font-weight: 600; color: #555;">Canvas Background:</span>
                
                <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 0.9rem;">
                    <input type="checkbox" id="bg-transparent-check" checked> Transparent
                </label>

                <div id="bg-color-picker-group" style="display:none; align-items: center; gap: 5px;">
                    <input type="color" id="bg-color-input" value="#ffffff" style="cursor: pointer; border: none; width: 30px; height: 30px; padding: 0;">
                    <span id="bg-color-val" style="font-family: monospace; font-size: 0.8rem;">#ffffff</span>
                </div>
            </div>

            <!-- UPLOAD -->
            <div id="img-drop-zone" style="border: 2px dashed #ccc; padding: 15px; border-radius: 8px; cursor: pointer; background: #fafafa; margin-bottom: 20px;">
                <p style="margin:0; font-weight:500; font-size:0.9rem;">Drag & Drop New Image</p>
                <input type="file" id="img-editor-input" accept="image/*" style="display:none;">
            </div>

            <!-- ACTIONS -->
            <div style="display: flex; gap: 10px; justify-content: center; border-top:1px solid #eee; padding-top:20px;">
                <button id="btn-remove-bg" class="button-secondary" style="background: #6f42c1; color: white;">✨ Remove Background</button>
                <button id="btn-save-img" class="button-primary">Save Changes</button>
            </div>
            
            <div id="ai-status" style="margin-top: 15px; font-size: 0.9rem; color: #666;"></div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // --- ELEMENTS ---
    const imageEl = document.getElementById('img-editor-target');
    const cropperWrapper = document.getElementById('cropper-wrapper');
    const fileInput = document.getElementById('img-editor-input');
    const dropZone = document.getElementById('img-drop-zone');
    const status = document.getElementById('ai-status');
    
    // Background controls
    const bgCheck = document.getElementById('bg-transparent-check');
    const bgGroup = document.getElementById('bg-color-picker-group');
    const bgColorInput = document.getElementById('bg-color-input');
    const bgColorVal = document.getElementById('bg-color-val');

    let cropper = null;

    // --- INIT CROPPER ---
    const initCropper = () => {
        if (cropper) cropper.destroy();
        cropper = new Cropper(imageEl, {
            aspectRatio: 1, 
            // viewMode 0 allows image to be smaller than the canvas (freely movable)
            viewMode: 0,    
            dragMode: 'move', 
            autoCropArea: 0.8,
            background: false, // Turn off default grid so our custom CSS background shows through
            checkCrossOrigin: false,
            // Ensure the crop box stays full size of the container so we capture the background
            ready: function() {
                // Optional: Force crop box to fill container if you want "What you see is what you get"
                // this.cropper.setCropBoxData({ left: 0, top: 0, width: 300, height: 300 });
            }
        });
    };

    imageEl.onload = () => initCropper();
    if (imageEl.complete) initCropper();

    // --- BACKGROUND LOGIC ---
    const updateBackground = () => {
        if (bgCheck.checked) {
            bgGroup.style.display = 'none';
            // CSS: Transparent allows the checkerboard under it to show
            // Note: We apply this to the specific Cropper element class that holds the image
            const canvasEl = document.querySelector('.cropper-canvas'); 
            if(canvasEl) canvasEl.style.backgroundColor = 'transparent';
            
            // Also update our wrapper for visual consistency
            cropperWrapper.style.backgroundColor = 'transparent';
        } else {
            bgGroup.style.display = 'flex';
            const color = bgColorInput.value;
            bgColorVal.textContent = color;
            
            // Apply color to the cropper canvas (behind the image)
            const canvasEl = document.querySelector('.cropper-canvas'); 
            if(canvasEl) canvasEl.style.backgroundColor = color;

            cropperWrapper.style.backgroundColor = color;
        }
    };

    bgCheck.addEventListener('change', updateBackground);
    bgColorInput.addEventListener('input', updateBackground);

    // --- ZOOM / ROTATE ---
    document.getElementById('btn-zoom-in').onclick = () => cropper.zoom(0.1);
    document.getElementById('btn-zoom-out').onclick = () => cropper.zoom(-0.1);
    document.getElementById('btn-rotate').onclick = () => cropper.rotate(90);
    document.getElementById('btn-reset').onclick = () => {
        cropper.reset();
        updateBackground(); // Re-apply background after reset
    };

    // --- DRAG & DROP ---
    dropZone.onclick = () => fileInput.click();
    
    const handleFile = (file) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (cropper) {
                cropper.replace(e.target.result);
                // Wait a tick for replace to finish before re-applying background styles
                setTimeout(updateBackground, 100);
            } else {
                imageEl.src = e.target.result;
                initCropper();
            }
        };
        reader.readAsDataURL(file);
        status.textContent = "New image loaded. Adjust positioning.";
    };

    fileInput.onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#4d2909'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#ccc'; };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    };

    // --- REMOVE BACKGROUND ---
    document.getElementById('btn-remove-bg').onclick = async () => {
        const btn = document.getElementById('btn-remove-bg');
        if (!cropper) return;
        const src = imageEl.src || '';
        if (src.includes('placeholder')) { uiUtils.showToast("Cannot process placeholder.", "error"); return; }

        status.innerHTML = `<span class="loading-spinner" style="font-size:1em;"></span> Processing AI removal...`;
        btn.disabled = true;

        try {
            // Get data from current view (ignoring background setting, we want raw image processing)
            // We use the original image, not the canvas, for better AI results
            const blob = await fetch(imageEl.src).then(r => r.blob());
            const url = URL.createObjectURL(blob);

            if (!window.imglyRemoveBackground) {
                await loadScript("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.3.0/dist/imgly-background-removal.min.js");
            }

            const resultBlob = await imglyRemoveBackground(url);
            const resultUrl = URL.createObjectURL(resultBlob);
            
            cropper.replace(resultUrl);
            setTimeout(updateBackground, 100); // Re-apply background settings
            
            status.textContent = "✨ Background removed!";
            uiUtils.showToast("Background removed!", "success");
        } catch (err) {
            console.error("AI Error:", err);
            status.innerHTML = `<span style="color:red">AI Error: ${err.message}</span>`;
        } finally { btn.disabled = false; }
    };

    // --- SAVE ---
    document.getElementById('btn-save-img').onclick = async () => {
        if (!cropper) return;
        const btn = document.getElementById('btn-save-img');
        btn.textContent = "Uploading..."; btn.disabled = true;

        try {
            // Determine Fill Color
            // If transparent checked, use 'transparent' (which results in PNG alpha)
            // If color picked, use that hex code.
            const fillColor = bgCheck.checked ? 'transparent' : bgColorInput.value;

            const canvas = cropper.getCroppedCanvas({ 
                width: 600, height: 600, 
                imageSmoothingEnabled: true, 
                imageSmoothingQuality: 'high',
                fillColor: fillColor // <--- THIS BAKES THE COLOR IN
            });

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const fileName = `menu-items/${item.id}-${Date.now()}.png`;

            const { error } = await supabase.storage.from('menu-images').upload(fileName, blob);
            if (error) throw error;
            
            const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
            
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateMenuItem(item.id, { image_url: data.publicUrl }, session.access_token);

            uiUtils.showToast("Image updated!", "success");
            useAppStore.getState().menu.fetchMenu();
            uiUtils.closeModal();

        } catch (err) {
            console.error(err);
            uiUtils.showToast("Save failed.", "error");
            btn.disabled = false;
            btn.textContent = "Save Changes";
        }
    };
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}
function loadCSS(href) {
    return new Promise((resolve) => {
        if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        document.head.appendChild(link);
    });
}