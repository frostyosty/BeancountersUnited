// src/features/admin/adminModals.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';

// --- 1. DEFINITIONS ---

// The Options
const OPTION_GROUPS = {
    "Milk Alternatives": [
        "Soy Milk", "Almond Milk", "Oat Milk", "Coconut Milk", "Lactose Free"
    ],
    "Coffee Adjustments": [
        "Extra Hot", "Warm", "Decaf", "Weak", "Strong", 
        "Double Shot", "Ristretto", "Long Pour"
    ],
    "Syrups & Sweeteners": [
        "Vanilla", "Caramel", "Hazelnut", "No Sugar", "1 Sugar", "2 Sugars"
    ],
    "Food Modifications": [
        "Toasted", "Fresh (Not Toasted)", "No Butter", "Extra Butter", 
        "No Sauce", "Tomato Sauce", "BBQ Sauce", "Mayo", "Salt & Pepper"
    ],
    "General": [
        "Takeaway Cup", "Dine-in", "No Chocolate", "Extra Chocolate", "Cinnamon"
    ]
};

// The Logic: Which keywords trigger which groups?
// If the category name contains ANY of these words, the group is shown.
const LOGIC_RULES = {
    "Milk Alternatives": ["coffee", "latte", "flat", "cappuccino", "mocha", "tea", "chai", "drink", "beverage", "hot", "iced", "shake", "smoothie"],
    "Coffee Adjustments": ["coffee", "latte", "flat", "cappuccino", "mocha", "espresso", "long black", "hot", "piccolo", "macchiato"],
    "Syrups & Sweeteners": ["coffee", "latte", "tea", "chai", "iced", "shake", "smoothie", "chocolate"],
    "Food Modifications": ["sandwich", "toast", "burger", "panini", "croissant", "bagel", "roll", "lunch", "breakfast", "food", "pastry", "bakery", "snack"],
    "General": [] // Empty array = Always show (or fallback)
};

// --- 2. LOGIC HELPER ---
function getGroupsForCategory(categoryName) {
    const cat = (categoryName || "").toLowerCase();
    
    // If no category selected, show nothing (or General)
    if (!cat) return ["General"];

    const activeGroups = [];

    // Check each group against the rules
    Object.entries(LOGIC_RULES).forEach(([groupName, keywords]) => {
        // Rule 1: If keywords array is empty, it's a "General" group, usually safe to show
        if (keywords.length === 0) {
            activeGroups.push(groupName);
            return;
        }

        // Rule 2: Check for keyword match
        const isMatch = keywords.some(keyword => cat.includes(keyword));
        if (isMatch) {
            activeGroups.push(groupName);
        }
    });

    // Fallback: If absolutely no groups matched (e.g. category "Specials"), show EVERYTHING just in case
    // so the user isn't locked out.
    if (activeGroups.length <= 1 && activeGroups.includes("General")) {
        return Object.keys(OPTION_GROUPS);
    }

    return activeGroups;
}

// --- 3. RENDER HELPER ---
function renderOptionsHTML(activeGroups, currentOptions) {
    return activeGroups.map(groupName => {
        const options = OPTION_GROUPS[groupName];
        if (!options) return '';

        const checkboxes = options.map(opt => `
            <label style="font-weight:normal; display:flex; gap:6px; align-items:center; cursor:pointer; margin-bottom:4px; font-size:0.9rem; color:#444;">
                <input type="checkbox" name="option_tag" value="${opt}" ${currentOptions.includes(opt) ? 'checked' : ''}> 
                ${opt}
            </label>
        `).join('');

        return `
            <div style="flex: 1 1 45%; margin-bottom:15px; min-width: 140px; border:1px solid #eee; padding:10px; border-radius:4px; background:white;">
                <h5 style="margin:0 0 8px 0; color:var(--primary-color); font-size:0.85rem; border-bottom:1px solid #eee; padding-bottom:4px; text-transform:uppercase;">${groupName}</h5>
                <div style="display:flex; flex-direction:column;">${checkboxes}</div>
            </div>
        `;
    }).join('');
}


// --- 4. MODAL FUNCTION ---
export function showEditItemModal(item) {
    const isEditing = !!item;
    const itemData = item || { name: '', price: '', category: '', description: '', allergens: [], available_options: [] };
    const categories = useAppStore.getState().siteSettings.getMenuCategories();
    const currentAllergens = itemData.allergens || [];
    const currentOptions = itemData.available_options || [];

    // Initial Render Calculation
    const initialGroups = getGroupsForCategory(itemData.category);
    const initialOptionsHTML = renderOptionsHTML(initialGroups, currentOptions);

    const modalHTML = `
        <div class="modal-form-container" style="max-width: 800px;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #eee; padding-bottom:15px; margin-bottom:20px;">
                <h3 style="margin:0;">${isEditing ? 'Edit Item' : 'Add New Item'}</h3>
                <!-- Override Toggle -->
                <label style="font-size:0.8rem; display:flex; gap:5px; align-items:center; cursor:pointer;">
                    <input type="checkbox" id="force-show-all"> Show All Options
                </label>
            </div>

            <form id="edit-item-form">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
                    <!-- LEFT COLUMN: Basics -->
                    <div>
                        <div class="form-row">
                            <label>Name</label>
                            <input type="text" name="name" value="${itemData.name}" required>
                        </div>
                        <div class="form-row">
                            <label>Category (Triggers Options)</label>
                            <select name="category" id="item-category-select" required>
                                <option value="">Select Category...</option>
                                ${categories.map(cat => `<option value="${cat}" ${itemData.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-row">
                            <label>Price ($)</label>
                            <input type="number" name="price" value="${itemData.price}" step="0.01" required>
                        </div>
                        <div class="form-row">
                            <label>Description</label>
                            <textarea name="description" style="height:80px;">${itemData.description || ''}</textarea>
                        </div>
                    </div>

                    <!-- RIGHT COLUMN: Options (Dynamic) -->
                    <div style="background:#f8f9fa; padding:15px; border-radius:6px; border:1px solid #e9ecef; display:flex; flex-direction:column;">
                        <label style="margin-bottom:10px; display:block; font-weight:bold;">Customizations</label>
                        
                        <!-- Options Container -->
                        <div id="dynamic-options-container" style="display:flex; flex-wrap:wrap; gap:10px; max-height:400px; overflow-y:auto;">
                            ${initialOptionsHTML}
                        </div>
                    </div>
                </div>

                <!-- Dietary Tags Row -->
                <div class="form-group" style="background:#fff; border:1px solid #eee; padding:10px; border-radius:5px; margin-top:20px;">
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

    // --- DYNAMIC LOGIC ---
    const catSelect = document.getElementById('item-category-select');
    const optionsContainer = document.getElementById('dynamic-options-container');
    const forceToggle = document.getElementById('force-show-all');

    // Keep track of checked options even when they disappear from view?
    // Usually NO. If I switch from Burger to Coffee, I shouldn't keep "Tomato Sauce" checked.
    // However, to be user-friendly during edits, we will just re-render.
    
    const refreshOptions = () => {
        const cat = catSelect.value;
        const force = forceToggle.checked;
        
        let groupsToShow = [];
        if (force) {
            groupsToShow = Object.keys(OPTION_GROUPS);
        } else {
            groupsToShow = getGroupsForCategory(cat);
        }

        // Get currently checked items to preserve state if possible
        // (If switching categories, we might lose some, which is intended behavior for "Blocking")
        const currentlyChecked = Array.from(optionsContainer.querySelectorAll('input:checked')).map(i => i.value);
        
        // Merge with initial db options if we are just starting (to ensure db values show up)
        const allChecked = [...new Set([...currentOptions, ...currentlyChecked])];

        optionsContainer.innerHTML = renderOptionsHTML(groupsToShow, allChecked);
    };

    catSelect.addEventListener('change', refreshOptions);
    forceToggle.addEventListener('change', refreshOptions);

    // --- SAVE LOGIC ---
    document.getElementById('edit-item-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = "Saving...";

        const formData = new FormData(e.target);
        
        const selectedAllergens = [];
        e.target.querySelectorAll('input[name="allergen"]:checked').forEach(cb => selectedAllergens.push(cb.value));

        const selectedOptions = [];
        // Only save options that are currently VISIBLE and CHECKED
        // This effectively cleans up data if they switch category
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
            if (isEditing) {
                await api.updateMenuItem(item.id, newItemData, session.access_token);
            } else {
                await useAppStore.getState().menu.addMenuItemOptimistic(newItemData, session.access_token);
            }
            uiUtils.showToast('Item saved!', 'success');
            uiUtils.closeModal();
            useAppStore.getState().menu.fetchMenu(); 
        } catch (err) {
            console.error(err);
            uiUtils.showToast('Failed to save item.', 'error');
            btn.disabled = false;
        }
    });
}


// --- 2. EDIT ITEM MODAL ---

export function showEditItemModal(item) {
    const isEditing = !!item;
    const itemData = item || { name: '', price: '', category: '', description: '', allergens: [], available_options: [] };
    const categories = useAppStore.getState().siteSettings.getMenuCategories();
    const currentAllergens = itemData.allergens || [];
    
    // Ensure array exists
    const currentOptions = itemData.available_options || [];

    // --- GENERATE GROUPED OPTIONS HTML ---
    const groupsHTML = Object.entries(OPTION_GROUPS).map(([groupName, options]) => {
        const checkboxes = options.map(opt => `
            <label style="font-weight:normal; display:flex; gap:6px; align-items:center; cursor:pointer; margin-bottom:4px; font-size:0.9rem; color:#444;">
                <input type="checkbox" name="option_tag" value="${opt}" ${currentOptions.includes(opt) ? 'checked' : ''}> 
                ${opt}
            </label>
        `).join('');

        return `
            <div style="flex: 1 1 200px; margin-bottom:10px; min-width: 140px;">
                <h5 style="margin:0 0 5px 0; color:var(--primary-color); font-size:0.85rem; border-bottom:1px solid #ddd; padding-bottom:3px;">${groupName}</h5>
                <div style="display:flex; flex-direction:column;">${checkboxes}</div>
            </div>
        `;
    }).join('');

    const modalHTML = `
        <div class="modal-form-container" style="max-width: 700px;"> <!-- Made wider for columns -->
            <h3>${isEditing ? 'Edit Item' : 'Add New Item'}</h3>
            <form id="edit-item-form">
                
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                    <div class="form-row">
                        <label>Name</label>
                        <input type="text" name="name" value="${itemData.name}" required>
                    </div>
                    <div class="form-row">
                        <label>Category</label>
                        <select name="category" required>
                            <option value="">Select Category...</option>
                            ${categories.map(cat => `<option value="${cat}" ${itemData.category === cat ? 'selected' : ''}>${cat}</option>`).join('')}
                        </select>
                    </div>
                </div>

                <div class="form-row">
                    <label>Price ($)</label>
                    <input type="number" name="price" value="${itemData.price}" step="0.01" required style="width: 50%;">
                </div>

                <div class="form-row">
                    <label>Description</label>
                    <textarea name="description" style="height:60px;">${itemData.description || ''}</textarea>
                </div>

                <!-- OPTIONS SECTION -->
                <div class="form-group" style="background:#f8f9fa; padding:15px; border-radius:6px; margin-top:15px; border:1px solid #e9ecef;">
                    <label style="margin-bottom:10px; display:block; font-weight:bold;">Allowed Customizations</label>
                    <p style="font-size:0.8rem; color:#666; margin-top:-5px; margin-bottom:10px;">Select which options the customer can choose for this item.</p>
                    
                    <div style="display:flex; flex-wrap:wrap; gap:20px;">
                        ${groupsHTML}
                    </div>
                </div>

                <!-- DIETARY TAGS -->
                <div class="form-group" style="background:#fff; border:1px solid #eee; padding:10px; border-radius:5px; margin-top:10px;">
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

        // Collect Options
        const selectedOptions = [];
        e.target.querySelectorAll('input[name="option_tag"]:checked').forEach(cb => selectedOptions.push(cb.value));

        const newItemData = {
            name: formData.get('name'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            description: formData.get('description'),
            allergens: selectedAllergens,
            available_options: selectedOptions // Save back to DB
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

// --- 3. EDIT USER MODAL ---
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