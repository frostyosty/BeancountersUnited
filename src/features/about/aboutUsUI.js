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

    // Default config structure
    const aboutConfig = settings.aboutUs || { 
        enabled: false, 
        title: 'About Us', 
        content: '', 
        imageUrl: '',
        enablePhone: false, // NEW
        phoneNumber: ''     // NEW
    };

    // 1. Access Control
    if (!aboutConfig.enabled && !isOwner) {
        window.location.hash = '#menu';
        return;
    }

    // 2. Render View Mode
    const editButtonHTML = isOwner 
        ? `<button id="edit-about-btn" class="button-secondary small" style="margin-bottom:20px;">✏️ Edit Page</button>` 
        : '';

    const imageHTML = aboutConfig.imageUrl 
        ? `<img src="${aboutConfig.imageUrl}" alt="About Us" style="max-width:100%; border-radius:8px; margin-bottom:20px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">` 
        : '';

    const contentHTML = aboutConfig.content 
        ? `<div style="line-height:1.6; white-space: pre-wrap; font-size:1.05rem; color:#444;">${aboutConfig.content}</div>` 
        : `<p style="color:#666; font-style:italic;">No content yet.</p>`;

    // --- NEW: Phone Button Logic ---
    let phoneButtonHTML = '';
    if (aboutConfig.enablePhone && aboutConfig.phoneNumber) {
        const cleanNumber = aboutConfig.phoneNumber.replace(/\s+/g, ''); // Remove spaces for href
        phoneButtonHTML = `
            <div style="text-align:center; margin-top:10px;">
                <a href="tel:${cleanNumber}" class="about-phone-btn mobile-sticky">
                    📞 Call Us: ${aboutConfig.phoneNumber}
                </a>
            </div>
        `;
    }

    mainContent.innerHTML = `
        <div class="about-container" style="max-width:800px; margin:0 auto; background:white; padding:2rem; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,0.05); position:relative;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h2 style="margin:0;">${aboutConfig.title}</h2>
                ${editButtonHTML}
            </div>
            
            ${imageHTML}
            ${contentHTML}
            ${phoneButtonHTML}
            
            <!-- Spacer for mobile to prevent content being hidden behind sticky button -->
            <div style="height: 60px; display:none;" class="mobile-spacer"></div>
        </div>
    `;
    
    // Helper style to show spacer only on mobile
    if (window.innerWidth <= 768 && aboutConfig.enablePhone) {
        const spacer = mainContent.querySelector('.mobile-spacer');
        if(spacer) spacer.style.display = 'block';
    }

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
                    <textarea name="content" style="width:100%; height:200px; padding:10px; border:1px solid #ddd; border-radius:4px; font-family:inherit;">${config.content}</textarea>
                </div>

                <!-- NEW: Phone Settings -->
                <div class="form-group" style="background:#f9f9f9; padding:15px; border-radius:6px; border:1px solid #eee;">
                    <label style="margin-bottom:10px; display:block;">Call to Action</label>
                    <div style="display:flex; align-items:center; gap:15px;">
                        <label style="font-weight:normal; display:flex; align-items:center; gap:5px; cursor:pointer;">
                            <input type="checkbox" name="enablePhone" ${config.enablePhone ? 'checked' : ''}> 
                            Show Call Button
                        </label>
                        <input type="tel" name="phoneNumber" value="${config.phoneNumber || ''}" placeholder="e.g. 021 123 4567" style="flex:1; padding:8px; border:1px solid #ccc; border-radius:4px;">
                    </div>
                    <p style="font-size:0.8rem; color:#666; margin-top:5px;">This button will stick to the bottom of the screen on mobile devices.</p>
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
            enabled: config.enabled,
            title: formData.get('title'),
            content: formData.get('content'),
            imageUrl: finalImageUrl,
            enablePhone: formData.get('enablePhone') === 'on',
            phoneNumber: formData.get('phoneNumber')
        };
        
        // FIX: Use Store Action for Optimistic Update
        const { updateSiteSettings } = useAppStore.getState().siteSettings;
        const { data: { session } } = await supabase.auth.getSession();

        try {
            // This updates local state immediately, then calls API
            await updateSiteSettings({ aboutUs: newConfig }, session.access_token);
            
            uiUtils.showToast("About page updated!", "success");
            renderAboutUsPage(); // Re-render with new state immediately
        } catch (err) {
            console.error(err);
            uiUtils.showToast("Save failed", "error");
            btn.disabled = false;
        }
    });
}