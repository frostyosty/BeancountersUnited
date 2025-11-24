// api/user.js
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const { type } = req.query; 
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) return res.status(500).json({ error: "Server Config Error" });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing Token" });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

    try {
        // PROFILE & ORDERS (Public to authenticated user)
        if (type === 'profile') {
            const { data } = await supabaseAdmin.from('profiles').select('*').eq('id', user.id).single();
            return res.status(200).json(data);
        }
        if (type === 'orders') {
            const { data } = await supabaseAdmin.from('orders').select(`*, order_items (*, menu_items (name, image_url))`).eq('user_id', user.id).order('created_at', { ascending: false });
            return res.status(200).json(data);
        }

        // --- ADMIN CHECKS (God/Owner Only) ---
        if (['manage', 'crm', 'manual_order'].includes(type)) {
            const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
            
            // FIX: Check for 'god' instead of 'manager'
            if (!adminProfile || (adminProfile.role !== 'god' && adminProfile.role !== 'owner')) {
                return res.status(403).json({ error: "Forbidden" });
            }
        }

        // TYPE: MANAGE (List/Update Users)
        if (type === 'manage') {
            if (req.method === 'GET') {
                const { data, error } = await supabaseAdmin
                    .from('profiles')
                    .select('*')
                    .order('created_at', { ascending: false });
                
                if (error) throw error;
                
                // FIX: Return empty array if data is null
                return res.status(200).json(data || []);
            }
            if (req.method === 'PUT') {
                const { userId, newRole, isVerifiedBuyer, canSeeOrderHistory } = req.body;
                await supabaseAdmin.from('profiles').update({ role: newRole, is_verified_buyer: isVerifiedBuyer, can_see_order_history: canSeeOrderHistory }).eq('id', userId);
                return res.status(200).json({ success: true });
            }
        }

        // TYPE: CRM
        if (type === 'crm') {
            const { userId } = req.method === 'GET' ? req.query : req.body;
            if (req.method === 'GET') {
                const { data: profile } = await supabaseAdmin.from('profiles').select('email, full_name, internal_nickname, staff_note, staff_note_urgency').eq('id', userId).single();
                const { data: history } = await supabaseAdmin.from('orders').select(`id, created_at, total_amount, status, order_items (quantity, menu_items (name))`).eq('user_id', userId).order('created_at', { ascending: false }).limit(10);
                const { data: logs } = await supabaseAdmin.from('audit_logs').select(`created_at, action_type, old_value, new_value, profiles:actor_id ( email, full_name )`).eq('target_user_id', userId).order('created_at', { ascending: false });
                return res.status(200).json({ profile, history, logs });
            }
            if (req.method === 'POST') {
                const { nickname, note, urgency } = req.body;
                const { data: old } = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single();
                
                const updates = {};
                const auditEntries = [];
                // ... (Audit logic same as before, just ensuring we save) ...
                if (nickname !== undefined && nickname !== old.internal_nickname) {
                    updates.internal_nickname = nickname;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NICKNAME', old_value: old.internal_nickname, new_value: nickname });
                }
                if (note !== undefined && note !== old.staff_note) {
                    updates.staff_note = note;
                    auditEntries.push({ actor_id: user.id, target_user_id: userId, action_type: 'UPDATE_NOTE', old_value: old.staff_note, new_value: note });
                }
                if (urgency !== undefined && urgency !== old.staff_note_urgency) {
                    updates.staff_note_urgency = urgency;
                }

                if (Object.keys(updates).length > 0) {
                    await supabaseAdmin.from('profiles').update(updates).eq('id', userId);
                    if (auditEntries.length > 0) await supabaseAdmin.from('audit_logs').insert(auditEntries);
                }
                return res.status(200).json({ success: true });
            }
        }

        // TYPE: MANUAL ORDER
        if (type === 'manual_order') {
            const { items, total, customerName } = req.body;
            const { data: order } = await supabaseAdmin.from('orders').insert([{
                user_id: user.id, total_amount: total, status: 'pending', payment_status: 'paid', payment_method: 'manual', customer_name: customerName || 'Walk-in'
            }]).select().single();
            
            const itemsData = items.map(i => ({ order_id: order.id, menu_item_id: i.id, quantity: i.quantity, price_at_time: i.price }));
            await supabaseAdmin.from('order_items').insert(itemsData);
            return res.status(200).json({ success: true, orderId: order.id });
        }

    } catch (error) {
        console.error("User API Error:", error);
        return res.status(500).json({ error: error.message });
    }
    return res.status(400).json({ error: "Invalid Request" });
}