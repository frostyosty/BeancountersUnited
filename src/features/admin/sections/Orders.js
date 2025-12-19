// src/features/admin/sections/Orders.js

export function renderActiveOrdersSection(orders) {
    if (!Array.isArray(orders)) return '<p>Loading orders...</p>';

    const activeOrders = orders.filter(o => o.status === 'pending' || o.status === 'preparing');
    
    const content = activeOrders.length === 0 ? '<p>No active orders.</p>' : activeOrders.map(order => {
        const profile = order.profiles || {}; 
        
        let noteIcon = '';
        if (profile.staff_note) {
            noteIcon = profile.staff_note_urgency === 'alert' ? `<span title="Important">🔴</span>` : `<span title="Info">🔵</span>`;
        }

        const displayName = order.customer_name || profile.internal_nickname || profile.full_name || profile.email || 'Guest';
        // Escape for JS click handler
        const clickName = displayName.replace(/'/g, "\\'"); 

        const orderId = order.id ? order.id.slice(0, 4) : '????';
        const total = parseFloat(order.total_amount || 0).toFixed(2);

        return `
        <div class="order-card" style="background:white; border:1px solid #eee; padding:10px; margin-bottom:10px; border-radius:4px;">
            <div class="order-header" style="cursor:pointer; display:flex; justify-content:space-between; font-weight:bold;" 
                 onclick="window.handleOrderRowClick('${order.user_id}', '${clickName}')">
                <span>#${orderId} - ${displayName} ${noteIcon}</span>
                <span>$${total}</span>
            </div>
            <div style="font-size:0.9rem; color:#666; margin-top:5px;">
                ${(order.order_items || []).map(i => `${i.quantity}x ${i.menu_items?.name || 'Item'}`).join(', ')}
            </div>
        </div>`;
    }).join('');

    return `
        <section class="dashboard-section" style="background:#f0f8ff; border:1px solid #d0e8ff;">
            <h3>Active Orders</h3>
            ${content}
        </section>
    `;
}