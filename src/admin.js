// admin.js
import * as ui from './ui.js'; 


const admin = {
    async renderOwnerDashboard() {
        ui.setLoading(true);
        let html = `<div class="dashboard-section"><h2>Owner Dashboard</h2>`;


        
        // Orders Management (simplified)
        html += `<h3>Recent Orders</h3><div id="orders-list">Loading orders...</div>`;
        // Menu Management
        html += `
            <h3>Menu Management</h3>
            <div id="menu-items-management">Loading menu items...</div>
            <h4>Add New Menu Item</h4>
            <form id="add-menu-item-form">
                <div><label>Name: <input type="text" name="name" required></label></div>
                <div><label>Description: <textarea name="description"></textarea></label></div>
                <div><label>Price: <input type="number" name="price" step="0.01" required></label></div>
                <div><label>Category: <input type="text" name="category"></label></div>
                <div><label>Image URL: <input type="text" name="image_url" placeholder="e.g., /images/new-item.jpg or https://..."></label></div>
                <!-- For image upload with Supabase Storage:
                <div><label>Image File: <input type="file" name="image_file" accept="image/*"></label></div>
                -->
                <button type="submit">Add Item</button>
            </form>
        `;
        
 const currentFaviconSettings = await loadFaviconSettings(); // This will come from site_settings DB

    html += getFaviconSettingsHTML(currentFaviconSettings);

    html += `</div>`; // close main dashboard-section
    ui.renderPage(html);
        await this.loadOrdersForOwner();
        await this.loadMenuItemsForOwner();
        
        document.getElementById('add-menu-item-form')?.addEventListener('submit', this.handleAddMenuItem);



                
        attachFaviconSettingsListeners(); // New function to handle favicon UI listeners
    updateFaviconPreview(currentFaviconSettings); // Update preview on load

    ui.setLoading(false);
    },

    async loadOrdersForOwner() {
        const ordersListDiv = document.getElementById('orders-list');
        try {
            const orders = await api.getOrders(); // This API needs to be secured
            if (orders && orders.length > 0) {
                let ordersHtml = '<ul>';
                orders.forEach(order => {
                    ordersHtml += `<li>Order #${order.id} - Customer: ${order.customer_name || order.customer_email} - Total: $${parseFloat(order.total_amount).toFixed(2)} - Status: ${order.status} - Pickup: ${new Date(order.pickup_time).toLocaleString()}</li>`;
                });
                ordersHtml += '</ul>';
                ordersListDiv.innerHTML = ordersHtml;
            } else {
                ordersListDiv.innerHTML = '<p>No orders yet.</p>';
            }
        } catch (error) {
            ordersListDiv.innerHTML = `<p>Error loading orders: ${error.message}</p>`;
        }
    },

    async loadMenuItemsForOwner() {
        const menuManagementDiv = document.getElementById('menu-items-management');
        try {
            const items = await api.getMenu(); // Same public endpoint, but now we add edit/delete
            if (items && items.length > 0) {
                let itemsHtml = '<ul>';
                items.forEach(item => {
                    itemsHtml += `
                        <li data-id="${item.id}">
                            ${item.name} - $${parseFloat(item.price).toFixed(2)}
                            <button class="edit-item-btn" data-id="${item.id}">Edit</button>
                            <button class="delete-item-btn" data-id="${item.id}">Delete</button>
                            <div class="edit-form-container" style="display:none;"></div>
                        </li>`;
                });
                itemsHtml += '</ul>';
                menuManagementDiv.innerHTML = itemsHtml;

                document.querySelectorAll('.edit-item-btn').forEach(btn => btn.addEventListener('click', (e) => this.showEditMenuItemForm(e.target.dataset.id, items)));
                document.querySelectorAll('.delete-item-btn').forEach(btn => btn.addEventListener('click', (e) => this.handleDeleteMenuItem(e.target.dataset.id)));
            } else {
                menuManagementDiv.innerHTML = '<p>No menu items to manage. Add one below.</p>';
            }
        } catch (error) {
            menuManagementDiv.innerHTML = `<p>Error loading menu items: ${error.message}</p>`;
        }
    },
    
    handleAddMenuItem: async (event) => {
        event.preventDefault();
        const form = event.target;
        const formData = new FormData(form);
        // const imageFile = formData.get('image_file'); // If using file upload
        
        const newItemData = {
            name: formData.get('name'),
            description: formData.get('description'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            image_url: formData.get('image_url'), // Handle file upload separately if used
        };

        // TODO: Image Upload Logic with Supabase Storage if imageFile is present
        // 1. Upload imageFile to Supabase Storage.
        // 2. Get the public URL.
        // 3. Set newItemData.image_url = publicURL.
        // Example (pseudo-code, requires Supabase client instance with auth):
        // if (imageFile && imageFile.name) {
        //     const fileName = `${Date.now()}-${imageFile.name}`;
        //     const { data, error } = await supabase.storage.from('menu-images').upload(fileName, imageFile);
        //     if (error) throw error;
        //     const { data: { publicUrl } } = supabase.storage.from('menu-images').getPublicUrl(fileName);
        //     newItemData.image_url = publicUrl;
        // }

        try {
            await api.addMenuItem(newItemData);
            alert('Menu item added successfully!');
            form.reset();
            admin.loadMenuItemsForOwner(); // Refresh list
        } catch (error) {
            alert(`Error adding item: ${error.message}`);
        }
    },

    showEditMenuItemForm(itemId, allItems) {
        const item = allItems.find(i => i.id.toString() === itemId.toString());
        if (!item) return;

        const container = document.querySelector(`li[data-id="${itemId}"] .edit-form-container`);
        container.innerHTML = `
            <form class="edit-menu-item-form" data-id="${itemId}">
                <input type="hidden" name="id" value="${item.id}">
                <div><label>Name: <input type="text" name="name" value="${item.name}" required></label></div>
                <div><label>Description: <textarea name="description">${item.description || ''}</textarea></label></div>
                <div><label>Price: <input type="number" name="price" step="0.01" value="${parseFloat(item.price).toFixed(2)}" required></label></div>
                <div><label>Category: <input type="text" name="category" value="${item.category || ''}"></label></div>
                <div><label>Image URL: <input type="text" name="image_url" value="${item.image_url || ''}"></label></div>
                <button type="submit">Save Changes</button>
                <button type="button" class="cancel-edit-btn">Cancel</button>
            </form>
        `;
        container.style.display = 'block';
        container.querySelector('.edit-menu-item-form').addEventListener('submit', this.handleUpdateMenuItem);
        container.querySelector('.cancel-edit-btn').addEventListener('click', () => container.style.display = 'none');
    },

    handleUpdateMenuItem: async (event) => {
        event.preventDefault();
        const form = event.target;
        const itemId = form.dataset.id;
        const formData = new FormData(form);
        const updatedItemData = {
            name: formData.get('name'),
            description: formData.get('description'),
            price: parseFloat(formData.get('price')),
            category: formData.get('category'),
            image_url: formData.get('image_url'),
        };

        try {
            await api.updateMenuItem(itemId, updatedItemData);
            alert('Menu item updated successfully!');
            admin.loadMenuItemsForOwner(); // Refresh list
        } catch (error) {
            alert(`Error updating item: ${error.message}`);
        }
    },

    handleDeleteMenuItem: async (itemId) => {
        if (!confirm('Are you sure you want to delete this menu item?')) return;
        try {
            await api.deleteMenuItem(itemId);
            alert('Menu item deleted successfully!');
            admin.loadMenuItemsForOwner(); // Refresh list
        } catch (error) {
            alert(`Error deleting item: ${error.message}`);
        }
    },

    async renderManagerDashboard() {
        ui.setLoading(true);
        let html = `<div class="dashboard-section"><h2>Manager Dashboard</h2>`;
        
        // Site Settings
        html += `<h3>Site Settings</h3>`;
        html += `<form id="site-settings-form">
                    <div>
                        <label for="website-name">Website Name:</label>
                        <input type="text" id="website-name" name="websiteName">
                    </div>
                    <button type="submit">Save Site Name</button>
                 </form>`;
        
        // CSS Theme/Variable Editor
        html += `<div class="theme-controls">
                    ${ui.getThemeControlsHTML()}
                 </div>`;

        // DB Switcher (Conceptual)
        html += `
            <h3>Database Provider</h3>
            <p>Current: <strong id="current-db-provider">Unknown</strong> (Requires API endpoint to report this)</p>
            <label for="db-provider-select">Switch To:</label>
            <select id="db-provider-select">
                <option value="supabase">Supabase</option>
                <option value="turso" disabled>Turso (Requires Setup)</option> 
            </select>
            <button id="switch-db-btn">Apply Switch (Requires Redeploy)</button>
            <p><small>Note: Switching databases is a significant operation and may require a manual Vercel redeploy for changes to take effect if environment variables are used for connection.</small></p>
        `;
        html += `</div>`; // close dashboard-section
        ui.renderPage(html);

        await this.loadManagerSiteSettings();
        
        document.getElementById('site-settings-form')?.addEventListener('submit', this.handleSaveSiteSettings);
        document.getElementById('save-theme-settings')?.addEventListener('click', this.handleSaveThemeSettings);
        document.getElementById('switch-db-btn')?.addEventListener('click', this.handleDbSwitch); // Basic idea

        ui.setLoading(false);
    },

    async loadManagerSiteSettings() {
        try {
            const settings = await api.getSiteSettings();
            if (settings.websiteName) {
                document.getElementById('website-name').value = settings.websiteName;
            }
            if (settings.themeVariables) {
                 Object.entries(settings.themeVariables).forEach(([key, value]) => {
                    const input = document.querySelector(`.theme-controls input[data-css-var="${key}"]`);
                    if (input) input.value = value;
                });
            }
            // Update current DB provider display (this needs an API that returns current setting)
            document.getElementById('current-db-provider').textContent = settings.currentDbProvider || 'Supabase (Default)';
            const selectDb = document.getElementById('db-provider-select');
            if(selectDb && settings.currentDbProvider) selectDb.value = settings.currentDbProvider;

        } catch (error) {
            console.error("Failed to load site settings for manager:", error);
            alert("Could not load site settings.");
        }
    },

    handleSaveSiteSettings: async (event) => {
        event.preventDefault();
        const newName = document.getElementById('website-name').value;
        try {
            await api.updateSiteSettings({ websiteName: newName });
            ui.updateSiteTitles(newName); // Update live on page
            alert('Website name updated successfully!');
        } catch (error) {
            alert(`Error updating site name: ${error.message}`);
        }
    },

    handleSaveThemeSettings: async () => {
        const themeVariables = {};
        document.querySelectorAll('.theme-controls input[data-css-var]').forEach(input => {
            themeVariables[input.dataset.cssVar] = input.value;
        });
        try {
            await api.updateSiteSettings({ themeVariables });
            alert('Theme settings saved! Applied live and will persist.');
        } catch (error) {
            alert(`Error saving theme settings: ${error.message}`);
        }
    },
    handleDbSwitch: async () => {
        const selectedProvider = document.getElementById('db-provider-select').value;
        if (!confirm(`Are you sure you want to switch the active database to ${selectedProvider}? This is a major change and may require a redeploy.`)) {
            return;
        }
        try {
            // This API endpoint would set an environment variable or a flag in a persistent config.
            // Vercel usually picks up new env vars on a new deployment.
            // A true 'hot swap' without redeploy is much more complex.
            await api.updateSiteSettings({ targetDbProvider: selectedProvider }); 
            alert(`Database switch initiated to ${selectedProvider}. A redeploy might be necessary for changes to take full effect.`);
            // You might force a Vercel redeploy via API if you have a deploy hook.
            admin.loadManagerSiteSettings(); // Refresh displayed current provider
        } catch (error) {
            alert(`Error switching database provider: ${error.message}`);
        }   
        

    }






};

window.admin = admin;






function attachFaviconSettingsListeners() {
    const form = document.getElementById('favicon-settings-form');
    if (!form) return;

    form.addEventListener('submit', handleSaveFaviconSettings);

    const radios = form.querySelectorAll('input[name="faviconType"]');
    const textOptions = document.getElementById('text-favicon-options');
    const imageOptions = document.getElementById('image-favicon-options');

    radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (textOptions) textOptions.style.display = e.target.value === 'text' ? 'block' : 'none';
            if (imageOptions) imageOptions.style.display = e.target.value === 'image' ? 'block' : 'none';
            // Trigger a preview update when type changes
            const previewData = getPreviewDataFromForm();
            updateFaviconPreview(previewData);
        });
    });

    const previewButton = document.getElementById('preview-text-favicon');
    if (previewButton) {
        previewButton.addEventListener('click', () => {
             const previewData = getPreviewDataFromForm();
             updateFaviconPreview(previewData);
        });
    }

    // Live preview for text favicon inputs
    ['favicon-text', 'favicon-text-bg-color', 'favicon-text-color'].forEach(id => {
        const input = document.getElementById(id);
        if(input) {
            input.addEventListener('input', () => {
                 if(document.querySelector('input[name="faviconType"]:checked')?.value === 'text') {
                    const previewData = getPreviewDataFromForm();
                    updateFaviconPreview(previewData);
                 }
            });
        }
    });

    const imageUploadInput = document.getElementById('favicon-image-upload');
    if(imageUploadInput){
        imageUploadInput.addEventListener('change', (event) => {
            if (event.target.files && event.target.files[0]) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    // Preview the uploaded image directly as a data URL
                    const previewImg = document.getElementById('favicon-preview-img');
                    if(previewImg) {
                        previewImg.src = e.target.result;
                        previewImg.style.backgroundColor = ''; // Clear background for image
                    }
                }
                reader.readAsDataURL(event.target.files[0]);
            }
        });
    }
}

function getPreviewDataFromForm() {
    const form = document.getElementById('favicon-settings-form');
    if(!form) return { type: 'default' };

    const type = form.faviconType.value;
    if (type === 'text') {
        return {
            type: 'text',
            text: document.getElementById('favicon-text').value || 'R',
            bgColor: document.getElementById('favicon-text-bg-color').value,
            textColor: document.getElementById('favicon-text-color').value,
        };
    } else if (type === 'image') {
        // For image type during preview from form, we might only have local file.
        // The actual save will upload it and get a URL.
        // Here, we just signal it's an image. Actual image data handled by imageUploadInput listener.
        return { type: 'image' }; // Simplified for now; updateFaviconPreview will look at image-preview-img
    }
    return { type: 'default' };
}



// Add this function or integrate its HTML into renderOwnerDashboard
function getFaviconSettingsHTML(currentFaviconSettings) {
    // currentFaviconSettings could be an object like:
    // { type: 'text', text: 'R', bgColor: '#FF0000', textColor: '#FFFFFF' }
    // or { type: 'image', url: 'https://url.to/image.png' }
    // or { type: 'default' }

    let textFaviconText = currentFaviconSettings?.type === 'text' ? currentFaviconSettings.text : 'R';
    let textFaviconBgColor = currentFaviconSettings?.type === 'text' ? currentFaviconSettings.bgColor : '#3498db';
    let textFaviconTextColor = currentFaviconSettings?.type === 'text' ? currentFaviconSettings.textColor : '#ffffff';
    let currentImageUrl = currentFaviconSettings?.type === 'image' ? currentFaviconSettings.url : '';

    return `
        <div class="dashboard-section">
            <h3>Favicon Settings</h3>
            <form id="favicon-settings-form">
                <p>Choose your favicon type:</p>
                <div>
                    <input type="radio" id="favicon-type-default" name="faviconType" value="default" ${(!currentFaviconSettings || currentFaviconSettings?.type === 'default') ? 'checked' : ''}>
                    <label for="favicon-type-default">Use Default Coffee Cup</label>
                </div>

                <div>
                    <input type="radio" id="favicon-type-text" name="faviconType" value="text" ${currentFaviconSettings?.type === 'text' ? 'checked' : ''}>
                    <label for="favicon-type-text">Generate from Text (1-2 Characters Recommended)</label>
                    <div id="text-favicon-options" style="margin-left: 20px; display: ${currentFaviconSettings?.type === 'text' ? 'block' : 'none'};">
                        <label for="favicon-text">Text:</label>
                        <input type="text" id="favicon-text" name="faviconText" value="${textFaviconText}" maxlength="2" style="width: 50px;">
                        <br>
                        <label for="favicon-text-bg-color">Background Color:</label>
                        <input type="color" id="favicon-text-bg-color" name="faviconTextBgColor" value="${textFaviconBgColor}">
                        <br>
                        <label for="favicon-text-color">Text Color:</label>
                        <input type="color" id="favicon-text-color" name="faviconTextColor" value="${textFaviconTextColor}">
                        <br>
                        <button type="button" id="preview-text-favicon">Preview Text Favicon</button>
                    </div>
                </div>

                <div>
                    <input type="radio" id="favicon-type-image" name="faviconType" value="image" ${currentFaviconSettings?.type === 'image' ? 'checked' : ''}>
                    <label for="favicon-type-image">Upload Image (Square .png, .ico, or .svg recommended)</label>
                    <div id="image-favicon-options" style="margin-left: 20px; display: ${currentFaviconSettings?.type === 'image' ? 'block' : 'none'};">
                        <input type="file" id="favicon-image-upload" name="faviconImageFile" accept="image/png, image/x-icon, image/svg+xml, image/jpeg">
                        <p>Current image: <span id="current-favicon-image-url">${currentImageUrl || 'None'}</span></p>
                        <p><small>Note: Uploading a new image will replace the current one. Images are stored in Supabase Storage.</small></p>
                    </div>
                </div>
                <div style="margin-top:20px;">
                    <button type="submit">Save Favicon Settings</button>
                </div>
            </form>
            <div style="margin-top:10px;">
                Preview: <img id="favicon-preview-img" src="/default-favicon.svg" alt="Favicon Preview" width="32" height="32" style="border:1px solid #ccc; vertical-align:middle;">
            </div>
        </div>
    `;
}



// src/admin.js

// Function to call from renderOwnerDashboard
async function loadFaviconSettings() {
    try {
        const settings = await api.getSiteSettings(); // Your existing function
        return settings.faviconConfig || { type: 'default' }; // Return default if not set
    } catch (error) {
        console.error("Failed to load site settings for favicon:", error);
        return { type: 'default' };
    }
}


async function handleSaveFaviconSettings(event) {
    event.preventDefault();
    const form = event.target;
    const faviconType = form.faviconType.value;
    let newFaviconConfig = { type: faviconType };
    let imageFile = null;

    if (faviconType === 'text') {
        newFaviconConfig.text = document.getElementById('favicon-text').value;
        newFaviconConfig.bgColor = document.getElementById('favicon-text-bg-color').value;
        newFaviconConfig.textColor = document.getElementById('favicon-text-color').value;
    } else if (faviconType === 'image') {
        const imageUploadInput = document.getElementById('favicon-image-upload');
        if (imageUploadInput.files && imageUploadInput.files[0]) {
            imageFile = imageUploadInput.files[0];
            // We'll handle upload in the API for now via base64
        } else {
            // If no new image, but type is image, try to keep existing image URL
            const currentSettings = await loadFaviconSettings(); // Fetch again to be sure
            if (currentSettings.type === 'image' && currentSettings.url) {
                newFaviconConfig.url = currentSettings.url;
            } else {
                 alert("Please select an image file to upload for the image favicon type.");
                 return; // Or revert to default/previous type
            }
        }
    }
    // For 'default', newFaviconConfig is just { type: 'default' }

    try {
        let payload = { faviconConfig: newFaviconConfig };

        if (imageFile) {
            // Convert file to base64 to send to API
            // This is simple but not for large files. Favicons are tiny.
            const reader = new FileReader();
            reader.onload = async (e) => {
                payload.faviconImageFileBase64 = e.target.result; // data:image/png;base64,...
                payload.faviconImageFileName = imageFile.name;
                
                const response = await api.updateSiteSettings(payload);
                if (response.updatedFaviconConfig) { // API should return the processed config, esp. for new image URLs
                    ui.updateLiveFavicon(
                        response.updatedFaviconConfig.type === 'image' ? response.updatedFaviconConfig.url :
                        response.updatedFaviconConfig.type === 'text' ? ui.generateTextFaviconDataUrl(response.updatedFaviconConfig.text, response.updatedFaviconConfig.bgColor, response.updatedFaviconConfig.textColor) :
                        '/default-favicon.svg'
                    );
                     // Also update the preview in the form
                    ui.updateFaviconPreview(response.updatedFaviconConfig);
                    const currentImageUrlSpan = document.getElementById('current-favicon-image-url');
                    if (currentImageUrlSpan && response.updatedFaviconConfig.type === 'image') {
                        currentImageUrlSpan.textContent = response.updatedFaviconConfig.url;
                    }
                }
                alert('Favicon settings saved!');
            };
            reader.onerror = (error) => {
                 console.error("Error reading image file:", error);
                 alert("Error processing image file.");
            };
            reader.readAsDataURL(imageFile);
        } else {
            // No new image file to upload, just save config
            const response = await api.updateSiteSettings(payload);
             if (response.updatedFaviconConfig) {
                 ui.updateLiveFavicon(
                    response.updatedFaviconConfig.type === 'image' ? response.updatedFaviconConfig.url :
                    response.updatedFaviconConfig.type === 'text' ? ui.generateTextFaviconDataUrl(response.updatedFaviconConfig.text, response.updatedFaviconConfig.bgColor, response.updatedFaviconConfig.textColor) :
                    '/default-favicon.svg'
                );
                ui.updateFaviconPreview(response.updatedFaviconConfig); // Also update preview
             }
            alert('Favicon settings saved!');
        }

    } catch (error) {
        console.error('Failed to save favicon settings:', error);
        alert(`Error: ${error.message}`);
    }
}