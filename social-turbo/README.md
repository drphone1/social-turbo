# WhatsApp Turbo CRM

A powerful WhatsApp Bulk CRM and AI automation tool built with Next.js, Express, SQLite, and Baileys.

## Features

- **WhatsApp Account Management**: Connect multiple WhatsApp accounts via QR code.
- **Contact Management**: Store and manage your contacts (CRM).
- **Campaigns**: Send bulk messages to your contacts.
- **AI Integration**: Auto-reply rules using AI models (OpenAI, Gemini, etc.).
- **Queue System**: Background job processing for message sending.
- **WebSocket**: Real-time updates for QR codes and connection status.

## Prerequisites

Before you begin, ensure you have met the following requirements:
- Node.js (v18 or higher recommended)
- npm or yarn

## Installation (0 to 100)

Follow these steps to set up the project on your local machine:

### 1. Clone the repository
(If you haven't already)
```bash
git clone <repository-url>
cd whatsapp-turbo
```

### 2. Install Dependencies
Install all required packages using npm:
```bash
npm install
```

### 3. Setup Environment Variables
Create a `.env` file in the root directory based on the provided `.env.example` (if available) or add the following required variables:
```env
# Server Port
PORT=3000

# Database
DATABASE_URL=database/whatsapp-turbo.db

# Optional: AI Provider Keys
# OPENAI_API_KEY=your_openai_key
```

### 4. Initialize the Database
The application uses SQLite and Drizzle ORM. The database will be automatically created and initialized when you start the server for the first time.

### 5. Start the Development Server
Run the following command to start both the Next.js frontend and the Express backend concurrently:
```bash
npm run dev
```

The application will be available at `http://localhost:3000`.

## Usage

1. **Dashboard**: View analytics and recent activity.
2. **WhatsApp Accounts**: Click on "WhatsApp Accounts" in the sidebar. Click "Add Account", enter a name, and scan the generated QR code with your WhatsApp mobile app (Linked Devices).
3. **Contacts**: Add and manage your contacts.
4. **Campaigns**: Create and schedule bulk messaging campaigns.

## Project Structure

- `/app`: Next.js frontend application (App Router).
- `/backend`: Express server, database schema, WebSocket handler, and WhatsApp connection logic.
- `/components`: Reusable React components (UI, Layout).
- `/database`: SQLite database file and Drizzle ORM configuration.

## Technologies Used

- **Frontend**: Next.js 15, React 19, Tailwind CSS, Recharts, Lucide Icons, TanStack Query.
- **Backend**: Express.js, WebSocket (ws).
- **Database**: SQLite (better-sqlite3), Drizzle ORM.
- **WhatsApp API**: @whiskeysockets/baileys.
