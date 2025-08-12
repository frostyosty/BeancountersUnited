import os
import json
from pathlib import Path
import textwrap

# --- Helper Functions ---

def create_file_with_content(filepath_str, content=""):
    """Creates a file with the given content, ensuring parent directories exist."""
    filepath = Path(filepath_str)
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, 'w', encoding='utf-8') as f:
        # textwrap.dedent removes common leading whitespace from multiline strings,
        # making the python source code cleaner.
        f.write(textwrap.dedent(content).strip())
    print(f"  Created: {filepath}")

def get_project_details():
    """Gets project details from the user."""
    # Project Name
    project_name_raw = input("Enter your restaurant's project name (e.g., my-awesome-eats): ").strip()
    if not project_name_raw:
        print("Project name cannot be empty. Using 'restaurant-project'.")
        project_name_raw = "restaurant-project"

    project_name_slug = "".join(c if c.isalnum() or c in ['-','_'] else '-' for c in project_name_raw.lower()).strip('-')
    if not project_name_slug:
        project_name_slug = "restaurant-project"

    # Restaurant Display Name
    restaurant_name_default = project_name_raw.replace('-', ' ').replace('_', ' ').title()
    restaurant_name_display = input(f"Enter the display name for the restaurant (press Enter for '{restaurant_name_default}'): ").strip()
    if not restaurant_name_display:
        restaurant_name_display = restaurant_name_default

    # Theme Accent Color
    theme_color_default = "#e67e22" # A nice orange
    theme_accent_color = input(f"Enter the primary theme/accent color (hex, e.g., #e67e22) (press Enter for default orange): ").strip()
    if not theme_accent_color or not theme_accent_color.startswith('#'):
        theme_accent_color = theme_color_default

    return {
        "project_name_slug": project_name_slug,
        "restaurant_name_display": restaurant_name_display,
        "theme_accent_color": theme_accent_color,
    }


# --- Content Definitions (will be used in the main generator function) ---

def get_package_json_content(project_name):
    # Using json.dumps is the safest way to generate JSON content
    package_data = {
      "name": project_name,
      "private": True,
      "version": "1.0.0",
      "type": "module",
      "scripts": {
        "dev": "vite",
        "build": "vite build",
        "preview": "vite preview",
        "format": "prettier --write . --ignore-path .gitignore",
        "lint": "stylelint \"src/**/*.css\""
      },
      "dependencies": {
        "@supabase/supabase-js": "^2.43.4",
        "zustand": "^4.5.2"
      },
      "devDependencies": {
        "prettier": "^3.3.2",
        "stylelint": "^16.6.1",
        "stylelint-config-standard": "^36.0.0",
        "vite": "^5.3.1",
        "vite-plugin-pwa": "^0.20.0",
        "postcss": "^8.4.38",
        "postcss-merge-rules": "^7.0.0",
        "css-declaration-sorter": "^7.2.0",
        "cssnano": "^7.0.1"
      }
    }
    return json.dumps(package_data, indent=2)

def get_vite_config_content(details):
    # Here we use .format() to safely insert variables into the JS code string
    return """
    import {{ defineConfig }} from 'vite';
    import {{ VitePWA }} from 'vite-plugin-pwa';
    import path from 'path';

    export default defineConfig({{
      build: {{
        outDir: 'dist',
      }},
      resolve: {{
        alias: {{
          '@': path.resolve(__dirname, './src'),
        }},
      }},
      plugins: [
        VitePWA({{
          registerType: 'autoUpdate',
          injectRegister: 'auto',
          includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'default-favicon.svg'],
          manifest: {{
            name: '{restaurant_name_display}',
            short_name: '{short_name}',
            description: 'Order delicious food for pickup from {restaurant_name_display}.',
            theme_color: '{theme_accent_color}',
            background_color: '#ffffff',
            start_url: '/',
            display: 'standalone',
            orientation: 'portrait',
            icons: [
              {{
                src: 'pwa-192x192.png',
                sizes: '192x192',
                type: 'image/png',
              }},
              {{
                src: 'pwa-512x512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any maskable',
              }},
            ],
          }},
        }}),
      ],
    }});
    """.format(
        restaurant_name_display=details["restaurant_name_display"],
        short_name=details["restaurant_name_display"].replace(" ", ""),
        theme_accent_color=details["theme_accent_color"]
    )

def get_vercel_json_content():
    # json.dumps is perfect for this
    vercel_data = {
      "version": 2,
      "builds": [
        {
          "src": "api/**/*.js",
          "use": "@vercel/node"
        },
        {
          "src": "package.json",
          "use": "@vercel/static-build",
          "config": {
            "distDir": "dist"
          }
        }
      ],
      "routes": [
        { "src": "/api/(.*)", "dest": "/api/$1" },
        { "src": "/assets/(.*)", "dest": "/dist/assets/$1" },
        { "src": "/(.*\\.(?:ico|png|svg|jpg|jpeg|webmanifest))", "dest": "/dist/$1" },
        { "src": "/(.*)", "dest": "/dist/index.html" }
      ]
    }
    return json.dumps(vercel_data, indent=2)

def get_postcss_config_content():
    return """
    module.exports = {
      plugins: [
        require('postcss-merge-rules'),
        require('css-declaration-sorter')({ order: 'alphabetical' }),
        require('cssnano')({ preset: 'default' }),
      ],
    };
    """

def get_stylelintrc_content():
    # json.dumps for safety
    stylelint_data = { "extends": "stylelint-config-standard" }
    return json.dumps(stylelint_data, indent=2)

def get_gitignore_content():
    return """
    # Dependencies
    /node_modules

    # Build outputs
    /dist
    /.vercel

    # Local Environment Variables
    .env
    .env.local
    .env.*.local
    !.env.example

    # Logs
    logs
    *.log
    npm-debug.log*
    yarn-debug.log*
    pnpm-debug.log*

    # OS generated files
    .DS_Store
    Thumbs.db

    # IDEs and editors
    .vscode/
    .idea/
    """

def get_readme_content(details):
    return """
    # {restaurant_name_display}

    This project is a modern, customizable website for ordering food, built with Vite, Supabase, and Zustand.

    ## Getting Started

    ### 1. Prerequisites
    - Node.js (v18 or higher recommended)
    - Vercel CLI (for local development with serverless functions)
    - A Supabase project

    ### 2. Setup
    1.  Clone the repository.
    2.  Create a `.env.local` file by copying from `.env.example` and fill in your Supabase project URL and Anon Key.
    3.  Install dependencies:
        ```bash
        npm install
        ```

    ### 3. Local Development
    To run the Vite frontend and Vercel serverless functions together, use the Vercel CLI:
    ```bash
    vercel dev
    ```
    This will start a local server, typically on `http://localhost:3000`.

    ## Project Structure
    - **/api**: Contains all Vercel serverless functions (backend).
    - **/public**: Static assets (favicons, PWA icons) that are copied directly to the build output.
    - **/src**: The main source code for the frontend application.
      - **/src/assets**: CSS files and images imported by the application.
      - **/src/components**: Reusable UI components (e.g., modals, buttons).
      - **/src/features**: Self-contained feature modules (e.g., menu, cart, admin).
      - **/src/services**: Modules that interact with external services or APIs.
      - **/src/store**: Zustand state management store.
      - **/src/utils**: General utility functions.
    - **/index.html**: The main HTML entry point shell for the SPA.
    - **/vite.config.js**: Vite build configuration.
    - **/vercel.json**: Vercel deployment and routing configuration.
    """.format(restaurant_name_display=details["restaurant_name_display"])

def get_index_html_content(details):
    return """
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <link id="dynamic-favicon" rel="icon" type="image/svg+xml" href="/default-favicon.svg" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{restaurant_name_display}</title>
        <meta name="description" content="Order delicious food from {restaurant_name_display}">
        <meta name="theme-color" content="{theme_accent_color}">
      </head>
      <body>
        <div id="app">
          <div class="initial-loader">
            <!-- You can put a simple loading spinner SVG or animation here -->
            <p>Loading {restaurant_name_display}...</p>
          </div>
        </div>
        <script type="module" src="/src/main.js"></script>
      </body>
    </html>
    """.format(
        restaurant_name_display=details["restaurant_name_display"],
        theme_accent_color=details["theme_accent_color"]
    )

def get_src_main_js_content():
    return """
    // src/main.js - The main entry point and application orchestrator

    import './assets/css/style.css';
    import { useAppStore } from './store/appStore';
    // Import feature initializers as you create them
    // import { initializeAuthFeature } from './features/auth/authFeature';
    // import { initializeMenuFeature } from './features/menu/menuFeature';
    // import { initializeRouter } from './router';

    async function main() {
        console.log("App Initializing...");

        // Example of an initial action
        // await useAppStore.getState().auth.checkUserSession();

        // Initialize features
        // initializeAuthFeature();
        // initializeMenuFeature();

        // Initialize the router to render the initial page
        // initializeRouter();

        console.log("App Initialized.");
        const appElement = document.getElementById('app');
        if (appElement) {
            // Clear the initial loader and show the main app structure
            appElement.innerHTML = `
                <header id="main-header"></header>
                <main id="main-content"></main>
                <footer id="main-footer"></footer>
            `;
            // Components will render their content into these containers
        }
    }

    // Start the application
    main();
    """

def get_src_style_css_content(details):
    return """
    /* src/assets/css/style.css */

    /* Define CSS variables for theming in the :root */
    :root {{
        --primary-color: {theme_accent_color};
        --secondary-color: #6c757d;
        --background-color: #ffffff;
        --surface-color: #f8f9fa;
        --text-color: #212529;
        --border-color: #dee2e6;
        --border-radius: 0.25rem;
        --font-family-sans-serif: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", "Liberation Sans", Arial, sans-serif;
    }}

    /* Example of a dark theme override, toggled by a class on the <html> element */
    html.dark {{
        --primary-color: #f9826c; /* A lighter orange for dark mode */
        --secondary-color: #8c96a2;
        --background-color: #121212;
        --surface-color: #1e1e1e;
        --text-color: #e0e0e0;
        --border-color: #333;
    }}

    /* Basic Reset & Global Styles */
    *, *::before, *::after {{
        box-sizing: border-box;
    }}

    body {{
        margin: 0;
        font-family: var(--font-family-sans-serif);
        font-size: 1rem;
        font-weight: 400;
        line-height: 1.5;
        color: var(--text-color);
        background-color: var(--background-color);
        -webkit-font-smoothing: antialiased;
        transition: color 0.2s, background-color 0.2s;
    }}

    #app {{
        min-height: 100vh;
        display: flex;
        flex-direction: column;
    }}

    main {{
        flex-grow: 1;
        width: 100%;
        max-width: 1200px;
        margin: 0 auto;
        padding: 1rem;
    }}

    .initial-loader {{
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        font-size: 1.5rem;
    }}
    """.format(theme_accent_color=details["theme_accent_color"])

def get_src_supabase_client_js_content():
    return """
    // src/supabaseClient.js
    import { createClient } from '@supabase/supabase-js';

    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
        throw new Error("Supabase credentials are not set in environment variables. Please create a .env.local file with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
    }

    export const supabase = createClient(supabaseUrl, supabaseAnonKey);
    """

def get_src_app_store_js_content():
    return """
    // src/store/appStore.js
    import { create } from 'zustand';
    import { devtools } from 'zustand/middleware';
    // Import slice creators as you build them
    // import { createAuthSlice } from './authSlice';
    // import { createCartSlice } from './cartSlice';

    export const useAppStore = create(
      devtools(
        (...args) => ({
          // ...createAuthSlice(...args),
          // ...createCartSlice(...args),
          // Add more slices here as you create them
        }),
        { name: "RestaurantAppStore" }
      )
    );
    """

def get_env_example_content():
    return """
    # Supabase credentials. Get these from your Supabase project settings.
    # The VITE_ prefix is required for Vite to expose these to the client-side code.
    VITE_SUPABASE_URL="https://your-project-id.supabase.co"
    VITE_SUPABASE_ANON_KEY="your-public-anon-key"

    # For backend serverless functions (API routes)
    SUPABASE_SERVICE_KEY="your-secret-service-role-key"

    # Optional: for dev mode feature
    # Set to 'true' to enable dev mode (e.g., skip login)
    VITE_DEV_MODE=false
    SERVER_DEV_MODE=false
    """

def get_api_db_js_content():
    return """
    // api/_db.js - Shared DB client for serverless functions
    import { createClient } from '@supabase/supabase-js';

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
        console.error("CRITICAL ERROR: Supabase server-side environment variables (SUPABASE_URL and SUPABASE_SERVICE_KEY) are not set.");
        throw new Error("Supabase server-side credentials are not configured.");
    }

    export const supabaseAdmin = createClient(supabaseUrl, serviceKey);

    export async function getUserFromRequest(req) {
        if (!req.headers.authorization) {
            return { user: null, profile: null, error: { message: 'No authorization header provided.' } };
        }

        const token = req.headers.authorization.split(' ')[1];
        if (!token) {
            return { user: null, profile: null, error: { message: 'Malformed authorization header. No token found.' } };
        }

        const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
        if (userError) {
            return { user: null, profile: null, error: userError };
        }
        if (!user) {
            return { user: null, profile: null, error: { message: 'User not found for the provided token.' } };
        }

        try {
            const { data: profile, error: profileError } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (profileError && profileError.code !== 'PGRST116') { // PGRST116 = row not found
                throw profileError;
            }
            return { user, profile, error: null };
        } catch (dbError) {
            console.error(`Error fetching profile for user ${user.id}:`, dbError);
            return { user, profile: null, error: dbError };
        }
    }
    """

def get_api_menu_js_content():
    return """
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
    """

def get_default_favicon_svg_content():
    return """
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="32" height="32">
      <path fill="#8B4513" d="M 12 15 C 12 10, 16 6, 22 6 L 42 6 C 48 6, 52 10, 52 15 L 50 48 C 50 52, 47 55, 43 55 L 21 55 C 17 55, 14 52, 14 48 Z" />
      <path fill="none" stroke="#8B4513" stroke-width="7" stroke-linecap="round" d="M 50 20 C 60 23, 60 37, 50 40" />
    </svg>
    """



# (This code continues from the previous segments)

def generate_boilerplate(details):
    """Generates the modern Vite project structure and files."""

    project_name = details["project_name_slug"]
    print(f"\n🚀 Generating modern Vite project: {project_name}")

    root_dir = Path(project_name)
    if root_dir.exists() and any(root_dir.iterdir()):
        print(f"\n⚠️  Warning: Directory '{project_name}' is not empty.")
        overwrite = input("Do you want to overwrite/add files to it? (yes/no): ").lower()
        if overwrite != 'yes':
            print("Aborting.")
            return
    root_dir.mkdir(exist_ok=True)
    print("\nCreating project structure...")

    # --- Root files ---
    create_file_with_content(root_dir / "package.json", get_package_json_content(project_name))
    create_file_with_content(root_dir / "vite.config.js", get_vite_config_content(details))
    create_file_with_content(root_dir / "vercel.json", get_vercel_json_content())
    create_file_with_content(root_dir / "postcss.config.cjs", get_postcss_config_content())
    create_file_with_content(root_dir / ".stylelintrc.json", get_stylelintrc_content())
    create_file_with_content(root_dir / ".gitignore", get_gitignore_content())
    create_file_with_content(root_dir / "README.md", get_readme_content(details))
    create_file_with_content(root_dir / ".env.example", get_env_example_content())
    create_file_with_content(root_dir / ".env.local", "# Fill this with your actual credentials from .env.example")
    create_file_with_content(root_dir / "index.html", get_index_html_content(details))

    # --- /public/ ---
    # This folder is for static assets that are copied directly to the 'dist' folder on build.
    create_file_with_content(root_dir / "public/default-favicon.svg", get_default_favicon_svg_content())
    create_file_with_content(root_dir / "public/placeholder-pizza.jpg", "This is a placeholder image.")
    create_file_with_content(root_dir / "public/placeholder-burger.jpg", "This is a placeholder image.")
    create_file_with_content(root_dir / "public/placeholder-salad.jpg", "This is a placeholder image.")
    # Create empty placeholder files for PWA assets to be replaced by the user
    create_file_with_content(root_dir / "public/pwa-192x192.png")
    create_file_with_content(root_dir / "public/pwa-512x512.png")
    create_file_with_content(root_dir / "public/apple-touch-icon.png")
    create_file_with_content(root_dir / "public/favicon.ico")

    # --- /src/ ---
    create_file_with_content(root_dir / "src/main.js", get_src_main_js_content())
    create_file_with_content(root_dir / "src/supabaseClient.js", get_src_supabase_client_js_content())
    create_file_with_content(root_dir / "src/assets/css/style.css", get_src_style_css_content(details))
    create_file_with_content(root_dir / "src/store/appStore.js", get_src_app_store_js_content())
    # Create empty placeholder directories for future modules
    (root_dir / "src/components").mkdir(parents=True, exist_ok=True)
    (root_dir / "src/features").mkdir(parents=True, exist_ok=True)
    (root_dir / "src/services").mkdir(parents=True, exist_ok=True)
    (root_dir / "src/utils").mkdir(parents=True, exist_ok=True)

    # --- /api/ ---
    create_file_with_content(root_dir / "api/_db.js", get_api_db_js_content())
    create_file_with_content(root_dir / "api/menu.js", get_api_menu_js_content())
    # Create empty folders for other API routes
    (root_dir / "api/orders").mkdir(parents=True, exist_ok=True)
    (root_dir / "api/user").mkdir(parents=True, exist_ok=True)
    (root_dir / "api/settings").mkdir(parents=True, exist_ok=True)


    # --- Final Instructions ---
    print(f"\n✅ Project '{project_name}' generated successfully!")
    print("\nNext steps:")
    print(f"1.  Navigate to the project directory: cd {project_name}")
    print("2.  Edit the `.env.local` file with your actual Supabase credentials.")
    print("3.  Create your PWA icons (pwa-192x192.png, etc.) and place them in the /public folder.")
    print("4.  Install all dependencies:")
    print("    npm install")
    print("5.  Start the local development server:")
    print("    vercel dev")
    print("\nHappy building! 🍽️")


if __name__ == "__main__":
    try:
        project_details = get_project_details()
        generate_boilerplate(project_details)
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user. Exiting.")
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")