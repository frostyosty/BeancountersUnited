// api/menu.js - Example API endpoint for fetching menu items
// In a real app, you would import the admin client to fetch from the DB:
// import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    // Mock data for initial setup. Replace with a real DB call.
    const mockMenu = [
        { id: 'item-1', name: 'Margherita Pizza', description: 'Classic cheese and tomato', price: 12.99, category: 'Pizzas', image_url: '/placeholder-pizza.jpg' },
        { id: 'item-2', name: 'Cheeseburger', description: 'Juicy beef patty with cheddar cheese', price: 10.50, category: 'Burgers', image_url: '/placeholder-burger.jpg' },
        { id: 'item-3', name: 'Caesar Salad', description: 'Fresh romaine with Caesar dressing', price: 8.75, category: 'Salads', image_url: '/placeholder-salad.jpg' },
    ];

    if (req.method === 'GET') {
        // In a real app:
        // const { data, error } = await supabaseAdmin.from('menu_items').select('*');
        // if (error) return res.status(500).json({ error: error.message });
        // return res.status(200).json(data);

        return res.status(200).json(mockMenu);
    } else {
        res.setHeader('Allow', ['GET']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}