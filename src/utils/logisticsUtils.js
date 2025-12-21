// src/utils/logisticsUtils.js

// --- 1. PREP TIME CALCULATOR ---
export function calculateTotalPrepTime(cartItems, isDelivery = false) {
    let totalMinutes = 0;
    
    // Strategy: Sum of all items (Conservative). 
    // You could change this to Max(items) + (Count * Buffer) for parallel processing.
    cartItems.forEach(item => {
        const base = item.prep_time || 5; // Default 5 mins
        const extra = isDelivery ? (item.delivery_extra_time || 0) : 0;
        const quantity = item.quantity || 1;
        
        totalMinutes += (base + extra) * quantity;
    });

    // Add a base buffer (e.g. 5 mins for packing)
    return totalMinutes + 5;
}

// --- 2. DISTANCE CALCULATOR (Haversine Formula - Free) ---
// Returns distance in Kilometers
export function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of earth in km
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
        Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    const d = R * c; 
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI/180);
}

// --- 3. DELIVERY COST CALCULATOR ---
export function calculateDeliveryCost(distanceKm, config) {
    const base = parseFloat(config.baseFee) || 5.00;
    const perKm = parseFloat(config.feePerKm) || 1.00;
    const maxDist = parseFloat(config.maxDistanceKm) || 10;

    if (distanceKm > maxDist) return { allowed: false, cost: 0, reason: "Too far away" };
    
    const cost = base + (distanceKm * perKm);
    return { allowed: true, cost: parseFloat(cost.toFixed(2)) };
}

// --- 4. OPENING HOURS CHECK ---
export function isStoreOpen(openingHours) {
    if (!openingHours || !openingHours.enabled) return true; // Assume open if not configured

    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const today = days[now.getDay()];
    
    const todaysHours = openingHours[today];
    
    if (!todaysHours || !todaysHours.isOpen) return false;

    // Convert "08:00" to minutes
    const getMins = (timeStr) => {
        const [h, m] = timeStr.split(':');
        return parseInt(h) * 60 + parseInt(m);
    };

    const currentMins = now.getHours() * 60 + now.getMinutes();
    const startMins = getMins(todaysHours.start);
    const endMins = getMins(todaysHours.end);

    return currentMins >= startMins && currentMins < endMins;
}