// src/features/admin/modals/imageEditorModal.js
import * as uiUtils from '@/utils/uiUtils.js';
import * as api from '@/services/apiService.js';
import { supabase } from '@/supabaseClient.js';
import { useAppStore } from '@/store/appStore.js';

export async function showImageEditorModal(item) {
    const currentImg = item.image_url || '/placeholder-coffee.jpg';

    // 1. Load Cropper.js Dependencies if not present
    if (!window.Cropper) {
        uiUtils.showToast("Loading editor tools...", "info");
        await loadCSS('https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.css');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.js');
    }

    const modalHTML = `
        <!-- Add onmousedown="event.stopPropagation()" to the main container -->
        <div class="modal-form-container" style="max-width: 600px; text-align:center;" onmousedown="event.stopPropagation()">
            <h3>Edit Image: ${item.name}</h3>
            
            <!-- EDITOR CANVAS -->
            <div id="cropper-wrapper" style="margin: 20px auto; width: 300px; height: 300px; background-color: transparent; overflow: hidden; border-radius: 8px; position: relative; border: 1px solid #ccc;">
                <!-- Checkerboard pattern -->
                <div style="position: absolute; inset: 0; background-image: linear-gradient(45deg, #eee 25%, transparent 25%), linear-gradient(-45deg, #eee 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #eee 75%), linear-gradient(-45deg, transparent 75%, #eee 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0px; z-index: 0; pointer-events:none;"></div>
                <img id="img-editor-target" src="${currentImg}" crossorigin="anonymous" style="max-width: 100%; display: block; position: relative; z-index: 1;">
            </div>

            <!-- CONTROLS ROW 1: Movement -->
            <div style="display:flex; gap:10px; justify-content:center; margin-bottom:15px;">
                <button type="button" class="button-secondary small" id="btn-zoom-in" title="Zoom In">➕</button>
                <button type="button" class="button-secondary small" id="btn-zoom-out" title="Zoom Out">➖</button>
                <button type="button" class="button-secondary small" id="btn-rotate" title="Rotate">🔄</button>
                <button type="button" class="button-secondary small" id="btn-reset" title="Reset">Reset</button>
            </div>

            <!-- CONTROLS ROW 2: Background -->
            <div style="background: #f9f9f9; padding: 10px; border-radius: 8px; margin-bottom: 20px; display: inline-flex; align-items: center; gap: 15px; border: 1px solid #eee;">
                <span style="font-size: 0.9rem; font-weight: 600; color: #555;">Canvas Background:</span>
                <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 0.9rem;">
                    <input type="checkbox" id="bg-transparent-check" checked> Transparent
                </label>
                <div id="bg-color-picker-group" style="display:none; align-items: center; gap: 5px;">
                    <input type="color" id="bg-color-input" value="#ffffff" style="cursor: pointer; border: none; width: 30px; height: 30px; padding: 0;">
                </div>
            </div>

            <!-- UPLOAD -->
            <div id="img-drop-zone" style="border: 2px dashed #ccc; padding: 15px; border-radius: 8px; cursor: pointer; background: #fafafa; margin-bottom: 20px;">
                <p style="margin:0; font-weight:500; font-size:0.9rem;">Drag & Drop New Image</p>
                <input type="file" id="img-editor-input" accept="image/*" style="display:none;">
            </div>

            <!-- ACTIONS -->
            <div style="display: flex; gap: 10px; justify-content: center; border-top:1px solid #eee; padding-top:20px;">
                <button id="btn-remove-bg" class="button-secondary" style="background: #6f42c1; color: white;">✨ Remove Background</button>
                <button id="btn-save-img" class="button-primary">Save Changes</button>
            </div>
            
            <div id="ai-status" style="margin-top: 15px; font-size: 0.9rem; color: #666;"></div>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // --- ELEMENTS ---
    const imageEl = document.getElementById('img-editor-target');
    const cropperWrapper = document.getElementById('cropper-wrapper');
    const fileInput = document.getElementById('img-editor-input');
    const dropZone = document.getElementById('img-drop-zone');
    const status = document.getElementById('ai-status');
    const bgCheck = document.getElementById('bg-transparent-check');
    const bgGroup = document.getElementById('bg-color-picker-group');
    const bgColorInput = document.getElementById('bg-color-input');

    let cropper = null;

    // --- INIT CROPPER ---
    const initCropper = () => {
        if (cropper) cropper.destroy();
        cropper = new Cropper(imageEl, {
            aspectRatio: 1, 
            viewMode: 0, // Free movement    
            dragMode: 'move', 
            autoCropArea: 0.8,
            background: false, 
            checkCrossOrigin: false 
        });
    };

    imageEl.onload = () => initCropper();
    if (imageEl.complete) initCropper();

    // --- BACKGROUND LOGIC ---
    const updateBackground = () => {
        if (bgCheck.checked) {
            bgGroup.style.display = 'none';
            const canvasEl = document.querySelector('.cropper-canvas'); 
            if(canvasEl) canvasEl.style.backgroundColor = 'transparent';
            cropperWrapper.style.backgroundColor = 'transparent';
        } else {
            bgGroup.style.display = 'flex';
            const color = bgColorInput.value;
            const canvasEl = document.querySelector('.cropper-canvas'); 
            if(canvasEl) canvasEl.style.backgroundColor = color;
            cropperWrapper.style.backgroundColor = color;
        }
    };
    bgCheck.addEventListener('change', updateBackground);
    bgColorInput.addEventListener('input', updateBackground);

    // --- BUTTONS ---
    document.getElementById('btn-zoom-in').onclick = () => cropper.zoom(0.1);
    document.getElementById('btn-zoom-out').onclick = () => cropper.zoom(-0.1);
    document.getElementById('btn-rotate').onclick = () => cropper.rotate(90);
    document.getElementById('btn-reset').onclick = () => { cropper.reset(); updateBackground(); };

    // --- DRAG & DROP ---
    dropZone.onclick = () => fileInput.click();
    
    const handleFile = (file) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            if (cropper) {
                cropper.replace(e.target.result);
                setTimeout(updateBackground, 100);
            } else {
                imageEl.src = e.target.result;
                initCropper();
            }
        };
        reader.readAsDataURL(file);
        status.textContent = "New image loaded. Adjust positioning.";
    };

    fileInput.onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };
    dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#4d2909'; };
    dropZone.ondragleave = () => { dropZone.style.borderColor = '#ccc'; };
    dropZone.ondrop = (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    };

    // --- REMOVE BACKGROUND ---
    document.getElementById('btn-remove-bg').onclick = async () => {
        const btn = document.getElementById('btn-remove-bg');
        if (!cropper) return;
        
        // Use original image for better AI result, unless user has uploaded new one
        // Ideally we grab the blob from the cropper original URL if accessible, or current src
        const src = imageEl.src;
        
        if (src.includes('placeholder')) { uiUtils.showToast("Cannot process placeholder.", "error"); return; }

        status.innerHTML = `<span class="loading-spinner" style="font-size:1em;"></span> Processing AI removal...`;
        btn.disabled = true;

        try {
            const blob = await fetch(src).then(r => r.blob());
            const url = URL.createObjectURL(blob);

            if (!window.imglyRemoveBackground) {
                await loadScript("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.3.0/dist/imgly-background-removal.min.js");
            }

            const resultBlob = await imglyRemoveBackground(url);
            const resultUrl = URL.createObjectURL(resultBlob);
            
            cropper.replace(resultUrl);
            setTimeout(updateBackground, 100);
            
            status.textContent = "✨ Background removed!";
            uiUtils.showToast("Background removed!", "success");
        } catch (err) {
            console.error("AI Error:", err);
            status.innerHTML = `<span style="color:red">AI Error: ${err.message}</span>`;
            uiUtils.showToast("AI Removal Failed.", "error");
        } finally { btn.disabled = false; }
    };

    // --- SAVE ---
    document.getElementById('btn-save-img').onclick = async () => {
        if (!cropper) return;
        const btn = document.getElementById('btn-save-img');
        btn.textContent = "Uploading..."; btn.disabled = true;

        try {
            const fillColor = bgCheck.checked ? 'transparent' : bgColorInput.value;

            const canvas = cropper.getCroppedCanvas({ 
                width: 600, height: 600, 
                imageSmoothingEnabled: true, 
                imageSmoothingQuality: 'high',
                fillColor: fillColor
            });

            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const fileName = `menu-items/${item.id}-${Date.now()}.png`;

            const { error } = await supabase.storage.from('menu-images').upload(fileName, blob);
            if (error) throw error;
            
            const { data } = supabase.storage.from('menu-images').getPublicUrl(fileName);
            
            const { data: { session } } = await supabase.auth.getSession();
            await api.updateMenuItem(item.id, { image_url: data.publicUrl }, session.access_token);

            uiUtils.showToast("Image updated!", "success");
            useAppStore.getState().menu.fetchMenu();
            uiUtils.closeModal();

        } catch (err) {
            console.error(err);
            uiUtils.showToast("Save failed.", "error");
            btn.disabled = false;
            btn.textContent = "Save Changes";
        }
    };
}

// Helpers
function loadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}
function loadCSS(href) {
    return new Promise((resolve) => {
        if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.onload = resolve;
        document.head.appendChild(link);
    });
}