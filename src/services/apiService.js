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

// Remove the hardcoded 'true' and accept 'token' as an argument
// We now accept 'token' as the last argument and pass it to request()

export const addMenuItem = (itemData, token) => request('/menu', 'POST', itemData, token);

export const updateMenuItem = (itemId, itemData, token) => request(`/menu?id=${itemId}`, 'PUT', itemData, token);

export const deleteMenuItem = (itemId, token) => request(`/menu?id=${itemId}`, 'DELETE', null, token);

export const updateSiteSettings = (settingsData, token) => request('/settings', 'PUT', settingsData, token);

export const getOrderHistory = (token) => request('/user/orders', 'GET', null, token);
export const getUserProfile = (token) => request('/user/profile', 'GET', null, token);
export const listAllUsers = (token) => request('/user/manage', 'GET', null, token);
export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory, token) => {
    return request('/user/manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, token);
};
// --- Settings API Functions ---
// Anyone can read the settings
export const getSiteSettings = () => request('/settings', 'GET');

export const createManualOrder = (orderData, token) => request('/manual-order', 'POST', orderData, token);

// --- CRM Functions ---
export const getCustomerDetails = (userId, token) => 
    request(`/user/crm?userId=${userId}`, 'GET', null, token);

export const updateCustomerDetails = (data, token) => 
    request('/user/crm', 'POST', data, token);

console.log("--- [2] apiService.js: END ---");