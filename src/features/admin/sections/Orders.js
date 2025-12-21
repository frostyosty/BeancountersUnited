// src/features/admin/sections/Orders.js

export function renderActiveOrdersSection(orders, role, settings) {
    // 1. Get Archive Settings
    const archiveConfig = settings?.archiveSettings || { autoArchiveHours: 48 };
    const maxAgeMs = archiveConfig.autoArchiveHours * 60 * 60 * 1000;
    const now = Date.now();

    // 2. Split Orders
    const liveOrders = [];
    const archivedOrders = [];

    if (Array.isArray(orders)) {
        orders.forEach(o => {
            const orderTime = new Date(o.created_at).getTime();
            const isOld = (now - orderTime) > maxAgeMs;
            if ((o.status === 'pending' || o.status === 'preparing') && !isOld) {
                liveOrders.push(o);
            } else {
                archivedOrders.push(o);
            }
        });
    }

    liveOrders.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    archivedOrders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Helper Row Generator
    const createRow = (order, isLive) => {
        const time = new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const date = new Date(order.created_at).toLocaleDateString();
        const displayTime = isLive ? time : `${date} ${time}`;

        let dueDisplay = '';
        if (isLive) {
            const dueTimeStr = order.pickup_time || order.created_at;
            dueDisplay = `<span class="live-timer" data-due="${dueTimeStr}">...</span>`;
        } else {
            const dueD = new Date(order.pickup_time || order.created_at);
            dueDisplay = dueD.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            // Add day diff logic if needed (omitted for brevity, can copy from historyUI)
        }

        const customerName = order.customer_name || order.profiles?.full_name || order.profiles?.email || 'Guest';
        const safeName = customerName.replace(/'/g, "");
        const clickName = customerName.replace(/'/g, "\\'"); 

        const itemsSummary = (order.order_items || []).map(i => 
            `${i.quantity}x ${i.menu_items?.name || 'Item'}`
        ).join(', ') || 'No items';

        const totalFormatted = `$${parseFloat(order.total_amount).toFixed(2)}`;
        const statusClass = `status-${order.status}`;
        
        // Actions
        const dismissBtn = `<button class="delete-icon-btn action-btn" data-action="dismiss" data-name="${safeName}" data-total="${totalFormatted}" title="Archive">×</button>`;
        const deleteBtn = (role === 'god') 
            ? `<button class="delete-icon-btn action-btn" data-action="delete" title="Permanent Delete" style="color:#d00;">🗑</button>` 
            : '';
        const actionCell = isLive ? `<td>${dismissBtn}</td>` : (role === 'god' ? `<td>${deleteBtn}</td>` : '<td></td>');
        
        const customerCell = `<td style="padding:10px; font-weight:500;"><span class="client-name-btn" onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')">${customerName}</span></td>`;

        return `
            <tr class="${statusClass}" data-order-id="${order.id}">
                <td style="padding:10px; font-weight:bold; white-space:nowrap;">${dueDisplay}</td>
                <td style="padding:10px; font-size:0.9rem;">${itemsSummary}</td>
                ${customerCell}
                <td style="padding:10px; font-weight:bold;">${totalFormatted}</td>
                <td style="padding:10px;"><span class="badge ${statusClass}">${order.status.toUpperCase()}</span></td>
                <td style="padding:10px; color:#666; font-size:0.8rem; white-space:nowrap;">${displayTime}</td>
                ${actionCell}
            </tr>
        `;
    };

    const liveRows = liveOrders.map(o => createRow(o, true)).join('');
    const archiveRows = archivedOrders.map(o => createRow(o, false)).join('');
    const hoursText = (archiveConfig.autoArchiveHours || 48) + ' hours';

    const headersHTML = `
        <tr>
            <th style="padding:10px; text-align:left;">Due</th>
            <th style="padding:10px; text-align:left;">Items</th>
            <th style="padding:10px; text-align:left;">Customer</th>
            <th style="padding:10px; text-align:left;">Total</th>
            <th style="padding:10px; text-align:left;">Status</th>
            <th style="padding:10px; text-align:left;">Filed</th>
            <th style="padding:10px; text-align:left;">Action</th>
        </tr>
    `;

    return `
        <section class="dashboard-section" id="orders-section-wrapper">
            <!-- LIVE ORDERS -->
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3 style="color: var(--primary-color); margin:0;">Live Orders</h3>
                <button id="btn-manual-order" class="button-secondary small" style="font-weight: 600;">+ Phone Order</button>
            </div>

            <div class="table-wrapper" style="margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
                <table class="admin-orders-table" style="width:100%; border-collapse:collapse;">
                    <thead style="background:#f9f9f9; border-bottom: 2px solid var(--primary-color);">
                        ${headersHTML}
                    </thead>
                    <tbody style="background:white;">
                        ${liveRows.length > 0 ? liveRows : '<tr><td colspan="7" style="text-align:center; padding:30px; color:#999;">No live orders.</td></tr>'}
                    </tbody>
                </table>
            </div>

            <!-- ARCHIVE -->
            <div class="archive-section" style="background-color: #f8f8f8; border-top: 1px solid #ddd; padding-top: 20px;">
                <div class="archive-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <h4 style="margin:0; color:#666;">Archived Orders</h4>
                        <button id="btn-archive-settings" class="button-secondary small" style="padding:2px 8px; font-size:0.7rem;">Settings</button>
                    </div>
                    <button id="toggle-archive-btn" class="button-secondary small">Show Archive</button>
                </div>
                
                <p style="margin-top:-5px; margin-bottom:15px; color:#999; font-style:italic; font-size:0.8rem;">
                    Auto-archived after ${hoursText}.
                </p>
                
                <div id="archive-table-container" style="display:none;">
                    <input type="text" id="archive-search" placeholder="Search archive..." style="width:100%; padding:8px; margin-bottom:10px; border:1px solid #ccc; border-radius:4px;">
                    <div style="max-height: 400px; overflow-y: auto;">
                        <table class="archive-table" style="width:100%; font-size:0.9rem;">
                            <thead>${headersHTML}</thead>
                            <tbody id="archive-tbody">
                                ${archiveRows.length > 0 ? archiveRows : '<tr><td colspan="7">No history found.</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </section>
    `;
}