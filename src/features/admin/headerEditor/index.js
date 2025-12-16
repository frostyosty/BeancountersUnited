// src/features/admin/headerEditor/index.js
import * as uiUtils from '@/utils/uiUtils.js';
import { useAppStore } from '@/store/appStore.js';
import { getHeaderEditorHTML } from './template.js';
import { initEditorLogic } from './logic.js';

export function openHeaderLogoEditor() {
    const { settings } = useAppStore.getState().siteSettings;
    let savedConfig = settings.headerLogoConfig;

    // Safety Parse (Legacy Support)
    if (typeof savedConfig === 'string') {
        try { savedConfig = JSON.parse(savedConfig); } 
        catch (e) { savedConfig = {}; }
    }

    // Prepare Display String for the Template
    let displayString = 'MEALMATES';
    if (savedConfig?.mainText) {
        displayString = Array.isArray(savedConfig.mainText) 
            ? savedConfig.mainText.map(l => l.char).join('') 
            : savedConfig.mainText;
    }
    
    const initialConfig = { ...savedConfig };

    // 1. Get HTML
    const html = getHeaderEditorHTML(initialConfig, displayString);

    // 2. Show Modal
    uiUtils.showModal(html);

    // 3. Attach Logic
    initEditorLogic(savedConfig); // Pass the raw config object
}