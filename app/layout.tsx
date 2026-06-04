import type {Metadata} from 'next';
import './globals.css';
import Providers from './providers';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { DebugPanel } from '@/components/DebugPanel';

export const metadata: Metadata = {
  title: 'WhatsApp Turbo CRM',
  description: 'WhatsApp Bulk CRM + AI Web Application',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0F0F1A] text-[#F1F5F9] min-h-screen flex" suppressHydrationWarning>
        <Providers>
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <Header />
            <main className="flex-1 overflow-auto p-6">
              {children}
            </main>
          </div>
          <DebugPanel />
        </Providers>
      </body>
    </html>
  );
}
