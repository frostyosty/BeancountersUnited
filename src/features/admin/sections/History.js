// src/features/admin/sections/History.js

export function renderHistorySection(logs) {
    if (!logs) return '<p>Loading history...</p>';

    // Filter to only show Settings changes (or Restore actions)
    // We ignore general user updates to keep this view focused on "Site Config" history
    const settingLogs = logs.filter(l => 
        l.action_type && (l.action_type.startsWith('SETTINGS:') || l.action_type.startsWith('RESTORE:'))
    );
    
    if (settingLogs.length === 0) return '<p style="color:#666; padding:20px;">No configuration changes recorded.</p>';

    const rows = settingLogs.map(log => {
        const date = new Date(log.created_at).toLocaleString();
        // Handle case where actor might be null (system action) or deleted user
        const actor = log.profiles?.email || 'System / Unknown';
        const isRestore = log.action_type.startsWith('RESTORE');
        
        // Show Restore button only for settings changes, not for previous restores
        const restoreBtn = !isRestore
            ? `<button class="button-secondary small restore-btn" data-log-id="${log.id}" style="padding:4px 8px; font-size:0.75rem;">↺ Restore</button>`
            : '<span style="color:#28a745; font-size:0.8rem;">Restored Point</span>';

        // Clean up the action label
        const label = log.action_type.replace('SETTINGS: ', '').replace('RESTORE: ', '');

        return `
            <tr>
                <td style="font-size:0.85rem; white-space:nowrap;">${date}</td>
                <td style="font-weight:500; font-size:0.9rem;">${label}</td>
                <td style="font-size:0.85rem; color:#666;">${actor}</td>
                <td style="text-align:right;">${restoreBtn}</td>
            </tr>
        `;
    }).join('');

    return `
        <section class="dashboard-section" style="border:1px solid #ccc;">
            <h3 style="color:#333;">Site Configuration History</h3>
            <p style="font-size:0.85rem; color:#666; margin-bottom:15px;">
                Rollback your website settings to a previous state.
            </p>
            <div class="table-wrapper" style="max-height:300px; overflow-y:auto;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="background:#eee; position:sticky; top:0;">
                        <tr>
                            <th style="padding:8px; text-align:left;">Time</th>
                            <th style="padding:8px; text-align:left;">Action</th>
                            <th style="padding:8px; text-align:left;">User</th>
                            <th style="padding:8px; text-align:right;">Rollback</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </section>
    `;
}