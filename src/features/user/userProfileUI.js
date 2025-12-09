// src/features/user/userProfileUI.js
import { useAppStore } from '@/store/appStore.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

export function renderUserProfilePage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { settings } = useAppStore.getState().siteSettings;
    const { user, profile } = useAppStore.getState().auth;
    const siteName = settings.websiteName || 'Mealmates';

    if (!user) {
        mainContent.innerHTML = `<div class="notice-message"><h2>My ${siteName}</h2><p>Please log in.</p></div>`;
        return;
    }

    const currentPrefs = profile?.dietary_preferences || [];
    const options = ['GF', 'V', 'VG', 'DF'];

    const checkboxes = options.map(opt => `
        <label style="display:flex; align-items:center; gap:10px; padding:10px; border:1px solid #eee; border-radius:6px; cursor:pointer;">
            <input type="checkbox" class="diet-pref-cb" value="${opt}" ${currentPrefs.includes(opt) ? 'checked' : ''}>
            <span style="font-weight:500;">${opt}</span>
        </label>
    `).join('');

    mainContent.innerHTML = `
        <div class="dashboard-container" style="max-width:600px; margin:0 auto;">
            <h2>My ${siteName}</h2>
            <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee;">
                <div style="margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:15px;">
                    <label style="font-size:0.8rem; color:#666;">Logged in as</label>
                    <div style="font-weight:500;">${user.email}</div>
                </div>
                
                <h3>Dietary Preferences</h3>
                <p style="color:#666; font-size:0.9rem; margin-bottom:15px;">
                    Automatically filter the menu to show safe items for you.
                </p>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:20px;">
                    ${checkboxes}
                </div>
                
                <button id="save-prefs-btn" class="button-primary" style="width:100%;">Save Preferences</button>
                
                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
                <button class="button-secondary" onclick="document.getElementById('logout-btn').click()" style="width:100%;">Sign Out</button>
            </div>
        </div>
    `;

    document.getElementById('save-prefs-btn').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.textContent = "Saving...";
        btn.disabled = true;

        const selected = Array.from(document.querySelectorAll('.diet-pref-cb:checked')).map(cb => cb.value);
        
        try {
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateUserProfile({ dietary_preferences: selected }, session.access_token);
            
            // Reload profile to update local state
            await useAppStore.getState().auth.fetchProfileOnly();
            
            // Auto-apply filters to UI
            // We set the UI slice state so the menu page reads it immediately
            const { toggleAllergenFilter } = useAppStore.getState().ui;
            // Reset and apply new
            // For simplicity, we just reload the page/hash which will re-read profile
            uiUtils.showToast("Preferences saved!", "success");
            
        } catch (err) {
            console.error(err);
            uiUtils.showToast("Failed to save.", "error");
        } finally {
            btn.textContent = "Save Preferences";
            btn.disabled = false;
        }
    });
}