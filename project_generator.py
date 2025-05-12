import os
import json
from pathlib import Path

def create_file_with_content(filepath, content=""):
    """Creates a file with the given content. Creates parent directories if they don't exist."""
    Path(filepath).parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"  Created: {filepath}")

def get_project_details():
    """Gets project details from the user."""
    project_name_raw = input("Enter project name (e.g., my-awesome-eats): ").strip()
    if not project_name_raw:
        print("Project name cannot be empty. Using 'restaurant-project'.")
        project_name_raw = "restaurant-project"
    
    project_name_slug = "".join(c if c.isalnum() or c in ['-','_'] else '-' for c in project_name_raw.lower()).strip('-')
    if not project_name_slug: # if only special chars were entered
        project_name_slug = "restaurant-project"

    print("\nChoose a default theme:")
    print("1. Default")
    print("2. Dark")
    theme_choice = input("Enter choice (1 or 2): ")
    selected_theme_file = "theme-default.css"
    include_dark_theme_file = False
    if theme_choice == '2':
        selected_theme_file = "theme-dark.css"
        include_dark_theme_file = True
    else:
        print("Defaulting to 'Default' theme.")

    print("\nChoose your database backend:")
    print("1. Supabase")
    print("2. Turso")
    db_choice = input("Enter choice (1 or 2): ")
    if db_choice == '2':
        db_type = "turso"
    else:
        db_type = "supabase"
        if db_choice != '1': # Only print default if not explicitly chosen
             print("Defaulting to 'Supabase'.")
        
    return project_name_slug, selected_theme_file, include_dark_theme_file, db_type

def generate_boilerplate(project_name, selected_theme_file, include_dark_theme_file, db_type):
    """Generates the project structure and files."""
    
    print(f"\nGenerating project: {project_name}")
    print(f"Selected theme CSS: {selected_theme_file}")
    print(f"Database backend: {db_type.capitalize()}")

    root_dir = Path(project_name)
    if root_dir.exists():
        print(f"\nWarning: Directory '{project_name}' already exists.")
        overwrite = input("Do you want to overwrite/add files to it? (yes/no): ").lower()
        if overwrite != 'yes':
            print("Aborting.")
            return
    root_dir.mkdir(exist_ok=True)

    # --- /public/ ---
    public_dir = root_dir / "public"
    public_dir.mkdir(exist_ok=True)

    # /public/index.html
    index_html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{project_name.replace('-', ' ').title()}</title>
    <link rel="stylesheet" href="css/style.css">
    <link rel="stylesheet" href="css/{selected_theme_file}" id="theme-link">
    {f'<link rel="stylesheet" href="css/theme-dark.css" media="(prefers-color-scheme: dark)">' if include_dark_theme_file else ""}
</head>
<body>
    <header>
        <h1>Welcome to {project_name.replace('-', ' ').title()}!</h1>
        <nav>
            <a href="#menu">Menu</a>
            <a href="#cart">Cart</a>
            <a href="#login">Login</a>
            {"<a href='#admin'>Admin</a>" if True else ""}
        </nav>
    </header>

    <main>
        <section id="menu">
            <h2>Our Menu</h2>
            {f'<!-- Menu items will be loaded here by js/main.js using API calls to /api/menu -->'}
        </section>

        <section id="cart-view" style="display:none;">
             <h2>Your Cart</h2>
             {f'<!-- Cart items and checkout by js/cart.js -->'}
        </section>
    </main>

    <footer>
        <p>© {2024} {project_name.replace('-', ' ').title()}. All rights reserved.</p>
    </footer>

    <script src="js/auth.js"></script>
    <script src="js/apiService.js"></script>
    <script src="js/ui.js"></script>
    <script src="js/cart.js"></script>
    <script src="js/main.js"></script>
    {"<script src='js/admin.js'></script>" if True else ""} 
</body>
</html>
"""
    create_file_with_content(public_dir / "index.html", index_html_content)

    # /public/css/
    css_dir = public_dir / "css"
    create_file_with_content(css_dir / "style.css", """/* General styles */
body { font-family: sans-serif; margin: 0; padding: 0; line-height: 1.6; }
header { background: #333; color: #fff; padding: 1rem; text-align: center; }
header nav a { color: #fff; margin: 0 10px; text-decoration: none; }
main { padding: 1rem; max-width: 1200px; margin: auto; }
footer { text-align: center; padding: 1rem; background: #f4f4f4; margin-top: 2rem; }
h1, h2 { margin-bottom: 0.5em; }
.button, button { padding: 10px 15px; border: none; cursor: pointer; border-radius: 4px; }
""")
    create_file_with_content(css_dir / "theme-default.css", """/* Default Theme */
body { background-color: #f8f9fa; color: #212529; }
header { background-color: #007bff; color: white; }
header nav a { color: #e9ecef; }
header nav a:hover { color: #ffffff; }
.button, button { background-color: #007bff; color: white; }
.button:hover, button:hover { background-color: #0056b3; }
footer { background-color: #e9ecef; color: #495057; }
""")
    if include_dark_theme_file or selected_theme_file == "theme-dark.css":
        create_file_with_content(css_dir / "theme-dark.css", """/* Dark Theme */
body { background-color: #121212; color: #e0e0e0; }
header { background-color: #1f1f1f; color: #bb86fc; }
header nav a { color: #cf6679; }
header nav a:hover { color: #f8bbd0; }
.button, button { background-color: #bb86fc; color: #000000; }
.button:hover, button:hover { background-color: #3700b3; }
footer { background-color: #1e1e1e; color: #a0a0a0; }
section { border: 1px solid #333; padding: 1rem; margin-bottom: 1rem; background: #1e1e1e; }
""")

    # /public/js/
    js_dir = public_dir / "js"

    js_email_param_identifier = "email"
    js_password_param_identifier = "password"
    dollar_sign = '$'
    # Define the literal string for JS destructuring
    js_create_client_literal_destructure = "{ createClient }"
    # Define literal string for passing {email, password} as an object if needed
    js_email_password_object_literal = f"{{ {js_email_param_identifier}, {js_password_param_identifier} }}"


    create_file_with_content(js_dir / "main.js", """// Main app logic, routing, component rendering
console.log("Main.js loaded");

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");
    // Basic navigation visibility (very simple example)
    const cartLink = document.querySelector('nav a[href="#cart"]');
    const cartView = document.getElementById('cart-view');
    const menuView = document.getElementById('menu');

    if (cartLink && cartView && menuView) {
        cartLink.addEventListener('click', (e) => {
            e.preventDefault();
            menuView.style.display = 'none';
            cartView.style.display = 'block';
        });
        // Could add more for other views
    }
    // Example: Fetch menu items on load
    // apiService.getMenu().then(menuItems => ui.renderMenu(menuItems));
});
""")
    
    # Corrected auth.js content generation
    auth_js_content = f"""// {db_type.capitalize()} authentication logic
console.log("Auth.js loaded for {db_type.capitalize()}");

const auth = {{
    // Example: Supabase client init
    // supabaseClient: null, 
    // init: () => {{
    //   if ('{db_type}' === 'supabase') {{
    //     // const {js_create_client_literal_destructure} = supabase; // Use the predefined Python string
    //     // auth.supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    //     console.log('{db_type.capitalize()} client to be initialized here');
    //   }} else if ('{db_type}' === 'turso') {{
    //     console.log('{db_type.capitalize()} auth might be handled differently (e.g. JWTs via API)');
    //   }}
    // }},
    login: async ({js_email_param_identifier}, {js_password_param_identifier}) => {{
        console.log(`Attempting login for {dollar_sign}{{{js_email_param_identifier}}} with {db_type.capitalize()}`);
        // Placeholder: call apiService.loginUser({js_email_password_object_literal}); // Use predefined Python string for JS object
        // Update UI based on response
        return Promise.resolve({{ success: true, user: {{ {js_email_param_identifier} }} }});
    }},
    logout: async () => {{
        console.log('Logging out');
        // Placeholder: call apiService.logoutUser()
        // Update UI
        return Promise.resolve(); // Mock
    }},
    getCurrentUser: async () => {{
        console.log('Getting current user');
        // Placeholder: Check local session or call apiService.fetchCurrentUser()
        return Promise.resolve(null); // Mock: no user logged in
    }}
}}; 

// auth.init(); // Call init if you have one
"""
    create_file_with_content(js_dir / "auth.js", auth_js_content)

    create_file_with_content(js_dir / "apiService.js", """// Functions to call your /api routes
console.log("ApiService.js loaded");

const API_BASE_URL = '/api';

const apiService = {
    getMenu: async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/menu`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error("Failed to fetch menu:", error);
            return []; // Return empty array on error
        }
    },

    submitOrder: async (orderData) => {
        try {
            const response = await fetch(`${API_BASE_URL}/orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error("Failed to submit order:", error);
            throw error; // Re-throw to handle in UI
        }
    },
    
    // Example user functions
    // loginUser: async (credentials) => { ... }
    // registerUser: async (userData) => { ... }
    // fetchUserProfile: async () => { ... }
    // updateSiteSettings: async (settings) => { ... }
};
""")
    create_file_with_content(js_dir / "ui.js", """// DOM manipulation helpers, modal, etc.
console.log("UI.js loaded");

const ui = {
    renderMenu: (menuItems) => {
        const menuSection = document.getElementById('menu');
        if (!menuSection) return;
        
        const existingItems = menuSection.querySelector('.menu-items-container');
        if(existingItems) existingItems.remove();

        const container = document.createElement('div');
        container.className = 'menu-items-container';

        if (!menuItems || menuItems.length === 0) {
            container.innerHTML = '<p>No menu items available at the moment. Please check back later.</p>';
        } else {
            menuItems.forEach(item => {
                const itemEl = document.createElement('div');
                itemEl.className = 'menu-item';
                itemEl.innerHTML = `
                    <h3>${item.name}</h3>
                    <p>${item.description}</p>
                    <p>Price: $${item.price.toFixed(2)}</p>
                    <button class="add-to-cart-btn" data-item-id="${item.id}">Add to Cart</button>
                `;
                container.appendChild(itemEl);
            });
        }
        menuSection.appendChild(container);
    },

    updateCartView: (cartItems) => {
        console.log("Updating cart view with:", cartItems);
    },

    showModal: (title, content) => {
        console.log(`Showing modal: ${title} - ${content}`);
        alert(`${title}\\n\\n${content}`); 
    },
    
    hideModal: () => {}
};
""")
    create_file_with_content(js_dir / "cart.js", """// Cart management logic
console.log("Cart.js loaded");

const cart = {
    items: [], 

    addItem: (item, quantity = 1) => {
        const existingItem = cart.items.find(i => i.item.id === item.id);
        if (existingItem) {
            existingItem.quantity += quantity;
        } else {
            cart.items.push({ item, quantity });
        }
        cart.saveCart();
        cart.updateCartUI();
        console.log(`${item.name} added to cart. Current cart:`, cart.items);
        ui.showModal("Cart Updated", `${item.name} added to cart.`);
    },

    removeItem: (itemId) => {
        cart.items = cart.items.filter(i => i.item.id !== itemId);
        cart.saveCart();
        cart.updateCartUI();
    },

    updateQuantity: (itemId, quantity) => {
        const itemInCart = cart.items.find(i => i.item.id === itemId);
        if (itemInCart) {
            itemInCart.quantity = quantity;
            if (itemInCart.quantity <= 0) {
                cart.removeItem(itemId);
            } else {
                cart.saveCart();
                cart.updateCartUI();
            }
        }
    },

    getTotal: () => {
        return cart.items.reduce((total, cartItem) => total + (cartItem.item.price * cartItem.quantity), 0);
    },

    clearCart: () => {
        cart.items = [];
        cart.saveCart();
        cart.updateCartUI();
    },

    saveCart: () => {
        localStorage.setItem('restaurantCart', JSON.stringify(cart.items));
    },

    loadCart: () => {
        const savedCart = localStorage.getItem('restaurantCart');
        if (savedCart) {
            cart.items = JSON.parse(savedCart);
        }
        cart.updateCartUI();
    },

    updateCartUI: () => {
        console.log("Cart UI needs to be updated. Total:", cart.getTotal());
    }
};
document.addEventListener('DOMContentLoaded', cart.loadCart);
""")
    create_file_with_content(js_dir / "admin.js", """// Owner/Manager specific UI and logic
console.log("Admin.js loaded");
""")

    # /public/images/
    images_dir = public_dir / "images"
    images_dir.mkdir(exist_ok=True)
    create_file_with_content(images_dir / "placeholder-burger.jpg", "This is a placeholder for burger.jpg")
    create_file_with_content(images_dir / "placeholder-pizza.jpg", "This is a placeholder for pizza.jpg")
    create_file_with_content(images_dir / "placeholder-salad.jpg", "This is a placeholder for salad.jpg")


    # --- /api/ ---
    api_dir = root_dir / "api"
    api_dir.mkdir(exist_ok=True)

    db_js_content = ""
    if db_type == "supabase":
        db_js_content = """// Shared DB client initialization (Supabase)
// Make sure to install the Supabase client: npm install @supabase/supabase-js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
    console.error("Supabase URL or Anon Key is not defined.");
}
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
"""
    elif db_type == "turso":
        db_js_content = """// Shared DB client initialization (Turso)
// Make sure to install the Turso client: npm install @libsql/client
import { createClient } from '@libsql/client';

const tursoDbUrl = process.env.TURSO_DATABASE_URL;
const tursoAuthToken = process.env.TURSO_AUTH_TOKEN;

if (!tursoDbUrl) {
    console.error("Turso Database URL is not defined.");
}
const config = { url: tursoDbUrl };
if (tursoAuthToken) {
    config.authToken = tursoAuthToken;
}
export const dbClient = createClient(config);
"""
    create_file_with_content(api_dir / "_db.js", db_js_content)
    
    api_handler_template = """// API route for {entity}
// Example using {db_type} (import from _db.js)
// import {{ {db_client_var} }} from './_db.js';

export default async function handler(req, res) {{
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {{
        return res.status(200).end();
    }}

    const exampleData = [
        {{ id: 1, name: '{entity} Item 1', description: 'Description 1', price: 10.99 }},
        {{ id: 2, name: '{entity} Item 2', description: 'Description 2', price: 12.50 }},
    ];

    if (req.method === 'GET') {{
        console.log(`GET request to /{entity}`);
        res.status(200).json(exampleData);
    }}
    else if (req.method === 'POST') {{
        console.log(`POST request to /{entity} with body:`, req.body);
        res.status(201).json({{ message: '{entity_singular} created successfully', data: req.body || exampleData[0] }});
    }}
    else if (req.method === 'PUT') {{
        console.log(`PUT request to /{entity}/${{req.query.id || 'item'}} with body:`, req.body);
        res.status(200).json({{ message: `{entity_singular} updated successfully`, data: req.body || exampleData[0] }});
    }}
    else if (req.method === 'DELETE') {{
        console.log(`DELETE request to /{entity}/${{req.query.id || 'item'}}`);
        res.status(200).json({{ message: `{entity_singular} deleted successfully`}});
    }}
    else {{
        res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
        res.status(405).end(`Method ${{req.method}} Not Allowed`);
    }}
}}
"""
    db_client_var = "supabase" if db_type == "supabase" else "dbClient"

    create_file_with_content(api_dir / "menu.js", api_handler_template.format(entity="menu", entity_singular="menu item", entity_table="menu_items", db_type=db_type.capitalize(), db_client_var=db_client_var))
    create_file_with_content(api_dir / "orders.js", api_handler_template.format(entity="orders", entity_singular="order", entity_table="orders", db_type=db_type.capitalize(), db_client_var=db_client_var))
    create_file_with_content(api_dir / "user.js", api_handler_template.format(entity="users", entity_singular="user profile", entity_table="user_profiles", db_type=db_type.capitalize(), db_client_var=db_client_var))
    create_file_with_content(api_dir / "settings.js", api_handler_template.format(entity="settings", entity_singular="setting", entity_table="site_settings", db_type=db_type.capitalize(), db_client_var=db_client_var))
    
    auth_callback_content = """// Optional OAuth callback handler
export default async function handler(req, res) {
    console.log("Auth callback received:", req.query);
    res.status(200).json({ message: "Auth callback processed.", query: req.query });
}
"""
    create_file_with_content(api_dir / "auth-callback.js", auth_callback_content)

    # --- Root files ---
    vercel_json_content = {
        "version": 2,
        "builds": [{"src": "api/**/*.js", "use": "@vercel/node"}, {"src": "public/**/*", "use": "@vercel/static"}],
        "routes": [
            {"src": "/api/(.*)", "dest": "/api/$1"},
            {"src": "/(.*\\.(css|js|html|jpg|jpeg|png|gif|svg|ico|json|txt))", "dest": "/public/$1"},
            {"handle": "filesystem"},
            {"src": "/(.*)", "dest": "/public/index.html"}
        ]
    }
    create_file_with_content(root_dir / "vercel.json", json.dumps(vercel_json_content, indent=2))

    dependencies = {}
    if db_type == "supabase": dependencies["@supabase/supabase-js"] = "^2.0.0"
    elif db_type == "turso": dependencies["@libsql/client"] = "^0.5.0"
    
    package_json_content = {
        "name": project_name, "version": "0.1.0", "private": True,
        "description": f"Boilerplate for {project_name}",
        "main": "public/js/main.js",
        "scripts": {
            "dev": "echo \"Hint: Use 'vercel dev'\"",
            "start": "echo \"Hint: Deploy to Vercel or serve /public statically.\"",
            "build": "echo \"No explicit client-side build step configured.\"",
            "lint": "echo \"Linters not set up.\""
        },
        "dependencies": dependencies, "devDependencies": {}
    }
    create_file_with_content(root_dir / "package.json", json.dumps(package_json_content, indent=2))

    env_local_content = "# Local environment variables (DO NOT COMMIT)\n\n"
    if db_type == "supabase":
        env_local_content += "SUPABASE_URL=your_supabase_project_url\nSUPABASE_ANON_KEY=your_supabase_public_anon_key\n"
    elif db_type == "turso":
        env_local_content += "TURSO_DATABASE_URL=libsql://your-db-name-user.turso.io\nTURSO_AUTH_TOKEN=your_turso_auth_token\n"
    create_file_with_content(root_dir / ".env.local", env_local_content)
    
    env_example_content = env_local_content.replace("your_...", "replace_with_your_...").replace("(DO NOT COMMIT)", "(Example values)")
    create_file_with_content(root_dir / ".env.example", env_example_content)

    gitignore_content = """# Dependencies
/node_modules

# Build outputs
/dist
/build
/.vercel
/.vercel/output

# Local Environment Variables
.env.local
.env.*.local
!.env.example

# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# OS generated files
.DS_Store
Thumbs.db

# IDEs and editors
.vscode/
.idea/
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
"""
    create_file_with_content(root_dir / ".gitignore", gitignore_content)

    print(f"\nProject '{project_name}' generated successfully!")
    print("Next steps:")
    print(f"1. cd {project_name}")
    print("2. Edit .env.local with your credentials.")
    print("3. Run 'npm install' (or yarn/pnpm).")
    print("4. Try 'vercel dev' for local development.")

if __name__ == "__main__":
    project_name_input, theme_file, include_dark, db_type_input = get_project_details()
    generate_boilerplate(project_name_input, theme_file, include_dark, db_type_input)