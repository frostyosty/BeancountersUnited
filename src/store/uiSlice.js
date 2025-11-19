// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    // Flattened State (Properties sit at the root of the slice)
    _reRenderTrigger: 0,
    activeMenuCategory: 'All',

    // Actions
    setActiveMenuCategory: (category) => {
        set((state) => ({
            ui: { ...state.ui, activeMenuCategory: category }
        }), false, 'ui/setActiveMenuCategory');
    },

    triggerPageRender: () => {
        console.log("%c[UiSlice] Triggering Page Render...", "color: pink; font-weight: bold;");
        set((state) => ({
            ui: { ...state.ui, _reRenderTrigger: state.ui._reRenderTrigger + 1 }
        }), false, 'ui/triggerPageRender');
    },
});