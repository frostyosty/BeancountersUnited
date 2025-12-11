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
        // TYPE: ORDERS (History / Live View)
        if (type === 'orders') {
            if (req.method !== 'GET') return res.status(405).end();

            // Check if Admin
            const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
            const isAdmin = profile && (profile.role === 'manager' || profile.role === 'owner' || profile.role === 'god');

            let query = supabaseAdmin
                .from('orders')
                .select(`
                    *,
                    order_items (
                        *,
                        menu_items (name, image_url)
                    ),
                    profiles (email, full_name, internal_nickname, staff_note, staff_note_urgency) -- Fetch Client Info
                `)
                .order('created_at', { ascending: false });

            // FIX: Only filter by user_id if NOT an admin
            if (!isAdmin) {
                query = query.eq('user_id', user.id);
            }

            const { data, error } = await query;
            if (error) throw error;
            
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
                const { data } = await supabaseAdmin.from('profiles').select('*').order('created_at', { ascending: false });
                return res.status(200).json(data || []);
            }
            if (req.method === 'PUT') {
                const { userId, newRole, isVerifiedBuyer, canSeeOrderHistory } = req.body;

                // FIX: Check for error!
                const { error } = await supabaseAdmin
                    .from('profiles')
                    .update({
                        role: newRole,
                        is_verified_buyer: isVerifiedBuyer,
                        can_see_order_history: canSeeOrderHistory
                    })
                    .eq('id', userId);

                if (error) {
                    console.error("Update Profile Failed:", error);
                    throw new Error(error.message);
                }
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

        // TYPE: MANUAL ORDER (Phone/Walk-in)
        // Beast 1: No limits, No email required, Managers Only.
        if (type === 'manual_order') {
            // FIX: Accept targetUserId
            const { items, total, customerName, dueTime, createdAt, targetUserId } = req.body;

            // If targetUserId is provided, use it. Otherwise, fallback to the Manager's ID (user.id)
            // We already verified the requester is a manager/owner above, so this is safe.
            const assignedUserId = targetUserId || user.id;

const { data: order, error: orderError } = await supabaseAdmin.from('orders').insert([{
                user_id: user.id, 
                total_amount: total, 
                // FIX: Change 'completed' to 'pending' so it shows in Live Orders
                status: 'pending', 
                payment_status: 'paid', 
                payment_method: 'manual_entry',
                customer_name: customerName || 'Walk-in',
                customer_email: null,
                pickup_time: dueTime || new Date().toISOString(),
                created_at: createdAt || new Date().toISOString()
            }]).select().single();

            if (orderError || !order) {
                console.error("Manual Order Header Insert Failed:", orderError);
                throw new Error("Failed to create order header: " + (orderError?.message || "Unknown error"));
            }

            // 2. Insert Items
            const itemsData = items.map(i => ({
                order_id: order.id,
                menu_item_id: i.id,
                quantity: i.quantity,
                price_at_order: i.price,
                selected_options: i.selectedOptions || [] // <--- SAVE THIS
            }));

            const { error: itemsError } = await supabaseAdmin.from('order_items').insert(itemsData);

            if (itemsError) throw new Error("Failed to create order items: " + itemsError.message);

            return res.status(200).json({ success: true, orderId: order.id });
        }

        // =================================================
        // TYPE: CLIENTS (CRM Data Aggregation)
        // =================================================
                 if (type === 'clients') {
            console.log("[API] Fetching Clients..."); // <--- LOG 1
            
            // 1. Fetch Profiles
            const { data: profiles, error: pError } = await supabaseAdmin
                .from('profiles')
                .select('*');
            
            if (pError) {
                console.error("[API] Profile Fetch Error:", pError); // <--- LOG 2
                throw pError;
            }
            console.log(`[API] Found ${profiles?.length || 0} profiles`); // <--- LOG 3

            // 2. Fetch Orders
            const { data: orders, error: oError } = await supabaseAdmin
                .from('orders')
                .select('user_id, total_amount, created_at, status');
            
            if (oError) {
                console.error("[API] Orders Fetch Error:", oError); // <--- LOG 4
                throw oError;
            }
            console.log(`[API] Found ${orders?.length || 0} orders`); // <--- LOG 5


            // 3. Aggregate
            const clientStats = {}; 
            orders.forEach(o => {
                if (!clientStats[o.user_id]) clientStats[o.user_id] = { totalSpend: 0, lastOrder: null, orderCount: 0 };
                const stats = clientStats[o.user_id];
                if (o.status !== 'cancelled') {
                    stats.totalSpend += (o.total_amount || 0);
                    stats.orderCount += 1;
                    const d = new Date(o.created_at);
                    if (!stats.lastOrder || d > stats.lastOrder) stats.lastOrder = d;
                }
            });

            // 4. Merge
            const richClients = profiles.map(p => ({
                ...p,
                ...(clientStats[p.id] || { totalSpend: 0, lastOrder: null, orderCount: 0 })
            }));

            // Sort by spend
            richClients.sort((a, b) => b.totalSpend - a.totalSpend);
            
            console.log(`[API] Returning ${richClients.length} rich clients`); // <--- LOG 6
            return res.status(200).json(richClients);
        }


        if (type === 'merge_clients') {
            if (req.method !== 'POST') return res.status(405).end();

            const { sourceId, targetId } = req.body;

            if (!sourceId || !targetId) return res.status(400).json({ error: "Missing IDs" });

            // 1. Move Orders
            const { error: orderError } = await supabaseAdmin
                .from('orders')
                .update({ user_id: targetId })
                .eq('user_id', sourceId);

            if (orderError) throw orderError;

            // 2. Move Audit Logs (if any)
            await supabaseAdmin
                .from('audit_logs')
                .update({ target_user_id: targetId })
                .eq('target_user_id', sourceId);

            // 3. Delete Source Profile (Optional, but keeps data clean)
            // Note: This might fail if other tables ref it, but usually safe after moving orders
            await supabaseAdmin.from('profiles').delete().eq('id', sourceId);

            return res.status(200).json({ success: true });
        }

    } catch (error) {
        console.error("User API Error:", error);
        return res.status(500).json({ error: error.message });
    }
    return res.status(400).json({ error: "Invalid Request" });
}