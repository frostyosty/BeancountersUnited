// src/features/admin/modals/itemModal.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';

// --- 1. DYNAMIC OPTION CONFIGURATION ---
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
    "General": [] // Always show if nothing else matches specific logic
};

// --- 2. LOGIC HELPERS ---
function getGroupsForCategory(categoryName) {
    const cat = (categoryName || "").toLowerCase();
    if (!cat) return ["General"];
    
    const activeGroups = [];
    Object.entries(LOGIC_RULES).forEach(([groupName, keywords]) => {
        if (keywords.length === 0) { activeGroups.push(groupName); return; }
        if (keywords.some(k => cat.includes(k))) activeGroups.push(groupName);
    });
    
    // Fallback: If only general matched, or nothing, maybe show all (user override available in UI)
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

// --- 3. MAIN MODAL FUNCTION ---
export function showEditItemModal(item) {
    const isEditing = !!item;
    const itemData = item || { name: '', price: '', category: '', description: '', allergens: [], available_options: [] };
    const categories = useAppStore.getState().siteSettings.getMenuCategories();
    const currentAllergens = itemData.allergens || [];
    const currentOptions = itemData.available_options || [];

    // Calculate Initial Options based on current category
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

                <!-- Delivery Tags -->
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-top:10px;">
                    <div class="form-row">
                        <label>Prep Time (mins)</label>
                        <input type="number" name="prep_time" value="${itemData.prep_time || 5}" min="1">
                        <small style="color:#888; font-size:0.75rem;">Time to make 1 unit</small>
                    </div>
                    <div class="form-row">
                        <label>Delivery Padding (mins)</label>
                        <input type="number" name="delivery_extra_time" value="${itemData.delivery_extra_time || 0}" min="0">
                        <small style="color:#888; font-size:0.75rem;">Extra time if delivered</small>
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

    // --- DYNAMIC LOGIC ---
    const catSelect = document.getElementById('item-category-select');
    const optionsContainer = document.getElementById('dynamic-options-container');
    const forceToggle = document.getElementById('force-show-all');

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
        const currentlyChecked = Array.from(optionsContainer.querySelectorAll('input:checked')).map(i => i.value);
        const allChecked = [...new Set([...currentOptions, ...currentlyChecked])];

        optionsContainer.innerHTML = renderOptionsHTML(groupsToShow, allChecked);
    };

    catSelect.addEventListener('change', refreshOptions);
    forceToggle.addEventListener('change', refreshOptions);

    // --- SAVE LOGIC ---
    document.getElementById('edit-item-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.disabled = true; btn.textContent = "Saving...";
        const formData = new FormData(e.target);
        
        const selectedAllergens = [];
        e.target.querySelectorAll('input[name="allergen"]:checked').forEach(cb => selectedAllergens.push(cb.value));

        const selectedOptions = [];
        // Only save options that are currently VISIBLE and CHECKED
        optionsContainer.querySelectorAll('input[name="option_tag"]:checked').forEach(cb => selectedOptions.push(cb.value));

        const newItemData = {
            name: formData.get('name'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            description: formData.get('description'),
            prep_time: parseInt(formData.get('prep_time')) || 5,
            delivery_extra_time: parseInt(formData.get('delivery_extra_time')) || 0,
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
            console.error(err);
            uiUtils.showToast('Failed to save.', 'error');
            btn.disabled = false;
        }
    });
}