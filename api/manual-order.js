// api/manual-order.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; 

        if (!supabaseUrl || !supabaseServiceKey) {
            return res.status(500).json({ error: "Server Configuration Error: Missing API Keys." });
        }

        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Missing Auth Token" });

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) return res.status(401).json({ error: "Invalid Token" });

        // Verify Role
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();

        if (!profile || (profile.role !== 'manager' && profile.role !== 'owner')) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const { items, total, customerName } = req.body; // <--- Extract customerName

        // Insert Order
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                user_id: user.id,
                total_amount: total,
                status: 'pending',
                payment_status: 'paid',
                payment_method: 'manual',
                // FIX: Pass the name, defaulting to 'Walk-in' if empty
                customer_name: customerName || 'Walk-in Customer' 
            }])
            .select()
            .single();

        if (orderError) throw new Error(`Order Insert Failed: ${orderError.message}`);
        
        // Insert Items
        const orderItemsData = items.map(item => ({
            order_id: orderData.id,
            menu_item_id: item.id,
            quantity: item.quantity,
            price_at_time: item.price
        }));

        const { error: itemsError } = await supabaseAdmin
            .from('order_items')
            .insert(orderItemsData);

        if (itemsError) throw new Error(`Items Insert Failed: ${itemsError.message}`);

        return res.status(200).json({ success: true, orderId: orderData.id });

    } catch (e) {
        console.error("Manual Order CRASH:", e);
        return res.status(500).json({ error: e.message });
    }
}