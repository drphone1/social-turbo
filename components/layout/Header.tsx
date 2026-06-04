'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Search, User, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ConnectionHealthWidget } from './ConnectionHealthWidget';

export function Header() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Fetch contacts for search suggestions
  const { data: contacts } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const res = await fetch('/api/contacts');
      if (!res.ok) throw new Error('Failed to fetch contacts');
      return res.json();
    },
    enabled: searchInput.length > 0
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      router.push(`/contacts?search=${encodeURIComponent(searchInput)}`);
      setSearchInput('');
      setShowSuggestions(false);
    }
  };

  const filteredSuggestions = contacts
    ?.filter((c: any) => 
      (c.fullName?.toLowerCase().includes(searchInput.toLowerCase()) ||
       c.phone?.includes(searchInput)) &&
      searchInput.length > 0
    )
    .slice(0, 5) || [];

  return (
    <header className="sticky top-0 z-20 h-[88px] border-b border-white/10 bg-[#1A1A2E]/80 backdrop-blur-md">
      <div className="flex h-full items-center gap-3 px-5 xl:gap-4 xl:px-6">
        <form onSubmit={handleSearch} className="relative min-w-0 w-full max-w-[380px] shrink-0 xl:max-w-[430px]">
          <div className="flex h-12 items-center rounded-full border border-white/5 bg-[#0F0F1A] px-4 transition-colors focus-within:border-[#7C3AED]/50">
            <Search className="mr-3 h-4.5 w-4.5 text-[#94A3B8]" />
            <input 
              type="text" 
              placeholder="Search contacts, campaigns..." 
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setShowSuggestions(true);
              }}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              className="w-full border-none bg-transparent text-sm text-[#F1F5F9] outline-none placeholder:text-[#94A3B8]"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => {
                  setSearchInput('');
                  setShowSuggestions(false);
                }}
                className="rounded p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4 text-[#94A3B8]" />
              </button>
            )}
          </div>

          {showSuggestions && filteredSuggestions.length > 0 && (
            <div className="absolute top-full mt-2 w-full overflow-hidden rounded-lg border border-white/10 bg-[#0F0F1A] shadow-lg">
              {filteredSuggestions.map((contact: any) => (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => {
                    router.push(`/contacts?search=${encodeURIComponent(contact.fullName || contact.phone)}`);
                    setSearchInput('');
                    setShowSuggestions(false);
                  }}
                  className="w-full border-b border-white/5 px-4 py-2 text-left transition-colors hover:bg-white/5 last:border-0"
                >
                  <div className="text-sm font-medium text-[#F1F5F9]">{contact.fullName || contact.phone}</div>
                  <div className="text-xs text-[#94A3B8]">{contact.phone}</div>
                </button>
              ))}
            </div>
          )}
        </form>

        <div className="flex min-w-0 flex-1 items-center gap-3 xl:gap-4">
          <div className="min-w-0 flex-1">
            <ConnectionHealthWidget />
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-4 pl-1 xl:pl-2">
            <button className="relative p-2.5 text-[#94A3B8] transition-colors hover:text-[#F1F5F9]">
              <Bell className="h-5.5 w-5.5" />
              <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[#EF4444]"></span>
            </button>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-tr from-[#7C3AED] to-[#06B6D4] text-sm font-bold shadow-lg">
              <User className="h-4.5 w-4.5 text-white" />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
