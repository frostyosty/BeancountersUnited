import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { getHeaderEditorHTML } from './template.js';
import { initEditorLogic } from './logic.js';

export function openHeaderLogoEditor() {
    const { settings } = useAppStore.getState().siteSettings;
    let savedConfig = settings.headerLogoConfig;

    // Safety Parse
    if (typeof savedConfig === 'string') {
        try { savedConfig = JSON.parse(savedConfig); } 
        catch (e) { savedConfig = {}; }
    }

    // 1. Get HTML
    // We pass a simple display string for the text input derived from the saved config
    // Logic will handle complex array state
    let displayString = '';
    if (savedConfig?.mainText) {
        displayString = Array.isArray(savedConfig.mainText) 
            ? savedConfig.mainText.map(l => l.char).join('') 
            : savedConfig.mainText;
    } else {
        displayString = 'MEALMATES';
    }
    
    // Merge with defaults for initial UI population to avoid "undefined" in template
    // Note: logic.js does a deeper merge, this is just for initial HTML render
    const initialConfig = { ...savedConfig }; 

    const html = getHeaderEditorHTML(initialConfig, displayString);

    // 2. Show Modal
    uiUtils.showModal(html);

    // 3. Attach Logic
    initEditorLogic(savedConfig);
}