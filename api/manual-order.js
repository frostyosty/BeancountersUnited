// api/manual-order.js
import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    // 1. Method Check
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // 2. Body Validation
        const { items, total } = req.body || {}; // Safety fallbacks
        
        // Debug Log (Check your Vercel/Server logs to see this)
        console.log("Manual Order Payload:", JSON.stringify(req.body));

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: "Invalid or empty 'items' array." });
        }
        if (total === undefined || total === null) {
            return res.status(400).json({ error: "Missing 'total' amount." });
        }

        // 3. Security Check
        const { user, profile, error: authError } = await getUserFromRequest(req);
        if (authError || !user) {
            console.error("Auth Error:", authError);
            return res.status(401).json({ error: "Unauthorized: User not found." });
        }
        
        if (profile?.role !== 'manager' && profile?.role !== 'owner') {
            return res.status(403).json({ error: "Forbidden: Only managers/owners can create manual orders." });
        }

        // 4. Insert Order Header
        // Note: We use 'paid' immediately for manual orders
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                user_id: user.id,
                total_amount: total,
                status: 'pending',
                payment_status: 'paid', 
                payment_method: 'manual' // Ensure your DB allows this string, or use 'cash'
            }])
            .select()
            .single();

        if (orderError) {
            console.error("DB Order Insert Error:", orderError);
            throw new Error(`Failed to insert order: ${orderError.message}`);
        }

        // 5. Insert Order Items
        // Map carefully to ensure no undefined values
        const orderItemsData = items.map(item => {
            if (!item.id || !item.price) {
                throw new Error(`Invalid item data detected: ${JSON.stringify(item)}`);
            }
            return {
                order_id: orderData.id,
                menu_item_id: item.id,
                quantity: item.quantity || 1,
                price_at_time: item.price
            };
        });

        const { error: itemsError } = await supabaseAdmin
            .from('order_items')
            .insert(orderItemsData);

        if (itemsError) {
            console.error("DB Items Insert Error:", itemsError);
            throw new Error(`Failed to insert items: ${itemsError.message}`);
        }

        return res.status(200).json({ success: true, orderId: orderData.id });

    } catch (e) {
        console.error("Manual Order API CRASH:", e);
        // Return the actual error message to the frontend for easier debugging
        return res.status(500).json({ error: e.message || "Internal Server Error" });
    }
}