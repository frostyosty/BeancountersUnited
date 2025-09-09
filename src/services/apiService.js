// src/services/apiService.js
console.log("--- [2] apiService.js: START ---");
async function request(endpoint, method = 'GET', body = null, token = null) {
    console.log(`--- apiService.request CALLED for endpoint: ${endpoint} ---`);
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
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


export const getOrderHistory = (token) => request('/user/orders', 'GET', null, token);

// --- User Profile API Functions ---
export const getUserProfile = (token) => request('/user/profile', 'GET', null, token);

// --- AUTH API FUNCTIONS ---
// These call OUR backend, not Supabase directly.
export const loginViaApi = (email, password) => request('/auth/login', 'POST', { email, password });
export const signUpViaApi = (email, password) => request('/auth/signup', 'POST', { email, password });


export const listAllUsers = (token) => request('/user/manage', 'GET', null, token);
export const updateUser = (userId, newRole, isVerifiedBuyer, canSeeOrderHistory, token) => {
    return request('/user/manage', 'PUT', { userId, newRole, isVerifiedBuyer, canSeeOrderHistory }, token);
};

export const addMenuItem = (itemData, token) => request('/menu', 'POST', itemData, token);
export const updateMenuItem = (itemId, itemData, token) => request(`/menu?id=${itemId}`, 'PUT', itemData, token);
export const deleteMenuItem = (itemId, token) => request(`/menu?id=${itemId}`, 'DELETE', null, token);

// --- Settings API Functions ---
// Anyone can read the settings
export const getSiteSettings = () => request('/settings', 'GET');

// Only authenticated users (owners/managers) can update settings
export const updateSiteSettings = (settingsData, token) => request('/settings', 'PUT', settingsData, token);

console.log("--- [2] apiService.js: END ---");