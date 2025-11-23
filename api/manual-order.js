// api/manual-order.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    console.log("--- [ManualOrder API] Request received ---");

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // 1. Initialize Supabase Admin Client DIRECTLY here to debug auth issues
        const supabaseUrl = process.env.VITE_SUPABASE_URL;
        // CRITICAL: We need the SERVICE_ROLE_KEY for admin bypass, NOT the Anon key
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY; 

        if (!supabaseUrl || !supabaseServiceKey) {
            console.error("CRITICAL ERROR: Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY in .env");
            return res.status(500).json({ error: "Server Configuration Error: Missing API Keys." });
        }

        const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

        // 2. Validate Token (Get User ID)
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: "Missing Auth Token" });

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            console.error("Auth Failed:", authError);
            return res.status(401).json({ error: "Invalid Token" });
        }

        // 3. Verify Role
        // We must check the profile manually since we are using admin client
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();

        if (!profile || (profile.role !== 'manager' && profile.role !== 'owner')) {
            return res.status(403).json({ error: `Forbidden. User role is: ${profile?.role}` });
        }

        // 4. Parse Body
        const { items, total } = req.body;
        console.log(`Processing Order for: ${req.body.customerName || 'Guest'} ($${total})`);

        // 5. Insert Order
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert([{
                user_id: user.id,
                total_amount: total,
                status: 'pending',
                payment_status: 'paid',
                payment_method: 'manual'
            }])
            .select()
            .single();

        if (orderError) throw new Error(`Order Insert Failed: ${orderError.message}`);

        // 6. Insert Items
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

        console.log("Manual Order Success:", orderData.id);
        return res.status(200).json({ success: true, orderId: orderData.id });

    } catch (e) {
        console.error("Manual Order CRASH:", e);
        return res.status(500).json({ error: e.message });
    }
}