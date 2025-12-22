import { ImageWarper } from './engine.js';
import { useAppStore } from '@/store/appStore.js';

export const warper = new ImageWarper();

export function smoothUpdateImage(imgId, newSrc) {
    // Get Config from Store
    let config = { duration: 40, effectZoom: 50, effectPixel: 0, effectSlide: 0 };
    try {
        const settings = useAppStore.getState().siteSettings.settings?.uiConfig;
        if (settings) {
            config = { ...config, ...settings };
        }
    } catch(e) {}

    const img = document.getElementById(imgId) || document.querySelector(`img[data-item-id="${imgId}"]`);
    if (img) warper.warp(img, newSrc, config);
}