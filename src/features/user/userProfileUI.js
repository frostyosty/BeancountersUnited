// src/features/user/userProfileUI.js
import { useAppStore } from '@/store/appStore.js';

export function renderUserProfilePage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { settings } = useAppStore.getState().siteSettings;
    const { user, profile } = useAppStore.getState().auth;
    const siteName = settings.websiteName || 'Mealmates';

    if (!user) {
        mainContent.innerHTML = `
            <div class="notice-message" style="text-align:center; margin-top:50px;">
                <h2>My ${siteName}</h2>
                <p>Please log in to manage your preferences.</p>
                <button class="button-primary" onclick="document.getElementById('login-signup-btn').click()">Login / Sign Up</button>
            </div>
        `;
        return;
    }

    mainContent.innerHTML = `
        <div class="dashboard-container" style="max-width:600px; margin:0 auto;">
            <h2>My ${siteName}</h2>
            <div style="background:white; padding:20px; border-radius:8px; border:1px solid #eee; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                <div style="margin-bottom:15px;">
                    <label style="display:block; font-size:0.8rem; color:#666;">Logged in as</label>
                    <div style="font-weight:500; font-size:1.1rem;">${user.email}</div>
                </div>
                
                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
                
                <h3>Preferences</h3>
                <p style="color:#888; font-style:italic;">
                    Coming Soon: Set your default dietary requirements (e.g. Always GF) and notification settings here.
                </p>
                
                <hr style="margin:20px 0; border:0; border-top:1px solid #eee;">
                
                <button class="button-secondary" onclick="document.getElementById('logout-btn').click()" style="width:100%;">Sign Out</button>
            </div>
        </div>
    `;
}