// src/features/about/aboutUsUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export function renderAboutUsPage() {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    const { settings } = useAppStore.getState().siteSettings;
    const auth = useAppStore.getState().auth;
    const userRole = auth.getUserRole();
    const isOwner = userRole === 'owner' || userRole === 'god';

    const aboutConfig = settings.aboutUs || { enabled: false, title: 'About Us', content: '', imageUrl: '' };

    // 1. Access Control
    if (!aboutConfig.enabled && !isOwner) {
        window.location.hash = '#menu';
        return;
    }

    // 2. Render View Mode
    const editButtonHTML = isOwner 
        ? `<button id="edit-about-btn" class="button-secondary small" style="margin-bottom:20px;">✏️ Edit Content</button>` 
        : '';

    const imageHTML = aboutConfig.imageUrl 
        ? `<img src="${aboutConfig.imageUrl}" alt="About Us" style="max-width:100%; border-radius:8px; margin-bottom:20px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">` 
        : '';

    const contentHTML = aboutConfig.content 
        ? `<div style="line-height:1.6; white-space: pre-wrap;">${aboutConfig.content}</div>` 
        : `<p style="color:#666; font-style:italic;">No content yet.</p>`;

    mainContent.innerHTML = `
        <div class="about-container" style="max-width:800px; margin:0 auto; background:white; padding:2rem; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.05);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0;">${aboutConfig.title}</h2>
                ${editButtonHTML}
            </div>
            
            ${imageHTML}
            ${contentHTML}
        </div>
    `;

    // 3. Attach Edit Listener
    const editBtn = document.getElementById('edit-about-btn');
    if (editBtn) {
        editBtn.onclick = () => renderEditMode(aboutConfig);
    }
}

function renderEditMode(config) {
    const mainContent = document.getElementById('main-content');
    
    mainContent.innerHTML = `
        <div class="about-container" style="max-width:800px; margin:0 auto; background:white; padding:2rem; border-radius:8px;">
            <h2>Edit About Page</h2>
            <form id="about-us-form">
                <div class="form-group">
                    <label>Page Title</label>
                    <input type="text" name="title" value="${config.title}" required>
                </div>
                
                <div class="form-group">
                    <label>Hero Image</label>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <img src="${config.imageUrl}" style="height:50px; display:${config.imageUrl?'block':'none'}; border:1px solid #ccc;">
                        <input type="file" id="about-image-upload" accept="image/*">
                    </div>
                </div>

                <div class="form-group">
                    <label>Content / Story</label>
                    <textarea name="content" style="width:100%; height:200px; padding:10px; border:1px solid #ddd; border-radius:4px;">${config.content}</textarea>
                </div>

                <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:20px;">
                    <button type="button" id="cancel-edit-btn" class="button-secondary">Cancel</button>
                    <button type="submit" class="button-primary">Save Changes</button>
                </div>
            </form>
        </div>
    `;

    document.getElementById('cancel-edit-btn').onclick = () => renderAboutUsPage();

    document.getElementById('about-us-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button[type="submit"]');
        btn.textContent = "Saving...";
        btn.disabled = true;

        const formData = new FormData(e.target);
        let finalImageUrl = config.imageUrl;

        // Handle Image Upload
        const fileInput = document.getElementById('about-image-upload');
        if (fileInput.files.length > 0) {
            const file = fileInput.files[0];
            const fileName = `about/about-${Date.now()}.${file.name.split('.').pop()}`;
            try {
                const { error } = await supabase.storage.from('menu-images').upload(fileName, file);
                if (error) throw error;
                const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
                finalImageUrl = data.publicUrl;
            } catch (err) {
                console.error("Upload failed:", err);
                uiUtils.showToast("Image upload failed", "error");
                btn.disabled = false;
                return;
            }
        }

        // Save Settings
        const newConfig = {
            enabled: config.enabled, // Keep existing enabled state
            title: formData.get('title'),
            content: formData.get('content'),
            imageUrl: finalImageUrl
        };

        const { data: { session } } = await supabase.auth.getSession();
        await api.updateSiteSettings({ aboutUs: newConfig }, session.access_token);
        
        // Refresh Store & UI
        await useAppStore.getState().siteSettings.fetchSiteSettings();
        uiUtils.showToast("About page updated!", "success");
        renderAboutUsPage();
    });
}