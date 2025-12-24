import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { openHeaderLogoEditor } from '@/features/admin/headerEditor/index.js';
import { warper } from '@/utils/ui/imageMorph.js';

export async function handleConfigClicks(target) {
    // Logo Clear
    if (target.matches('#clear-logo-btn')) {
        const { data: { session } } = await supabase.auth.getSession();
        await api.updateSiteSettings({ logoUrl: '' }, session.access_token);
        uiUtils.updateSiteTitles(null, '');
        useAppStore.getState().siteSettings.fetchSiteSettings();
        uiUtils.showToast('Logo removed.', 'success');
    }
    
    // BG Clear
    if (target.matches('#clear-bg-btn')) {
         const { data: { session } } = await supabase.auth.getSession();
         const { settings } = useAppStore.getState().siteSettings;
         const newTheme = { ...settings.themeVariables, '--body-background-image': 'none' };
         await api.updateSiteSettings({ themeVariables: newTheme }, session.access_token);
         document.documentElement.style.setProperty('--body-background-image', 'none');
         document.getElementById('bg-preview').style.display = 'none';
         target.style.display = 'none';
         uiUtils.showToast("Background removed.", "success");
    }

    // Header Editor
    if (target.id === 'open-header-creator-btn') {
        openHeaderLogoEditor();
    }
    
    // Warp Test Tool
    if (target.id === 'btn-test-warp') {
        const img = document.getElementById('warp-test-target');
        const current = img.getAttribute('src');
        const next = current.includes('coffee') ? '/placeholder-burger.jpg' : '/placeholder-coffee.jpg';
        const speedInput = document.querySelector('input[name="warpSpeed"]');
        const blockInput = document.querySelector('input[name="warpBlock"]');
        const config = {
            duration: speedInput ? parseInt(speedInput.value) : 30,
            blockSize: blockInput ? parseInt(blockInput.value) : 2
        };
        uiUtils.showToast(`Warping...`, "info");
        warper.warp(img, next, config);
    }
    
    // Restore History
    if (target.classList.contains('restore-btn')) {
        const logId = target.dataset.logId;
        if (confirm("Revert settings to this point?")) {
            const { data: { session } } = await supabase.auth.getSession();
            try {
                await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
                    body: JSON.stringify({ logId })
                });
                uiUtils.showToast("Restored!", "success");
                window.location.reload(); 
            } catch(e) { uiUtils.showToast("Restore Error", "error"); }
        }
    }
    
    // Cafe Location
    if (target.id === 'btn-get-cafe-location') {
         if (!navigator.geolocation) return uiUtils.showToast("Geolocation not supported", "error");
         navigator.geolocation.getCurrentPosition(
            (pos) => {
                document.getElementById('input-cafe-lat').value = pos.coords.latitude;
                document.getElementById('input-cafe-lng').value = pos.coords.longitude;
                document.getElementById('cafe-coords-display').textContent = "Updated. Click Save.";
            }
         );
    }

    // Layout Adjusters (Zoom/Padding)
    if (target.matches('.zoom-btn')) {
        const val = target.dataset.val;
        document.getElementById('zoom-input').value = val;
        document.body.style.zoom = val; 
    }
    if (target.matches('.adjust-btn')) {
        const targetId = target.dataset.target;
        const step = parseInt(target.dataset.step, 10);
        const unit = target.dataset.unit || 'px';
        const input = document.getElementById(targetId);
        const match = input.value.match(/(\d*\.?\d+)/);
        let currentVal = match ? parseFloat(match[0]) : 0;
        if (input.value.includes('rem') && unit === 'px') currentVal = currentVal * 16; 
        let newVal = Math.max(0, currentVal + step) + unit;
        input.value = newVal;

        if (targetId === 'padding-input') document.documentElement.style.setProperty('--global-padding', newVal);
        if (targetId === 'margin-input') document.documentElement.style.setProperty('--section-margin', newVal);
        if (targetId === 'radius-input') document.documentElement.style.setProperty('--border-radius', newVal);
    }
}