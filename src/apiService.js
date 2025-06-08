// apiService.js
// This will centralize all calls to your Vercel Serverless Functions

async function request(endpoint, method = 'GET', body = null, requireAuth = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (requireAuth && supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
            headers['Authorization'] = `Bearer ${session.access_token}`;
        } else if (requireAuth) { // If auth is strictly required and no token, don't proceed
            console.error("Auth token required but not found.");
            // Potentially trigger login UI here or throw an error
            throw new Error("Authentication required.");
        }
    }

    const config = {
        method: method,
        headers: headers,
    };

    if (body) {
        config.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(`/api${endpoint}`, config);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: response.statusText }));
            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }
        if (response.status === 204) return null; // No content
        return await response.json();
    } catch (error) {
        console.error(`API call to ${endpoint} failed:`, error);
        throw error; // Re-throw to be handled by the caller
    }
}

const api = {
    getMenu: () => request('/menu'),
    addMenuItem: (itemData) => request('/menu', 'POST', itemData, true),
    updateMenuItem: (itemId, itemData) => request(`/menu/${itemId}`, 'PUT', itemData, true),
    deleteMenuItem: (itemId) => request(`/menu/${itemId}`, 'DELETE', true),

    submitOrder: (orderData) => request('/orders', 'POST', orderData), // Auth checked server-side for order > $10
    getOrders: () => request('/orders', 'GET', null, true), // Owner/manager only

    getSiteSettings: () => request('/settings'),
    updateSiteSettings: (settings) => request('/settings', 'PUT', settings, true), // Manager only

    getUserProfile: () => request('/user/profile', 'GET', null, true),
    updateUserProfile: (profileData) => request('/user/profile', 'PUT', profileData, true),
};