// src/store/appStore.js
// ... (imports)
import { createSiteSettingsSlice } from './siteSettingsSlice.js'; // <-- Import

export const useAppStore = create(
  devtools(
    (set, get) => ({
      menu: createMenuSlice(set, get),
      auth: createAuthSlice(set, get),
      cart: createCartSlice(set, get),
      siteSettings: createSiteSettingsSlice(set, get), // <-- Add the new slice
    }),
    { name: "RestaurantAppStore" }
  )
);

window.useAppStore = useAppStore;