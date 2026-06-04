'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { 
  LayoutDashboard, 
  Smartphone, 
  Users, 
  Megaphone, 
  Bot, 
  MessageSquare,
  MessageSquareReply, 
  BarChart3, 
  Server, 
  Activity, 
  Settings 
} from 'lucide-react';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/accounts', label: 'WhatsApp Accounts', icon: Smartphone },
  { href: '/contacts', label: 'Contacts / CRM', icon: Users },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { href: '/ai-hub', label: 'AI Hub', icon: Bot },
  { href: '/shared-inbox', label: 'Shared Inbox', icon: MessageSquare },
  { href: '/auto-reply', label: 'Auto-Reply Rules', icon: MessageSquareReply },
  { href: '/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/proxy-manager', label: 'Proxy Manager', icon: Server },
  { href: '/network-status', label: 'Network Status', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="w-[260px] bg-[#1A1A2E] border-r border-white/10 flex flex-col h-screen sticky top-0">
      <div className="flex h-[88px] flex-col justify-center bg-gradient-to-br from-[#7C3AED] to-[#06B6D4] px-6">
        <h1 className="text-[1.75rem] font-bold leading-none text-white tracking-tight">WhatsApp Turbo</h1>
        <p className="mt-2 text-sm text-white/80">CRM + AI Web Application</p>
      </div>
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                isActive 
                  ? "bg-[#7C3AED]/20 text-[#06B6D4]" 
                  : "text-[#94A3B8] hover:bg-[#16213E] hover:text-[#F1F5F9]"
              )}
            >
              <Icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
