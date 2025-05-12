// admin.js

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
        html += `</div>`; // close dashboard-section
        ui.renderPage(html);
        await this.loadOrdersForOwner();
        await this.loadMenuItemsForOwner();
        
        document.getElementById('add-menu-item-form')?.addEventListener('submit', this.handleAddMenuItem);
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