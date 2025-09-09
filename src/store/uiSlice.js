// src/store/uiSlice.js
export const createUiSlice = (set) => ({
    activeMenuCategory: 'All', // The default active category

    setActiveMenuCategory: (category) => {
        set({ activeMenuCategory: category });
    },
});