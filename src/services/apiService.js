// src/services/apiService.js
console.log("--- [2] apiService.js: START ---");
async function request(endpoint, method = 'GET', body = null, token = null) { // <-- Reverted to 'token'
    console.log(`--- apiService.request CALLED for endpoint: ${endpoint} ---`);
    const headers = { 'Content-Type': 'application/json' };

    // --- REVERTED LOGIC ---
    if (token) {
        console.log(`[apiService] Attaching token to Authorization header for ${endpoint}.`);
        headers['Authorization'] = `Bearer ${token}`;
    }
    // --- END REVERT ---

    const config = { method, headers };
    if (body) {
        config.body = JSON.stringify(body);
    }
      try {
        console.log(`apiService: Sending fetch request to /api${endpoint}`);
        const response = await fetch(`/api${endpoint}`, config);
        console.log(`apiService: Received response for ${endpoint}. Status: ${response.status}`);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `API request failed with status ${response.status}`);
        }
        
        // --- THIS IS THE FIX ---
        // Check for "No Content" status before trying to parse JSON.
        if (response.status === 204) {
            console.log(`apiService: Received 204 No Content for ${endpoint}. Returning null.`);
            return null; // Return null for empty responses
        }
        // --- END OF FIX ---

        const data = await response.json();
        console.log(`apiService: Successfully parsed JSON for ${endpoint}.`);
        return data;

    } catch (error) {
        console.error(`--- apiService.request FAILED for ${endpoint} ---`, error);
        throw error;
    }
}

// --- Menu API Functions ---
export const getMenu = () => request('/menu');


// export const getOrderHistory = () => request('/user/orders', 'GET', null, true);
// export const getUserProfile = () => request('/user/profile', 'GET', null, true);
// --- AUTH API FUNCTIONS ---
// These call OUR backend, not Supabase directly.
export const loginViaApi = (email, password) => request('/auth/login', 'POST', { email, password });
export const signUpViaApi = (email, password) => request('/auth/signup', 'POST', { email, password });


// export const listAllUsers = () => request('/user/manage', 'GET', null, true);
// export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory) => {
//     return request('/user/manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, true);
// };

export const addMenuItem = (itemData) => request('/menu', 'POST', itemData, true);
export const updateMenuItem = (itemId, itemData) => request(`/menu?id=${itemId}`, 'PUT', itemData, true);
export const deleteMenuItem = (itemId) => request(`/menu?id=${itemId}`, 'DELETE', null, true);

export const getOrderHistory = (token) => request('/user/orders', 'GET', null, token);
export const getUserProfile = (token) => request('/user/profile', 'GET', null, token);
export const listAllUsers = (token) => request('/user/manage', 'GET', null, token);
export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory, token) => {
    return request('/user/manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, token);
};
// --- Settings API Functions ---
// Anyone can read the settings
export const getSiteSettings = () => request('/settings', 'GET');

// Only authenticated users (owners/managers) can update settings
export const updateSiteSettings = (settingsData) => request('/settings', 'PUT', settingsData, true);

console.log("--- [2] apiService.js: END ---");