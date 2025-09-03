// src/services/apiService.js

// This function is now simpler and has no dependencies on the supabase client.
async function request(endpoint, method = 'GET', body = null, token = null) {
    const headers = { 'Content-Type': 'application/json' };

    // If a token is provided, add the Authorization header.
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const config = { method, headers };
    if (body) {
        config.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(`/api${endpoint}`, config);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `API request failed with status ${response.status}`);
        }
        if (response.status === 204) return null;
        return await response.json();
    } catch (error) {
        console.error(`API Error for ${method} ${endpoint}:`, error);
        throw error;
    }
}

// --- Menu API Functions ---
// Public endpoints don't need a token.
export const getMenu = () => request('/menu');

// --- User Profile API Functions ---
// Protected endpoints will need the token passed to them.
export const getUserProfile = (token) => request('/user/profile', 'GET', null, token);



// Update submitOrder to accept and pass the token
export const submitOrder = (orderData, token) => request('/orders', 'POST', orderData, token);