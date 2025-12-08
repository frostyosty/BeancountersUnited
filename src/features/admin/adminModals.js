// src/features/admin/adminModals.js
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





// --- 2. EDIT ITEM MODAL ---

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


export function showImageEditorModal(item) {
    const currentImg = item.image_url || '/placeholder-coffee.jpg';

    const modalHTML = `
        <div class="modal-form-container" style="max-width: 500px; text-align:center;">
            <h3>Edit Image: ${item.name}</h3>
            
            <div style="margin: 20px auto; width: 200px; height: 200px; border: 1px solid #ddd; background: #f0f0f0; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 8px; position: relative;">
                <!-- Checkerboard background for transparency check -->
                <div style="position: absolute; inset: 0; background-image: linear-gradient(45deg, #ccc 25%, transparent 25%), linear-gradient(-45deg, #ccc 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ccc 75%), linear-gradient(-45deg, transparent 75%, #ccc 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; opacity: 0.3; z-index: 0;"></div>
                
                <img id="img-editor-preview" src="${currentImg}" style="max-width: 100%; max-height: 100%; position: relative; z-index: 1;">
            </div>

            <div id="img-drop-zone" style="border: 2px dashed #ccc; padding: 20px; border-radius: 8px; cursor: pointer; background: #fafafa; margin-bottom: 20px;">
                <p style="margin:0; font-weight:500;">Drag & Drop New Image</p>
                <p style="margin:0; font-size:0.8rem; color:#666;">or click to upload</p>
                <input type="file" id="img-editor-input" accept="image/*" style="display:none;">
            </div>

            <div style="display: flex; gap: 10px; justify-content: center;">
                <button id="btn-remove-bg" class="button-secondary" style="background: #6f42c1; color: white;">✨ Remove Background</button>
                <button id="btn-save-img" class="button-primary">Save Changes</button>
            </div>
            
            <div id="ai-status" style="margin-top: 15px; font-size: 0.9rem; color: #666;"></div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    const preview = document.getElementById('img-editor-preview');
    const fileInput = document.getElementById('img-editor-input');
    const dropZone = document.getElementById('img-drop-zone');
    const status = document.getElementById('ai-status');
    const removeBgBtn = document.getElementById('btn-remove-bg');
    
    let pendingFile = null;

    // --- Drag & Drop Logic ---
    dropZone.onclick = () => fileInput.click();
    
    fileInput.onchange = (e) => {
        if (e.target.files[0]) handleFileSelection(e.target.files[0]);
    };
    
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#4d2909'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#ccc'; };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        if (e.dataTransfer.files[0]) handleFileSelection(e.dataTransfer.files[0]);
    };

    function handleFileSelection(file) {
        pendingFile = file;
        const reader = new FileReader();
        reader.onload = (e) => preview.src = e.target.result;
        reader.readAsDataURL(file);
        status.textContent = "New image selected. Click Save to apply.";
    }

    // --- AI Background Removal Logic ---
    removeBgBtn.onclick = async () => {
        const src = preview.src;
        if (!src || src.includes('placeholder')) {
            uiUtils.showToast("No valid image to process.", "error");
            return;
        }

        status.innerHTML = `<span class="loading-spinner" style="font-size:1em;"></span> Processing AI removal... (This may take a moment)`;
        removeBgBtn.disabled = true;

        try {
            // Dynamically load imgly from CDN
            if (!window.imglyRemoveBackground) {
                await loadScript("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.3.0/dist/imgly-background-removal.min.js");
            }

            // Process
            // Note: imgly expects a URL or Blob
            const blob = await imglyRemoveBackground(src);
            const url = URL.createObjectURL(blob);
            
            preview.src = url;
            
            // Convert Blob to File for upload
            pendingFile = new File([blob], `${item.name}-nobg.png`, { type: "image/png" });
            
            status.textContent = "✨ Background removed! Looks good? Click Save.";
            uiUtils.showToast("Background removed!", "success");

        } catch (err) {
            console.error("AI Error:", err);
            status.innerHTML = `<span style="color:red">Failed to remove background. ${err.message}</span>`;
            uiUtils.showToast("AI Removal Failed.", "error");
        } finally {
            removeBgBtn.disabled = false;
        }
    };

    // --- Save Logic ---
    document.getElementById('btn-save-img').onclick = async () => {
        if (!pendingFile) {
            uiUtils.closeModal();
            return;
        }

        status.textContent = "Uploading...";
        const btn = document.getElementById('btn-save-img');
        btn.disabled = true;

        try {
            const fileName = `menu-items/${item.id}-${Date.now()}.png`;
            const { error } = await supabase.storage.from('menu-images').upload(fileName, pendingFile);
            
            if (error) throw error;
            
            const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
            
            // Update DB
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateMenuItem(item.id, { image_url: data.publicUrl }, session.access_token);

            uiUtils.showToast("Image updated!", "success");
            useAppStore.getState().menu.fetchMenu(); // Refresh UI
            uiUtils.closeModal();

        } catch (err) {
            console.error(err);
            uiUtils.showToast("Upload failed.", "error");
            status.textContent = "Error saving image.";
            btn.disabled = false;
        }
    };
}

// Helper for dynamic script loading
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