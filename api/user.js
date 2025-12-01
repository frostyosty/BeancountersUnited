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
            // FIX: Added 'id, price' to the nested menu_items select
            const { data } = await supabaseAdmin
                .from('orders')
                .select(`
                    *,
                    order_items (
                        *,
                        menu_items (id, name, price, image_url)
                    )
                `)
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });
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
            const { items, total, customerName, dueTime, createdAt } = req.body; // Added createdAt

            // 1. Insert Order
            // Note: We DO NOT send customer_email here anymore. It will be NULL in the DB.
            const { data: order, error: orderError } = await supabaseAdmin.from('orders').insert([{
                user_id: user.id,
                total_amount: total,
                status: 'completed', // Past orders are auto-completed
                payment_status: 'paid',
                payment_method: 'manual_entry',
                customer_name: customerName || 'Walk-in',
                customer_email: null, // Explicitly null per new DB rule
                pickup_time: dueTime || new Date().toISOString(),
                created_at: createdAt || new Date().toISOString() // Allow back-dating
            }]).select().single();

            if (orderError || !order) {
                console.error("Manual Order Header Insert Failed:", orderError);
                throw new Error("Failed to create order header: " + (orderError?.message || "Unknown error"));
            }

            // 2. Insert Items (Unchanged)
            const itemsData = items.map(i => ({
                order_id: order.id,
                menu_item_id: i.id,
                quantity: i.quantity,
                price_at_order: i.price
            }));

            const { error: itemsError } = await supabaseAdmin.from('order_items').insert(itemsData);

            if (itemsError) throw new Error("Failed to create order items: " + itemsError.message);

            return res.status(200).json({ success: true, orderId: order.id });
        }

        // =================================================
        // TYPE: CLIENTS (CRM Data Aggregation)
        // =================================================
        if (type === 'clients') {
            if (req.method !== 'GET') return res.status(405).end();

            // 1. Fetch Profiles
            const { data: profiles, error: pError } = await supabaseAdmin
                .from('profiles')
                .select('id, email, full_name, internal_nickname, staff_note, created_at');

            if (pError) throw pError;

            // 2. Fetch Order Stats (Grouped)
            // Note: Supabase JS doesn't do complex SQL GROUP BY easily without Views or RPC.
            // We will fetch raw order headers and aggregate in JS (fast enough for <10k orders).
            // For production scaling, create a SQL View in Supabase.
            const { data: orders, error: oError } = await supabaseAdmin
                .from('orders')
                .select('user_id, total_amount, created_at, status');

            if (oError) throw oError;

            // 3. Aggregate Data
            const clientStats = {}; // { userId: { totalSpend: 0, lastOrder: date, orderCount: 0 } }

            orders.forEach(o => {
                if (!clientStats[o.user_id]) {
                    clientStats[o.user_id] = { totalSpend: 0, lastOrder: null, orderCount: 0 };
                }
                const stats = clientStats[o.user_id];

                // Only count completed/paid orders? Or all? Let's do all non-cancelled.
                if (o.status !== 'cancelled') {
                    stats.totalSpend += o.total_amount || 0;
                    stats.orderCount += 1;

                    const orderDate = new Date(o.created_at);
                    if (!stats.lastOrder || orderDate > stats.lastOrder) {
                        stats.lastOrder = orderDate;
                    }
                }
            });

            // 4. Merge
            const richClients = profiles.map(p => {
                const stats = clientStats[p.id] || { totalSpend: 0, lastOrder: null, orderCount: 0 };
                return {
                    ...p,
                    ...stats
                };
            });

            // Sort by Total Spend (High to Low) by default
            richClients.sort((a, b) => b.totalSpend - a.totalSpend);

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