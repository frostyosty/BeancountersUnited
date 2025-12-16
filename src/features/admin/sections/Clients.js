export function renderClientRelationshipsSection(clients) {
    if (!clients) return '<p>Loading clients...</p>';
    
    const rows = clients.map(client => {
        const lastOrderDate = client.lastOrder ? new Date(client.lastOrder).toLocaleDateString() : '-';
        const displayName = client.internal_nickname || client.full_name || client.email || 'Unknown';
        const noteIcon = client.staff_note ? '📝' : '';
        const spend = parseFloat(client.totalSpend || 0).toFixed(2);

        return `
            <tr onclick="window.handleOrderRowClick('${client.id}')" style="cursor:pointer; border-bottom:1px solid #eee;">
                <td style="padding:10px; font-weight:500;">
                    ${displayName} ${noteIcon}
                    <div style="font-size:0.8rem; color:#888;">${client.email}</div>
                </td>
                <td style="padding:10px;">${client.orderCount}</td>
                <td style="padding:10px; color:var(--primary-color); font-weight:bold;">$${spend}</td>
                <td style="padding:10px;">${lastOrderDate}</td>
                <td style="padding:10px;">
                    <button class="button-secondary small" onclick="event.stopPropagation(); window.handleMergeClick('${client.id}')">Merge</button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <section class="dashboard-section">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                <h3>Client Relationships</h3>
                <div style="display:flex; gap:10px;">
                    <input type="text" id="client-search" placeholder="Search..." style="padding:5px; border:1px solid #ccc; border-radius:4px;">
                    <button class="button-primary small" onclick="window.showAddPastOrderModal()">+ Past Order</button>
                </div>
            </div>
            <div class="table-wrapper" style="max-height: 400px; overflow-y: auto;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="background:#f9f9f9; position:sticky; top:0; z-index:1;">
                        <tr>
                            <th style="padding:10px;">Name / Email</th>
                            <th style="padding:10px;">Orders</th>
                            <th style="padding:10px;">Total Spend</th>
                            <th style="padding:10px;">Last Seen</th>
                            <th style="padding:10px;">Actions</th>
                        </tr>
                    </thead>
                    <tbody id="client-table-body">${rows}</tbody>
                </table>
            </div>
        </section>
    `;
}