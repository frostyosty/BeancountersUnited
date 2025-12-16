export function renderMenuSection(menuItems, sortConfig, getCategoryColor, getAllergenBadges, getSortIcon, showAllergens) {
    const isEnabled = showAllergens === true;

    const sortedItems = [...menuItems].sort((a, b) => {
        const col = sortConfig.column;
        const valA = col === 'price' ? parseFloat(a[col]) : (a[col] || '').toLowerCase();
        const valB = col === 'price' ? parseFloat(b[col]) : (b[col] || '').toLowerCase();
        if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
    });

    const rows = sortedItems.map(item => `
        <tr data-item-id="${item.id}" 
            style="background-color: ${getCategoryColor(item.category||'')}; border-bottom:1px solid #fff; cursor:pointer;"
            onclick="window.handleItemRowClick('${item.id}')">
            
            <td style="padding:10px; width:60px;" onclick="event.stopPropagation()">
                <div style="position:relative; width:40px; height:40px;">
                    <img src="${item.image_url || '/placeholder-coffee.jpg'}" 
                         class="admin-item-thumb" 
                         style="width:100%; height:100%; object-fit:cover; border-radius:4px; cursor:pointer; border:1px solid #ccc;" 
                         onclick="window.handleItemPhotoClick('${item.id}')" 
                         title="Click to Edit Photo">
                </div>
            </td>
            
            <td style="padding:10px;">
                <div style="font-weight:500;">${item.name}</div>
                <div style="margin-top:2px;">${getAllergenBadges(item.allergens)}</div>
            </td>
            <td style="padding:10px;">${item.category || 'None'}</td>
            <td style="padding:10px;">$${parseFloat(item.price).toFixed(2)}</td>
            
            <td style="padding:10px;" onclick="event.stopPropagation()">
                <button class="button-secondary small edit-item-btn-table">Edit</button>
                <button class="delete-icon-btn" title="Delete">×</button>
            </td>
        </tr>
    `).join('');

    return `
        <section class="dashboard-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3>Menu Items</h3>
                <button id="add-new-item-btn" class="button-primary">+ Add New Item</button>
            </div>
            
            <div class="table-wrapper">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="background:white; border-bottom:2px solid #ddd;">
                        <tr>
                            <th style="padding:10px;">Img</th>
                            <th class="sortable" data-sort-col="name" style="padding:10px; cursor:pointer;">Name ${getSortIcon('name')}</th>
                            <th class="sortable" data-sort-col="category" style="padding:10px; cursor:pointer;">Category ${getSortIcon('category')}</th>
                            <th class="sortable" data-sort-col="price" style="padding:10px; cursor:pointer;">Price ${getSortIcon('price')}</th>
                            <th style="padding:10px;">Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>

            <div style="margin-top:20px; padding-top:15px; border-top:1px solid #eee;">
                <form id="menu-config-form">
                    <label style="font-weight:normal; display:flex; gap:10px; align-items:center; cursor:pointer;">
                        <input type="checkbox" name="showAllergens" ${isEnabled ? 'checked' : ''}> 
                        Enable Dietary Filters on Menu
                    </label>
                </form>
            </div>
        </section>
    `;
}