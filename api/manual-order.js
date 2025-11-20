// api/manual-order.js
import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        // 1. Security Check: Ensure user is logged in and is a Manager/Owner
        const { user, profile, error: authError } = await getUserFromRequest(req);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });
        
        if (profile.role !== 'manager' && profile.role !== 'owner') {
            return res.status(403).json({ error: "Only managers can create manual orders." });
        }

        const { items, total, customerName } = req.body;

        // 2. Insert Order (Bypassing RLS via supabaseAdmin)
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                user_id: user.id, // Attached to the admin user
                total_amount: total,
                status: 'pending',
                payment_status: 'paid', // Manual orders are usually paid on spot
                payment_method: 'manual'
            }])
            .select()
            .single();

        if (orderError) throw orderError;

        // 3. Insert Items
        const orderItemsData = items.map(item => ({
            order_id: orderData.id,
            menu_item_id: item.id,
            quantity: item.quantity,
            price_at_time: item.price
        }));

        const { error: itemsError } = await supabaseAdmin
            .from('order_items')
            .insert(orderItemsData);

        if (itemsError) throw itemsError;

        return res.status(200).json({ success: true, orderId: orderData.id });

    } catch (e) {
        console.error("Manual Order API Error:", e);
        return res.status(500).json({ error: e.message });
    }
}