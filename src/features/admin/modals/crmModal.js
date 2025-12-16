import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';

export async function showCustomerCRMModal(userId, manualNameOverride = null) {
    uiUtils.showModal(`<div class="loading-spinner">Fetching Client History...</div>`);

    try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");

        const { profile, history, logs } = await api.getCustomerDetails(userId, session.access_token);

        // --- Build HTML ---
        const historyRows = history.map(order => {
            const date = new Date(order.created_at).toLocaleDateString();
            const itemsSummary = order.order_items.map(i => `${i.quantity}x ${i.menu_items?.name}`).join(', ');
            return `<tr style="border-bottom:1px solid #eee; font-size:0.9rem;"><td style="padding:8px;">${date}</td><td style="padding:8px; color:#666;">${itemsSummary}</td><td style="padding:8px;">$${order.total_amount.toFixed(2)}</td></tr>`;
        }).join('');

        const auditRows = (logs || []).map(log => {
            const date = new Date(log.created_at).toLocaleString();
            const actorName = log.profiles?.email || 'Manager';
            let changeMsg = log.action_type;
            if (log.action_type === 'UPDATE_NICKNAME') changeMsg = `Nickname: "${log.old_value}" → "${log.new_value}"`;
            if (log.action_type === 'UPDATE_NOTE') changeMsg = `Updated Note`;
            
            return `<div style="padding:8px; border-bottom:1px solid #eee; font-size:0.85rem;"><div style="color:#888; font-size:0.8rem;">${date} by ${actorName}</div><div>${changeMsg}</div></div>`;
        }).join('');

        const displayName = manualNameOverride || profile.full_name || profile.email || 'Guest';
        const subText = manualNameOverride 
            ? `(Phone/Walk-in Record linked to ${profile.email})` 
            : (profile.email || 'No Email');

        const modalHTML = `
            <div class="crm-modal-container" style="min-width:350px; padding-bottom: 50px;">
                <!-- Header -->
                <div style="border-bottom:1px solid #eee; padding-bottom:15px; margin-bottom:15px;">
                    <h3 style="margin:0 0 5px 0;">${displayName}</h3>
                    <p style="margin:0; font-size:0.85rem; color:#666;">${subText}</p>
                    
                    ${!manualNameOverride ? `
                    <div style="margin-top:10px; display:flex; gap:10px; align-items:center;">
                        <label style="font-size:0.9rem;">Nickname:</label>
                        <input type="text" id="crm-nickname" value="${profile.internal_nickname || ''}" placeholder="e.g. Latte John" style="padding:5px; border:1px solid #ccc; border-radius:4px; flex:1;">
                    </div>` : ''}
                </div>

                <!-- Staff Notes -->
                <div style="background:#f9f9f9; padding:15px; border-radius:6px; margin-bottom:20px;">
                    <label style="font-weight:bold; font-size:0.9rem; display:block; margin-bottom:5px;">Staff Note</label>
                    <textarea id="crm-note" rows="3" style="width:100%; padding:8px; border:1px solid #ddd; border-radius:4px;">${profile.staff_note || ''}</textarea>
                    
                    <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
                        <div style="display:flex; gap:15px;">
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer;">
                                <input type="radio" name="noteUrgency" value="info" ${profile.staff_note_urgency !== 'alert' ? 'checked' : ''}> Info
                            </label>
                            <label style="font-size:0.85rem; display:flex; align-items:center; gap:5px; cursor:pointer; color:#d00;">
                                <input type="radio" name="noteUrgency" value="alert" ${profile.staff_note_urgency === 'alert' ? 'checked' : ''}> Important
                            </label>
                        </div>
                        <button id="crm-save-btn" class="button-primary small">Save</button>
                    </div>
                </div>

                <!-- Tabs -->
                <div style="margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <button id="tab-orders" class="button-secondary small" style="background:#ddd; color:#333;">Order History</button>
                        <button id="tab-audit" class="button-secondary small" style="background:transparent; color:#666; border:1px solid #ddd;">Audit Log</button>
                    </div>
                    <button id="crm-add-order-btn" class="button-primary small" style="padding: 4px 10px; font-weight:bold;" title="Add Past Order">+</button>
                </div>

                <div id="content-orders" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px;">
                    <table style="width:100%; border-collapse:collapse;">
                        <thead style="background:#f5f5f5; position:sticky; top:0;">
                            <tr><th style="padding:8px; text-align:left; font-size:0.8rem;">Date</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Items</th><th style="padding:8px; text-align:left; font-size:0.8rem;">Total</th></tr>
                        </thead>
                        <tbody>${historyRows || '<tr><td colspan="3" style="text-align:center; padding:10px;">No history</td></tr>'}</tbody>
                    </table>
                </div>

                <div id="content-audit" style="max-height:200px; overflow-y:auto; border:1px solid #eee; border-radius:4px; display:none;">
                    ${auditRows || '<div style="padding:15px; text-align:center; color:#999; font-size:0.9rem;">No changes recorded.</div>'}
                </div>

                <!-- Sticky Footer -->
                <div style="position: sticky; bottom: -20px; margin: 20px -20px -20px -20px; padding: 15px; background: white; border-top: 1px solid #eee; text-align: right; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); border-bottom-left-radius: 8px; border-bottom-right-radius: 8px;">
                    <button id="crm-save-footer-btn" class="button-primary" style="width:100%;">Save Changes</button>
                </div>
            </div>
        `;

        uiUtils.showModal(modalHTML);

        // --- Logic & Listeners ---
        const tabOrders = document.getElementById('tab-orders');
        const tabAudit = document.getElementById('tab-audit');
        const contentOrders = document.getElementById('content-orders');
        const contentAudit = document.getElementById('content-audit');

        tabOrders.onclick = () => {
            contentOrders.style.display = 'block'; contentAudit.style.display = 'none';
            tabOrders.style.background = '#ddd'; tabOrders.style.color = '#333';
            tabAudit.style.background = 'transparent'; tabAudit.style.color = '#666';
        };
        tabAudit.onclick = () => {
            contentOrders.style.display = 'none'; contentAudit.style.display = 'block';
            tabAudit.style.background = '#ddd'; tabAudit.style.color = '#333';
            tabOrders.style.background = 'transparent'; tabOrders.style.color = '#666';
        };

        const saveHandler = async (e) => {
            const btn = e.target;
            btn.textContent = 'Saving...'; btn.disabled = true;
            
            const nicknameInput = document.getElementById('crm-nickname');
            const nickname = nicknameInput ? nicknameInput.value : null; 
            const note = document.getElementById('crm-note').value;
            const urgency = document.querySelector('input[name="noteUrgency"]:checked').value;

            try {
                await api.updateCustomerDetails({ userId, nickname: nickname !== null ? nickname : undefined, note, urgency }, session.access_token);
                uiUtils.showToast("Updated!", "success");
                useAppStore.getState().ui.triggerPageRender(); 
                setTimeout(() => { btn.textContent = 'Save Changes'; btn.disabled = false; }, 1000);
            } catch (err) {
                console.error(err);
                uiUtils.showToast("Failed.", "error");
                btn.textContent = 'Save'; btn.disabled = false;
            }
        };

        document.getElementById('crm-save-btn').addEventListener('click', saveHandler);
        document.getElementById('crm-save-footer-btn').addEventListener('click', saveHandler);

        document.getElementById('crm-add-order-btn').onclick = () => {
            const targetProfile = { id: userId, full_name: profile.full_name, internal_nickname: profile.internal_nickname };
            // Calls the global handler in adminListeners.js
            window.showAddPastOrderModal(targetProfile);
        };

    } catch (e) {
        console.error("CRM Modal Error:", e);
        uiUtils.showModal(`<div class="error-message">Could not load client details.</div>`);
    }
}