# Mealmates

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