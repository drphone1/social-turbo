'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Smartphone, Plus, Trash2, RefreshCw, QrCode, Edit, Users, Download, ArrowLeft, FileSpreadsheet, CheckSquare, ChevronUp, ChevronDown, ChevronsUpDown, Terminal, X, Zap } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'sonner';

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [newAccountName, setNewAccountName] = useState('');
  const [newAccountPhone, setNewAccountPhone] = useState('');
  const [connectingAccountId, setConnectingAccountId] = useState<string | null>(null);
  const connectingAccountIdRef = useRef<string | null>(null);
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [editingAccount, setEditingAccount] = useState<any>(null);
  const [viewingGroupsAccount, setViewingGroupsAccount] = useState<any>(null);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'groups' | 'contacts'>('groups');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showNormalGroups, setShowNormalGroups] = useState(true);
  const [showRestrictedGroups, setShowRestrictedGroups] = useState(true);
  const [showNamedContactsOnly, setShowNamedContactsOnly] = useState(false);
  const [showProfilePictures, setShowProfilePictures] = useState(false);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [contactsSortBy, setContactsSortBy] = useState<'recent' | 'name'>('recent');
  const [isClient, setIsClient] = useState(false);
  const [groupsRetryCountdown, setGroupsRetryCountdown] = useState<number>(0);
  const [groupsRetryCount, setGroupsRetryCount] = useState<number>(0);
  const groupsRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isCampaignDialogOpen, setIsCampaignDialogOpen] = useState(false);
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{ open: boolean; accountId: string | null; accountName: string }>({ open: false, accountId: null, accountName: '' });
  const [campaignFormData, setCampaignFormData] = useState({
    name: '',
    messageTemplate: '',
    scheduleType: 'immediate' as 'immediate' | 'scheduled',
    scheduledDate: '',
    scheduledTime: '',
    maxPerHour: 100,
    maxPerDay: 1000,
    delayMinMs: 100,
    delayMaxMs: 500
  });
  const [selectedGroupsForCampaign, setSelectedGroupsForCampaign] = useState<string[]>([]);

  // Load UI preferences from localStorage
  useEffect(() => {
    setIsClient(true);
    try {
      const savedShowNormalGroups = localStorage.getItem('whatsapp_turbo_showNormalGroups');
      const savedShowRestrictedGroups = localStorage.getItem('whatsapp_turbo_showRestrictedGroups');
      const savedShowNamedContactsOnly = localStorage.getItem('whatsapp_turbo_showNamedContactsOnly');
      const savedShowProfilePictures = localStorage.getItem('whatsapp_turbo_showProfilePictures');
      const savedActiveTab = localStorage.getItem('whatsapp_turbo_activeTab');
      
      if (savedShowNormalGroups !== null) setShowNormalGroups(savedShowNormalGroups === 'true');
      if (savedShowRestrictedGroups !== null) setShowRestrictedGroups(savedShowRestrictedGroups === 'true');
      if (savedShowNamedContactsOnly !== null) setShowNamedContactsOnly(savedShowNamedContactsOnly === 'true');
      if (savedShowProfilePictures !== null) setShowProfilePictures(savedShowProfilePictures === 'true');
      if (savedActiveTab !== null && (savedActiveTab === 'groups' || savedActiveTab === 'contacts')) {
        setActiveTab(savedActiveTab as 'groups' | 'contacts');
      }
    } catch (error) {
      console.warn('Failed to load UI preferences from localStorage:', error);
    }
  }, []);

  // Save UI preferences to localStorage
  useEffect(() => {
    if (isClient) {
      try {
        localStorage.setItem('whatsapp_turbo_showNormalGroups', showNormalGroups.toString());
        localStorage.setItem('whatsapp_turbo_showRestrictedGroups', showRestrictedGroups.toString());
        localStorage.setItem('whatsapp_turbo_showNamedContactsOnly', showNamedContactsOnly.toString());
        localStorage.setItem('whatsapp_turbo_showProfilePictures', showProfilePictures.toString());
        localStorage.setItem('whatsapp_turbo_activeTab', activeTab);
      } catch (error) {
        console.warn('Failed to save UI preferences to localStorage:', error);
      }
    }
  }, [showNormalGroups, showRestrictedGroups, showNamedContactsOnly, showProfilePictures, activeTab, isClient]);

  // Load selected groups/contacts from localStorage when viewing account changes
  useEffect(() => {
    if (viewingGroupsAccount && isClient) {
      try {
        const key = `whatsapp_turbo_selected_${viewingGroupsAccount.id}_${activeTab}`;
        const savedSelection = localStorage.getItem(key);
        if (savedSelection) {
          if (activeTab === 'groups') {
            setSelectedGroups(JSON.parse(savedSelection));
          } else {
            setSelectedContacts(JSON.parse(savedSelection));
          }
        }
      } catch (error) {
        console.warn('Failed to load selection from localStorage:', error);
      }
    }
  }, [viewingGroupsAccount, activeTab, isClient]);

  // Save selected groups/contacts to localStorage
  useEffect(() => {
    if (viewingGroupsAccount && isClient) {
      try {
        const key = `whatsapp_turbo_selected_${viewingGroupsAccount.id}_${activeTab}`;
        if (activeTab === 'groups') {
          localStorage.setItem(key, JSON.stringify(selectedGroups));
        } else {
          localStorage.setItem(key, JSON.stringify(selectedContacts));
        }
      } catch (error) {
        console.warn('Failed to save selection to localStorage:', error);
      }
    }
  }, [selectedGroups, selectedContacts, viewingGroupsAccount, activeTab, isClient]);

  useEffect(() => {
    connectingAccountIdRef.current = connectingAccountId;
  }, [connectingAccountId]);

  // Load cached groups from localStorage when account changes or on mount
  useEffect(() => {
    if (viewingGroupsAccount && isClient && activeTab === 'groups') {
      try {
        const cachedGroups = localStorage.getItem(`whatsapp_turbo_groups_${viewingGroupsAccount.id}`);
        if (cachedGroups) {
          // Cached groups exist, will display while fetching fresh ones
          // Fresh fetch happens automatically via useQuery
        }
        // Reset retry counter when switching accounts
        setGroupsRetryCount(0);
        setGroupsRetryCountdown(0);
      } catch (error) {
        console.warn('Failed to load cached groups:', error);
      }
    }
  }, [viewingGroupsAccount, activeTab, isClient]);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json();
    }
  });

  useEffect(() => {
    // Connect to WebSocket (only for QR code and account status)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('WebSocket connected for accounts');
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'qr_code') {
          if (message.data.accountId === connectingAccountIdRef.current) {
            setQrCodeData(message.data.qr);
          }
        } else if (message.event === 'account_status') {
          queryClient.invalidateQueries({ queryKey: ['accounts'] });
          if (message.data.accountId === connectingAccountIdRef.current && message.data.status === 'connected') {
            toast.success('Account connected successfully!');
            setIsAddDialogOpen(false);
            setConnectingAccountId(null);
            setQrCodeData(null);
          }
        }
        // Log events are now handled by DebugPanel component in layout.tsx
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    socket.onclose = () => {
      console.log('WebSocket disconnected');
    };

    setWs(socket);

    return () => {
      socket.close();
    };
  }, [queryClient]);

  const addAccountMutation = useMutation({
    mutationFn: async (data: { displayName: string, phone: string }) => {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to add account');
      return res.json();
    },
    onSuccess: async (data) => {
      setConnectingAccountId(data.id);
      setQrCodeData(null);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      
      // Try to fetch initial QR if already generated
      try {
        const res = await fetch(`/api/accounts/${data.id}/qr`);
        if (res.ok) {
          const { qr } = await res.json();
          if (qr) setQrCodeData(qr);
        }
      } catch (e) {
        console.error('Failed to fetch initial QR', e);
      }
    },
    onError: (error) => {
      toast.error(`Error adding account: ${error.message}`);
    }
  });

  const deleteAccountMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete account');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Account deleted successfully');
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error) => {
      toast.error(`Error deleting account: ${error.message}`);
    }
  });

  const editAccountMutation = useMutation({
    mutationFn: async (data: { id: string, displayName: string, phone: string, proxyProfileId?: string | null }) => {
      const res = await fetch(`/api/accounts/${data.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: data.displayName, phone: data.phone, proxyProfileId: data.proxyProfileId ?? null }),
      });
      if (!res.ok) throw new Error('Failed to update account');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Account updated successfully');
      setEditingAccount(null);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (error) => {
      toast.error(`Error updating account: ${error.message}`);
    }
  });

  const { data: groups, isLoading: isLoadingGroups, isError: isGroupsError, error: groupsError, refetch: refetchGroups } = useQuery({
    queryKey: ['groups', viewingGroupsAccount?.id],
    queryFn: async () => {
      if (!viewingGroupsAccount) return [];
      const res = await fetch(`/api/accounts/${viewingGroupsAccount.id}/groups`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch groups');
      }
      return res.json();
    },
    enabled: !!viewingGroupsAccount,
    retry: false,
    staleTime: 0,
    gcTime: 1000 * 60 * 5,
  });

  // Restore cached groups when account changes
  useEffect(() => {
    if (viewingGroupsAccount && isClient && !isLoadingGroups && Object.keys(groups || {}).length === 0) {
      try {
        const cached = localStorage.getItem(`whatsapp_turbo_groups_${viewingGroupsAccount.id}`);
        if (cached) {
          queryClient.setQueryData(['groups', viewingGroupsAccount.id], JSON.parse(cached));
        }
      } catch (e) {
        console.warn('Failed to restore cached groups', e);
      }
    }
  }, [groups, isClient, isLoadingGroups, queryClient, viewingGroupsAccount]);

  // Save groups to localStorage when they load successfully
  useEffect(() => {
    if (groups && viewingGroupsAccount && isClient && !isLoadingGroups) {
      try {
        localStorage.setItem(`whatsapp_turbo_groups_${viewingGroupsAccount.id}`, JSON.stringify(groups));
        setGroupsRetryCount(0); // Reset retry counter on success
      } catch (e) {
        console.warn('Failed to save groups to localStorage', e);
      }
    }
  }, [groups, viewingGroupsAccount, isClient, isLoadingGroups]);

  const { data: contacts, isLoading: isLoadingContacts, isError: isContactsError, error: contactsError } = useQuery({
    queryKey: ['contacts', viewingGroupsAccount?.id, contactsSortBy],
    queryFn: async () => {
      if (!viewingGroupsAccount) return [];
      const res = await fetch(`/api/accounts/${viewingGroupsAccount.id}/contacts?sort=${contactsSortBy}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to fetch contacts');
      }
      return res.json();
    },
    enabled: !!viewingGroupsAccount && activeTab === 'contacts',
    retry: false,
  });

  // Fetch account statistics for all accounts
  const { data: accountStats } = useQuery({
    queryKey: ['accountStats'],
    queryFn: async () => {
      const res = await fetch('/api/accounts/stats/all');
      if (!res.ok) throw new Error('Failed to fetch account stats');
      return res.json();
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 10,   // 10 minutes
  });

  const { data: proxyProfiles = [] } = useQuery({
    queryKey: ['proxyProfilesForAccounts'],
    queryFn: async () => {
      const res = await fetch('/api/proxy/profiles');
      if (!res.ok) throw new Error('Failed to fetch proxy profiles');
      return res.json();
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
  });

  // Create a map of accountId -> stats for quick lookup
  const statsMap = useMemo(() => {
    const map = new Map();
    if (accountStats?.accounts) {
      accountStats.accounts.forEach((stat: any) => {
        map.set(stat.accountId, stat);
      });
    }
    return map;
  }, [accountStats]);

  const proxyProfilesMap = useMemo(() => {
    const map = new Map();
    proxyProfiles.forEach((profile: any) => {
      map.set(profile.id, profile);
    });
    return map;
  }, [proxyProfiles]);

  // Fetch all campaigns
  const { data: allCampaigns = [] } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error('Failed to fetch campaigns');
      return res.json();
    },
  });

  const extractContactsMutation = useMutation({
    mutationFn: async (data: { accountId: string, phones: string[] }) => {
      const res = await fetch(`/api/accounts/${data.accountId}/contacts/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phones: data.phones }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to extract contacts');
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast.success(`Processed ${data.total} contacts. Added ${data.added} new contacts to CRM.`);
      setSelectedContacts([]);
    },
    onError: (error) => {
      toast.error(`Extraction failed: ${error.message}`);
    }
  });

  const extractMembersMutation = useMutation({
    mutationFn: async (data: { accountId: string, groupId: string }) => {
      const res = await fetch(`/api/accounts/${data.accountId}/groups/${data.groupId}/extract`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to extract members');
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast.success(`Extracted ${data.total} members. Added ${data.added} new contacts to CRM.`);
    },
    onError: (error) => {
      toast.error(`Extraction failed: ${error.message}`);
    }
  });

  const handleRefreshGroups = async () => {
    if (groupsRetryCountdown > 0) {
      // Cancel countdown if user clicks during retry countdown
      if (groupsRetryTimeoutRef.current) {
        clearTimeout(groupsRetryTimeoutRef.current);
        groupsRetryTimeoutRef.current = null;
      }
      setGroupsRetryCountdown(0);
    }

    // First restore cache to show data immediately
    if (viewingGroupsAccount && isClient) {
      try {
        const cached = localStorage.getItem(`whatsapp_turbo_groups_${viewingGroupsAccount.id}`);
        if (cached) {
          queryClient.setQueryData(['groups', viewingGroupsAccount.id], JSON.parse(cached));
        }
      } catch (e) {
        console.warn('Failed to restore cache', e);
      }
    }

    // Then reset retry counter and manually refetch fresh data
    setGroupsRetryCount(0);
    setGroupsRetryCountdown(0);
    await refetchGroups();
  };

  // Auto-retry groups fetch with countdown (up to 3 times)
  useEffect(() => {
    if (isGroupsError && groupsRetryCountdown === 0 && groupsRetryCount < 3) {
      // Start countdown on error (if not yet at 3 retries)
      setGroupsRetryCountdown(3);
    }
  }, [isGroupsError, groupsRetryCountdown, groupsRetryCount]);

  // Countdown timer
  useEffect(() => {
    if (groupsRetryCountdown > 0 && groupsRetryCount < 3) {
      groupsRetryTimeoutRef.current = setTimeout(() => {
        if (groupsRetryCountdown === 1) {
          // Auto-refetch when timer reaches 0
          setGroupsRetryCount(prev => prev + 1); // Increment retry counter
          queryClient.invalidateQueries({ queryKey: ['groups', viewingGroupsAccount?.id] });
          setGroupsRetryCountdown(0);
        } else {
          setGroupsRetryCountdown(prev => prev - 1);
        }
      }, 1000);

      return () => {
        if (groupsRetryTimeoutRef.current) {
          clearTimeout(groupsRetryTimeoutRef.current);
        }
      };
    }
  }, [groupsRetryCountdown, viewingGroupsAccount?.id, queryClient, groupsRetryCount]);

  const sortedGroups = useMemo(() => {
    if (!groups) return [];
    
    let filtered = groups.filter((g: any) => {
      const isChannel = g.id.includes('@newsletter');
      const isCommunity = g.id.includes('@g.us') && g.isCommunity;
      const isRestricted = g.hiddenCount > 0 && g.realCount <= 10;
      const isNormal = !isRestricted && !isChannel && !isCommunity;
      
      if (isRestricted && !showRestrictedGroups) return false;
      if (isNormal && !showNormalGroups) return false;
      
      return true;
    });

    let sorted = [...filtered];
    if (sortOrder === 'asc') {
      sorted.sort((a, b) => a.participantsCount - b.participantsCount);
    } else if (sortOrder === 'desc') {
      sorted.sort((a, b) => b.participantsCount - a.participantsCount);
    }
    return sorted;
  }, [groups, sortOrder, showNormalGroups, showRestrictedGroups]);

  const sortedContacts = useMemo(() => {
    if (!contacts) return [];
    
    let filtered = contacts.filter((c: any) => {
      if (showNamedContactsOnly && !c.name) return false;
      return true;
    });

    return filtered;
  }, [contacts, showNamedContactsOnly]);

  const handleBulkExtract = async () => {
    if (!viewingGroupsAccount) return;
    
    // Use selected groups, or all sorted groups if none selected
    const groupsToProcess = selectedGroups.length > 0 ? selectedGroups : sortedGroups.map((g: any) => g.id);
    
    if (groupsToProcess.length === 0) {
      toast.error('No groups available to extract');
      return;
    }
    
    let successCount = 0;
    for (const groupId of groupsToProcess) {
      try {
        await extractMembersMutation.mutateAsync({ accountId: viewingGroupsAccount.id, groupId });
        successCount++;
      } catch (e) {
        console.error(e);
      }
    }
    if (successCount > 0) {
      toast.success(`Successfully processed ${successCount} groups.`);
      setSelectedGroups([]);
    }
  };

  const handleExportCSV = async () => {
    if (!viewingGroupsAccount) return;
    
    // Use selected groups, or all sorted groups if none selected
    const groupsToExport = selectedGroups.length > 0 ? selectedGroups : sortedGroups.map((g: any) => g.id);
    
    if (groupsToExport.length === 0) {
      toast.error('No groups available to export');
      return;
    }
    
    setIsExporting(true);
    try {
      let allMembers: any[] = [];
      let groupNames: string[] = [];

      for (const groupId of groupsToExport) {
        const res = await fetch(`/api/accounts/${viewingGroupsAccount.id}/groups/${groupId}/members`);
        if (res.ok) {
          const data = await res.json();
          groupNames.push(data.subject);
          data.participants.forEach((p: any) => {
            allMembers.push({
              groupName: data.subject,
              phone: p.phone,
              role: p.admin || 'member',
              type: p.type,
              description: p.description,
              subscriberCount: p.subscriberCount
            });
          });
        }
      }

      if (allMembers.length === 0) {
        toast.error('No members found to export.');
        setIsExporting(false);
        return;
      }

      const headers = ['Group/Channel Name', 'Phone Number', 'Role', 'Type', 'Description', 'Subscriber Count'];
      const csvContent = [
        headers.join(','),
        ...allMembers.map(m => {
          const safeGroupName = (m.groupName || '').replace(/"/g, '""');
          const safeDesc = (m.description || '').replace(/"/g, '""').replace(/\n/g, ' ');
          return `"${safeGroupName}","${m.phone}","${m.role}","${m.type || 'Group'}","${safeDesc}","${m.subscriberCount || ''}"`;
        })
      ].join('\n');
      
      const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      
      const fileName = groupNames.length === 1 
        ? `Members_${groupNames[0].replace(/[\/\\?%*:|"<>]/g, '-')}.csv` 
        : `Members_Multiple_Groups_${new Date().getTime()}.csv`;
        
      link.setAttribute('download', fileName);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('Exported successfully!');
    } catch (error) {
      console.error(error);
      toast.error('Failed to export CSV');
    }
    setIsExporting(false);
  };

  const handleExportContactsCSV = () => {
    if (selectedContacts.length === 0 || !contacts) return;
    
    const contactsToExport = contacts.filter((c: any) => selectedContacts.includes(c.phone));
    
    if (contactsToExport.length === 0) {
      toast.error('No contacts selected to export.');
      return;
    }

    const headers = ['Name', 'Phone Number', 'Source', 'Account Type'];
    const csvContent = [
      headers.join(','),
      ...contactsToExport.map((c: any) => {
        const safeName = (c.name || '').replace(/"/g, '""');
        const safeSource = (c.source || '').replace(/"/g, '""');
        return `"${safeName}","${c.phone}","${safeSource}","WhatsApp"`;
      })
    ].join('\n');
    
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `Contacts_${new Date().getTime()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Exported contacts successfully!');
  };

  const handleAddAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountName) {
      toast.error('Please enter an account name');
      return;
    }
    addAccountMutation.mutate({ displayName: newAccountName, phone: newAccountPhone });
  };

  const handleDialogChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) {
      setConnectingAccountId(null);
      setQrCodeData(null);
      setNewAccountName('');
      setNewAccountPhone('');
    }
  };

  if (viewingGroupsAccount) {
    return (
      <div className="space-y-6 animate-in fade-in duration-300">
        <div className="flex items-center space-x-4">
          <Button variant="ghost" onClick={() => { setViewingGroupsAccount(null); setSelectedGroups([]); }} className="text-[#94A3B8] hover:text-white">
            <ArrowLeft className="w-5 h-5 mr-2" />
            Back to Accounts
          </Button>
          <h2 className="text-2xl font-bold text-[#F1F5F9]">{viewingGroupsAccount.displayName}</h2>
          <div className={`px-2 py-1 rounded-full text-xs font-medium bg-[#10B981]/20 text-[#10B981]`}>
            Connected
          </div>
        </div>

        <div className="flex space-x-4 border-b border-white/10 pb-px">
          <button 
            className={`px-4 py-2 font-medium text-sm transition-colors relative ${activeTab === 'groups' ? 'text-[#10B981]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
            onClick={() => setActiveTab('groups')}
          >
            Groups
            {activeTab === 'groups' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#10B981] rounded-t-full" />}
          </button>
          <button 
            className={`px-4 py-2 font-medium text-sm transition-colors relative ${activeTab === 'contacts' ? 'text-[#3B82F6]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
            onClick={() => setActiveTab('contacts')}
          >
            Contacts / Numbers
            {activeTab === 'contacts' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#3B82F6] rounded-t-full" />}
          </button>
        </div>

        {activeTab === 'groups' && (
          <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
            <CardHeader className="flex flex-col space-y-4 bg-[#1A1A2E]/95 backdrop-blur-sm border-b border-white/5 pb-4 sticky top-0 z-20 rounded-t-xl">
              <div className="flex flex-row items-center justify-between">
                <div className="flex items-center space-x-2">
                  <CardTitle className="text-lg font-medium text-[#F1F5F9]">WhatsApp Groups</CardTitle>
                  <Button 
                    size="sm" 
                    className="bg-[#10B981] hover:bg-[#059669] text-white border-none h-8"
                    onClick={handleRefreshGroups}
                    disabled={isLoadingGroups}
                  >
                    <RefreshCw className={`w-4 h-4 mr-1 ${isLoadingGroups || groupsRetryCountdown > 0 ? 'animate-spin' : ''}`} />
                    {groupsRetryCountdown > 0 ? `Retry in ${groupsRetryCountdown}s` : 'Refresh Groups'}
                  </Button>
                </div>
                <div className="flex space-x-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="border-white/10 hover:bg-white/10 text-[#F1F5F9]"
                    onClick={handleExportCSV}
                    disabled={isExporting || sortedGroups.length === 0}
                  >
                    {isExporting ? (
                      <RefreshCw className="w-4 h-4 mr-2 text-[#10B981] animate-spin" />
                    ) : (
                      <FileSpreadsheet className="w-4 h-4 mr-2 text-[#10B981]" />
                    )}
                    Export CSV ({selectedGroups.length > 0 ? selectedGroups.length : sortedGroups.length})
                  </Button>
                  <Button 
                    className="bg-[#10B981] hover:bg-[#059669] text-white border-none"
                    size="sm"
                    onClick={handleBulkExtract}
                    disabled={extractMembersMutation.isPending || sortedGroups.length === 0}
                  >
                    {extractMembersMutation.isPending ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 mr-2" />
                    )}
                    Extract to CRM ({selectedGroups.length > 0 ? selectedGroups.length : sortedGroups.length})
                  </Button>
                  <Button 
                    className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white border-none"
                    size="sm"
                    onClick={() => {
                      const groupsToUse = selectedGroups.length > 0 ? selectedGroups : sortedGroups.map((g: any) => g.id);
                      setSelectedGroupsForCampaign(groupsToUse);
                      setCampaignFormData({
                        name: '',
                        messageTemplate: '',
                        scheduleType: 'immediate',
                        scheduledDate: '',
                        scheduledTime: '',
                        maxPerHour: 100,
                        maxPerDay: 1000,
                        delayMinMs: 100,
                        delayMaxMs: 500
                      });
                      setIsCampaignDialogOpen(true);
                    }}
                    disabled={sortedGroups.length === 0}
                  >
                    <Zap className="w-4 h-4 mr-2" />
                    Create Campaign
                  </Button>
                </div>
              </div>
               <div className="flex items-center space-x-6 text-sm text-[#94A3B8]">
                 <label className="flex items-center space-x-2 cursor-pointer">
                   <input 
                     type="checkbox" 
                     className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#10B981]"
                     checked={showNormalGroups}
                     onChange={(e) => setShowNormalGroups(e.target.checked)}
                   />
                   <span>Show Normal Groups</span>
                 </label>
                 <label className="flex items-center space-x-2 cursor-pointer">
                   <input 
                     type="checkbox" 
                     className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#10B981]"
                     checked={showRestrictedGroups}
                     onChange={(e) => setShowRestrictedGroups(e.target.checked)}
                   />
                   <span>Show Restricted Groups (Hidden Members)</span>
                 </label>
                 <label className="flex items-center space-x-2 cursor-not-allowed opacity-50" title="فعال‌سازی این گزینه نیاز به درخواست دارد. برای تقاضای فعال‌سازی با پشتیبانی تماس بگیرید.">
                   <input 
                     type="checkbox" 
                     disabled
                     className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#10B981] cursor-not-allowed"
                     checked={false}
                   />
                   <span>Show Profile Pictures</span>
                 </label>
               </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoadingGroups ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <RefreshCw className="w-8 h-8 text-[#10B981] animate-spin mb-4" />
                  <p className="text-[#94A3B8]">Fetching groups from WhatsApp...</p>
                </div>
              ) : isGroupsError ? (
                <div className="py-12 px-6 text-center">
                  <div className="inline-block bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                    <p className="text-red-400 font-medium">{groupsError?.message}</p>
                    <p className="text-[#94A3B8] text-sm mt-2">
                      {groupsRetryCount >= 3 
                        ? 'Failed after 3 retry attempts. Try sending a message from your phone to keep the session active, or reconnect the account.' 
                        : 'Retrying automatically... or try sending a message from your phone to keep the session active.'}
                    </p>
                  </div>
                </div>
              ) : groups?.length === 0 ? (
                <p className="text-center text-[#94A3B8] py-16">No groups found for this account.</p>
              ) : (
                <div className="overflow-auto h-[calc(100vh-250px)]">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-[#1A1A2E]/95 backdrop-blur-sm">
                      <tr className="border-b border-white/10 text-[#94A3B8] text-sm bg-black/20">
                        <th className="p-4 w-12 text-center">
                          <input 
                            type="checkbox" 
                            className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#10B981] cursor-pointer"
                            checked={sortedGroups.length > 0 && selectedGroups.length === sortedGroups.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedGroups(sortedGroups.map((g: any) => g.id));
                              } else {
                                setSelectedGroups([]);
                              }
                            }}
                          />
                        </th>
                        <th className="p-4 font-medium">Group Name</th>
                        <th className="p-4 font-medium">Group ID</th>
                        <th 
                          className="p-4 font-medium cursor-pointer hover:text-white flex items-center select-none"
                          onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : prev === 'desc' ? null : 'asc')}
                        >
                          Members
                          {sortOrder === 'asc' && <ChevronUp className="w-4 h-4 ml-1" />}
                          {sortOrder === 'desc' && <ChevronDown className="w-4 h-4 ml-1" />}
                          {!sortOrder && <ChevronsUpDown className="w-4 h-4 ml-1 opacity-50" />}
                        </th>
                        <th className="p-4 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedGroups?.map((group: any) => {
                        const isChannel = group.id.includes('@newsletter');
                        const isCommunity = group.id.includes('@g.us') && group.isCommunity;
                        const isRestricted = group.hiddenCount > 0 && group.realCount <= 10;
                        
                        return (
                          <tr key={group.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="p-4 text-center">
                              <input 
                                type="checkbox" 
                                className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#10B981] cursor-pointer"
                                checked={selectedGroups.includes(group.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setSelectedGroups([...selectedGroups, group.id]);
                                  } else {
                                    setSelectedGroups(selectedGroups.filter(id => id !== group.id));
                                  }
                                }}
                              />
                            </td>
                            <td className="p-4">
                              <div className="flex items-center space-x-2">
                                <span className="font-medium text-[#F1F5F9]">{group.subject}</span>
                                {isRestricted && (
                                  <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 text-xs font-medium border border-red-500/20">
                                    Restricted
                                  </span>
                                )}
                                {isChannel && (
                                  <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 text-xs font-medium border border-purple-500/20">
                                    Channel
                                  </span>
                                )}
                                {isCommunity && (
                                  <span className="px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400 text-xs font-medium border border-orange-500/20">
                                    Community
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-4 text-xs text-[#94A3B8] font-mono">{group.id}</td>
                            <td className="p-4">
                              <div className="flex flex-col">
                                <span className="text-[#10B981] font-medium text-sm">
                                  {group.realCount} Real
                                </span>
                                {group.hiddenCount > 0 && (
                                  <span className="text-red-400 text-xs mt-0.5">
                                    {group.hiddenCount} Hidden
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="p-4 text-right">
                              <Button 
                                size="sm" 
                                variant="ghost" 
                                className="h-8 text-xs text-[#10B981] hover:text-[#10B981] hover:bg-[#10B981]/10"
                                onClick={() => extractMembersMutation.mutate({ accountId: viewingGroupsAccount.id, groupId: group.id })}
                                disabled={extractMembersMutation.isPending}
                              >
                                <Download className="w-3 h-3 mr-1" />
                                Extract
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'contacts' && (
          <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
            <CardHeader className="flex flex-col space-y-4 bg-[#1A1A2E]/95 backdrop-blur-sm border-b border-white/5 pb-4 sticky top-0 z-20 rounded-t-xl">
              <div className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg font-medium text-[#F1F5F9]">WhatsApp Contacts</CardTitle>
                <div className="flex space-x-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="border-white/10 hover:bg-white/10 text-[#F1F5F9]"
                    onClick={handleExportContactsCSV}
                    disabled={selectedContacts.length === 0}
                  >
                    <FileSpreadsheet className="w-4 h-4 mr-2 text-[#3B82F6]" />
                    Export CSV ({selectedContacts.length})
                  </Button>
                  <Button 
                    className="bg-[#3B82F6] hover:bg-[#2563EB] text-white border-none"
                    size="sm"
                    onClick={() => extractContactsMutation.mutate({ accountId: viewingGroupsAccount.id, phones: selectedContacts })}
                    disabled={selectedContacts.length === 0 || extractContactsMutation.isPending}
                  >
                    {extractContactsMutation.isPending ? (
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 mr-2" />
                    )}
                    Extract Selected to CRM ({selectedContacts.length})
                  </Button>
                  <Button 
                    className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white border-none"
                    size="sm"
                    onClick={() => {
                      const contactsToUse = selectedContacts.length > 0 ? selectedContacts : (contacts?.map((c: any) => c.phone) || []);
                      // Check if there are active campaigns to add to
                      const activeCampaigns = allCampaigns.filter((c: any) => c.status !== 'completed' && c.status !== 'failed');
                      
                      if (activeCampaigns.length > 0) {
                        // Show menu for Create New or Add to Existing
                        // For now, just create new campaign
                        setSelectedGroupsForCampaign([]); // Clear groups for contacts campaign
                        setCampaignFormData({
                          name: '',
                          messageTemplate: '',
                          scheduleType: 'immediate',
                          scheduledDate: '',
                          scheduledTime: '',
                          maxPerHour: 100,
                          maxPerDay: 1000,
                          delayMinMs: 100,
                          delayMaxMs: 500
                        });
                        setIsCampaignDialogOpen(true);
                      } else {
                        // Only create new campaign available
                        setSelectedGroupsForCampaign([]);
                        setCampaignFormData({
                          name: '',
                          messageTemplate: '',
                          scheduleType: 'immediate',
                          scheduledDate: '',
                          scheduledTime: '',
                          maxPerHour: 100,
                          maxPerDay: 1000,
                          delayMinMs: 100,
                          delayMaxMs: 500
                        });
                        setIsCampaignDialogOpen(true);
                      }
                    }}
                    disabled={!viewingGroupsAccount || (selectedContacts.length === 0 && (!contacts || contacts.length === 0))}
                  >
                    <Zap className="w-4 h-4 mr-2" />
                    Create Campaign
                  </Button>
                </div>
              </div>
               <div className="flex items-center space-x-6 text-sm text-[#94A3B8]">
                 <label className="flex items-center space-x-2 cursor-pointer">
                   <input 
                     type="checkbox" 
                     className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#3B82F6]"
                     checked={showNamedContactsOnly}
                     onChange={(e) => setShowNamedContactsOnly(e.target.checked)}
                   />
                   <span>Show Only Contacts with Names</span>
                 </label>
                 <div className="flex items-center space-x-2">
                   <span className="text-[#94A3B8]">Sort by:</span>
                   <select 
                     className="bg-[#0F0F1A] border border-white/10 rounded px-2 py-1 text-sm text-[#F1F5F9] focus:outline-none focus:border-[#3B82F6]/50"
                     value={contactsSortBy}
                     onChange={(e) => setContactsSortBy(e.target.value as 'recent' | 'name')}
                   >
                     <option value="recent">Most Recent</option>
                     <option value="name">Name (A-Z)</option>
                   </select>
                 </div>
               </div>
            </CardHeader>
            <CardContent className="p-0">
              {isLoadingContacts ? (
                <div className="flex flex-col items-center justify-center py-16">
                  <RefreshCw className="w-8 h-8 text-[#3B82F6] animate-spin mb-4" />
                  <p className="text-[#94A3B8]">Fetching contacts from WhatsApp...</p>
                </div>
              ) : isContactsError ? (
                <div className="py-12 px-6 text-center">
                  <div className="inline-block bg-red-500/10 border border-red-500/20 rounded-lg p-4">
                    <p className="text-red-400 font-medium">{contactsError?.message}</p>
                    <p className="text-[#94A3B8] text-sm mt-2">Try sending a message from your phone to keep the session active, or reconnect the account.</p>
                  </div>
                </div>
              ) : contacts?.length === 0 ? (
                <p className="text-center text-[#94A3B8] py-16">No contacts found for this account.</p>
              ) : (
                <div className="overflow-auto h-[calc(100vh-250px)]">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 z-10 bg-[#1A1A2E]/95 backdrop-blur-sm">
                      <tr className="border-b border-white/10 text-[#94A3B8] text-sm bg-black/20">
                        <th className="p-4 w-12 text-center">
                          <input 
                            type="checkbox" 
                            className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#3B82F6] cursor-pointer"
                            checked={sortedContacts.length > 0 && selectedContacts.length === sortedContacts.length}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedContacts(sortedContacts.map((c: any) => c.phone));
                              } else {
                                setSelectedContacts([]);
                              }
                            }}
                          />
                        </th>
                        <th className="p-4 font-medium">Name</th>
                        <th className="p-4 font-medium">Phone Number</th>
                        <th className="p-4 font-medium">Source</th>
                        <th className="p-4 font-medium">Last Activity</th>
                        <th className="p-4 font-medium text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedContacts?.map((contact: any) => (
                        <tr key={contact.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                          <td className="p-4 text-center">
                            <input 
                              type="checkbox" 
                              className="rounded border-white/20 bg-transparent w-4 h-4 accent-[#3B82F6] cursor-pointer"
                              checked={selectedContacts.includes(contact.phone)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedContacts([...selectedContacts, contact.phone]);
                                } else {
                                  setSelectedContacts(selectedContacts.filter(p => p !== contact.phone));
                                }
                              }}
                            />
                          </td>
                          <td className="p-4">
                            <span className="font-medium text-[#F1F5F9]">{contact.name || '-'}</span>
                          </td>
                          <td className="p-4 text-sm text-[#94A3B8] font-mono">{contact.phone}</td>
                          <td className="p-4">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium border ${
                              contact.source === 'contact' 
                                ? 'bg-[#10B981]/20 text-[#10B981] border-[#10B981]/20' 
                                : 'bg-[#F59E0B]/20 text-[#F59E0B] border-[#F59E0B]/20'
                            }`}>
                              {contact.source === 'contact' ? 'Contact' : 'Chat History'}
                            </span>
                          </td>
                          <td className="p-4 text-sm text-[#94A3B8]">
                            {contact.lastInteraction ? new Date(contact.lastInteraction).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never'}
                          </td>
                          <td className="p-4 text-right">
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-8 text-xs text-[#3B82F6] hover:text-[#3B82F6] hover:bg-[#3B82F6]/10"
                              onClick={() => extractContactsMutation.mutate({ accountId: viewingGroupsAccount.id, phones: [contact.phone] })}
                              disabled={extractContactsMutation.isPending}
                            >
                              <Download className="w-3 h-3 mr-1" />
                              Extract
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-[#F1F5F9]">WhatsApp Accounts</h2>
          <p className="text-[#94A3B8] mt-1">Manage your connected WhatsApp accounts.</p>
        </div>
        
        <Dialog open={isAddDialogOpen} onOpenChange={handleDialogChange}>
          <DialogTrigger asChild>
            <Button className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white">
              <Plus className="w-4 h-4 mr-2" />
              Add Account
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-[#1A1A2E] border-white/10 text-[#F1F5F9] sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Add WhatsApp Account</DialogTitle>
            </DialogHeader>
            
            {!connectingAccountId ? (
              <form onSubmit={handleAddAccount} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Display Name</Label>
                  <Input 
                    id="name" 
                    placeholder="e.g. Sales Team 1" 
                    value={newAccountName}
                    onChange={(e) => setNewAccountName(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number (Optional)</Label>
                  <Input 
                    id="phone" 
                    placeholder="e.g. +1234567890" 
                    value={newAccountPhone}
                    onChange={(e) => setNewAccountPhone(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10"
                  />
                </div>
                <Button 
                  type="submit" 
                  className="w-full bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                  disabled={addAccountMutation.isPending}
                >
                  {addAccountMutation.isPending ? 'Initializing...' : 'Generate QR Code'}
                </Button>
              </form>
            ) : (
              <div className="flex flex-col items-center justify-center py-6 space-y-4">
                {qrCodeData ? (
                  <>
                    <div className="bg-white p-4 rounded-xl">
                      <QRCodeSVG value={qrCodeData} size={200} />
                    </div>
                    <p className="text-sm text-center text-[#94A3B8]">
                      Open WhatsApp on your phone and scan this QR code to link your account.
                    </p>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-10 h-10 text-[#06B6D4] animate-spin" />
                    <p className="text-sm text-[#94A3B8]">Generating QR Code...</p>
                  </>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-8 h-8 text-[#7C3AED] animate-spin" />
        </div>
      ) : accounts?.length === 0 ? (
        <Card className="bg-[#1A1A2E]/50 border-white/10 border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-full bg-[#7C3AED]/20 flex items-center justify-center mb-4">
              <Smartphone className="w-6 h-6 text-[#7C3AED]" />
            </div>
            <h3 className="text-lg font-medium text-[#F1F5F9]">No accounts connected</h3>
            <p className="text-[#94A3B8] mt-2 max-w-md">
              You haven&apos;t connected any WhatsApp accounts yet. Click the &quot;Add Account&quot; button to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {accounts?.map((account: any) => (
            <Card 
              key={account.id} 
              className="bg-[#1A1A2E]/50 backdrop-blur-md border-white/10 hover:bg-[#16213E] transition-all duration-300 hover:shadow-lg hover:shadow-[#10B981]/20 hover:border-white/20 cursor-pointer"
              onClick={() => {
                if (account.status === 'connected') {
                  setViewingGroupsAccount(account);
                }
              }}
            >
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-medium text-[#F1F5F9] truncate pr-4" title={account.displayName}>
                  {account.displayName}
                </CardTitle>
                <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                  account.status === 'connected' ? 'bg-[#10B981]/20 text-[#10B981]' :
                  account.status === 'connecting' ? 'bg-[#F59E0B]/20 text-[#F59E0B]' :
                  'bg-[#EF4444]/20 text-[#EF4444]'
                }`}>
                  {account.status}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center text-sm text-[#94A3B8]">
                    <Smartphone className="w-4 h-4 mr-2" />
                    {account.phoneNumber || 'Unknown Number'}
                  </div>
                  {account.proxyProfileId && proxyProfilesMap.get(account.proxyProfileId) && (
                    <div className="text-xs text-[#60A5FA] bg-[#60A5FA]/10 border border-[#60A5FA]/20 rounded px-2 py-1 inline-flex items-center w-fit">
                      Proxy: {proxyProfilesMap.get(account.proxyProfileId).name}
                    </div>
                  )}
                  
                  {/* Account Statistics */}
                  {account.status === 'connected' && statsMap.get(account.id) && (
                    <div className="grid grid-cols-2 gap-2 py-2">
                      {/* Groups Count */}
                      <div className="bg-[#16213E] rounded px-2 py-1.5 flex items-center space-x-2">
                        <Users className="w-3.5 h-3.5 text-[#10B981] flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs text-[#94A3B8]">Groups</div>
                          <div className="text-sm font-medium text-[#F1F5F9]">{statsMap.get(account.id).totalGroups ?? 0}</div>
                        </div>
                      </div>
                      
                      {/* Contacts Count */}
                      <div className="bg-[#16213E] rounded px-2 py-1.5 flex items-center space-x-2">
                        <Users className="w-3.5 h-3.5 text-[#3B82F6] flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs text-[#94A3B8]">Contacts</div>
                          <div className="text-sm font-medium text-[#F1F5F9]">{statsMap.get(account.id).uniqueContacts ?? 0}</div>
                        </div>
                      </div>
                      
                      {/* Messages Sent */}
                      <div className="bg-[#16213E] rounded px-2 py-1.5 flex items-center space-x-2">
                        <FileSpreadsheet className="w-3.5 h-3.5 text-[#F59E0B] flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs text-[#94A3B8]">Sent</div>
                          <div className="text-sm font-medium text-[#F1F5F9]">{statsMap.get(account.id).sentMessages ?? 0}</div>
                        </div>
                      </div>
                      
                      {/* Campaigns */}
                      <div className="bg-[#16213E] rounded px-2 py-1.5 flex items-center space-x-2">
                        <Zap className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs text-[#94A3B8]">Campaigns</div>
                          <div className="text-sm font-medium text-[#F1F5F9]">{statsMap.get(account.id).completedCampaigns ?? 0}</div>
                        </div>
                      </div>
                    </div>
                  )}
                  
                  <div className="flex justify-between items-center pt-4 border-t border-white/5">
                    <span className="text-xs text-[#94A3B8]">
                      Added {new Date(account.createdAt).toLocaleDateString()}
                    </span>
                    <div className="flex space-x-1" onClick={(e) => e.stopPropagation()}>
                      {account.status === 'connected' && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-[#10B981] hover:text-[#10B981] hover:bg-[#10B981]/10 h-8 px-2"
                          onClick={() => setViewingGroupsAccount(account)}
                          title="View Groups"
                        >
                          <Users className="w-4 h-4" />
                        </Button>
                      )}
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-[#3B82F6] hover:text-[#3B82F6] hover:bg-[#3B82F6]/10 h-8 px-2"
                        onClick={() => setEditingAccount(account)}
                        title="Edit Account"
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#EF4444]/10 h-8 px-2"
                        onClick={() => {
                          setDeleteConfirmDialog({ 
                            open: true, 
                            accountId: account.id,
                            accountName: account.displayName 
                          });
                        }}
                        title="Delete Account"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Account Dialog */}
      <Dialog open={!!editingAccount} onOpenChange={(open) => !open && setEditingAccount(null)}>
        <DialogContent className="bg-[#1A1A2E] border-white/10 text-[#F1F5F9] sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit Account</DialogTitle>
          </DialogHeader>
          {editingAccount && (
            <form onSubmit={(e) => {
              e.preventDefault();
              editAccountMutation.mutate({
                id: editingAccount.id,
                displayName: editingAccount.displayName,
                phone: editingAccount.phoneNumber || '',
                proxyProfileId: editingAccount.proxyProfileId || null,
              });
            }} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Display Name</Label>
                <Input 
                  id="edit-name" 
                  value={editingAccount.displayName}
                  onChange={(e) => setEditingAccount({...editingAccount, displayName: e.target.value})}
                  className="bg-[#0F0F1A] border-white/10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-phone">Phone Number</Label>
                <Input 
                  id="edit-phone" 
                  value={editingAccount.phoneNumber || ''}
                  onChange={(e) => setEditingAccount({...editingAccount, phoneNumber: e.target.value})}
                  className="bg-[#0F0F1A] border-white/10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-proxy">Proxy Profile</Label>
                <select
                  id="edit-proxy"
                  value={editingAccount.proxyProfileId || ''}
                  onChange={(e) => setEditingAccount({ ...editingAccount, proxyProfileId: e.target.value || null })}
                  className="w-full rounded-md bg-[#0F0F1A] border border-white/10 px-3 py-2 text-sm text-[#F1F5F9]"
                >
                  <option value="">No Proxy</option>
                  {proxyProfiles.map((profile: any) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} ({profile.type} - {profile.host}:{profile.port})
                    </option>
                  ))}
                </select>
              </div>
              <Button 
                type="submit" 
                className="w-full bg-[#3B82F6] hover:bg-[#2563EB] text-white"
                disabled={editAccountMutation.isPending}
              >
                {editAccountMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Campaign Creation Modal */}
      <Dialog open={isCampaignDialogOpen} onOpenChange={setIsCampaignDialogOpen}>
        <DialogContent className="bg-[#1A1A2E] border-white/10 max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-[#F1F5F9]">Create Bulk Campaign</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Campaign Name */}
            <div className="space-y-2">
              <Label htmlFor="campaign-name" className="text-[#F1F5F9]">Campaign Name</Label>
              <Input
                id="campaign-name"
                placeholder="e.g., Spring Promotion 2026"
                value={campaignFormData.name}
                onChange={(e) => setCampaignFormData({...campaignFormData, name: e.target.value})}
                className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
              />
            </div>

            {/* Account Info (Read-only) */}
            <div className="space-y-2">
              <Label className="text-[#F1F5F9]">Account</Label>
              <div className="bg-[#0F0F1A] border border-white/10 rounded-md p-3 text-[#94A3B8]">
                {viewingGroupsAccount?.displayName} ({viewingGroupsAccount?.phone})
              </div>
            </div>

            {/* Selected Groups (Read-only) */}
            <div className="space-y-2">
              <Label className="text-[#F1F5F9]">Groups ({selectedGroupsForCampaign.length})</Label>
              <div className="bg-[#0F0F1A] border border-white/10 rounded-md p-3 max-h-24 overflow-y-auto">
                <div className="text-[#94A3B8] text-sm space-y-1">
                  {sortedGroups
                    .filter((g: any) => selectedGroupsForCampaign.includes(g.id))
                    .map((g: any) => (
                      <div key={g.id} className="text-[#F1F5F9]">• {g.subject}</div>
                    ))}
                  {selectedGroupsForCampaign.length === 0 && <div>All available groups will be used</div>}
                </div>
              </div>
            </div>

            {/* Message Template */}
            <div className="space-y-2">
              <Label htmlFor="template" className="text-[#F1F5F9]">Message Template</Label>
              <select
                id="template"
                value={campaignFormData.messageTemplate}
                onChange={(e) => setCampaignFormData({...campaignFormData, messageTemplate: e.target.value})}
                className="w-full bg-[#0F0F1A] border border-white/10 rounded-md p-2 text-[#F1F5F9]"
              >
                <option value="" className="bg-[#1A1A2E]">Select a template</option>
                <option value="welcome" className="bg-[#1A1A2E]">Welcome Message</option>
                <option value="promo" className="bg-[#1A1A2E]">Promotion</option>
                <option value="announcement" className="bg-[#1A1A2E]">Announcement</option>
                <option value="survey" className="bg-[#1A1A2E]">Survey</option>
              </select>
            </div>

            {/* Schedule Type */}
            <div className="space-y-2">
              <Label className="text-[#F1F5F9]">Schedule Type</Label>
              <div className="flex gap-4">
                <button
                  onClick={() => setCampaignFormData({...campaignFormData, scheduleType: 'immediate'})}
                  className={`flex-1 p-2 rounded-md border ${
                    campaignFormData.scheduleType === 'immediate'
                      ? 'bg-[#10B981] border-[#10B981] text-white'
                      : 'bg-[#0F0F1A] border-white/10 text-[#94A3B8]'
                  }`}
                >
                  Send Immediately
                </button>
                <button
                  onClick={() => setCampaignFormData({...campaignFormData, scheduleType: 'scheduled'})}
                  className={`flex-1 p-2 rounded-md border ${
                    campaignFormData.scheduleType === 'scheduled'
                      ? 'bg-[#10B981] border-[#10B981] text-white'
                      : 'bg-[#0F0F1A] border-white/10 text-[#94A3B8]'
                  }`}
                >
                  Schedule for Later
                </button>
              </div>
            </div>

            {/* Scheduled Date/Time */}
            {campaignFormData.scheduleType === 'scheduled' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sched-date" className="text-[#F1F5F9]">Date</Label>
                  <Input
                    id="sched-date"
                    type="date"
                    value={campaignFormData.scheduledDate}
                    onChange={(e) => setCampaignFormData({...campaignFormData, scheduledDate: e.target.value})}
                    className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sched-time" className="text-[#F1F5F9]">Time</Label>
                  <Input
                    id="sched-time"
                    type="time"
                    value={campaignFormData.scheduledTime}
                    onChange={(e) => setCampaignFormData({...campaignFormData, scheduledTime: e.target.value})}
                    className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                  />
                </div>
              </div>
            )}

            {/* Rate Limits */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="max-hour" className="text-[#F1F5F9]">Max per Hour</Label>
                <Input
                  id="max-hour"
                  type="number"
                  min="1"
                  value={campaignFormData.maxPerHour}
                  onChange={(e) => setCampaignFormData({...campaignFormData, maxPerHour: parseInt(e.target.value) || 0})}
                  className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max-day" className="text-[#F1F5F9]">Max per Day</Label>
                <Input
                  id="max-day"
                  type="number"
                  min="1"
                  value={campaignFormData.maxPerDay}
                  onChange={(e) => setCampaignFormData({...campaignFormData, maxPerDay: parseInt(e.target.value) || 0})}
                  className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                />
              </div>
            </div>

            {/* Message Delay */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="delay-min" className="text-[#F1F5F9]">Delay Min (ms)</Label>
                <Input
                  id="delay-min"
                  type="number"
                  min="0"
                  value={campaignFormData.delayMinMs}
                  onChange={(e) => setCampaignFormData({...campaignFormData, delayMinMs: parseInt(e.target.value) || 0})}
                  className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="delay-max" className="text-[#F1F5F9]">Delay Max (ms)</Label>
                <Input
                  id="delay-max"
                  type="number"
                  min="0"
                  value={campaignFormData.delayMaxMs}
                  onChange={(e) => setCampaignFormData({...campaignFormData, delayMaxMs: parseInt(e.target.value) || 0})}
                  className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9]"
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-3 pt-4">
              <Button
                variant="outline"
                onClick={() => setIsCampaignDialogOpen(false)}
                className="border-white/10 text-[#94A3B8] hover:bg-white/5"
              >
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!campaignFormData.name.trim()) {
                    toast.error('Please enter a campaign name');
                    return;
                  }
                  if (!campaignFormData.messageTemplate) {
                    toast.error('Please select a message template');
                    return;
                  }
                  if (campaignFormData.scheduleType === 'scheduled' && (!campaignFormData.scheduledDate || !campaignFormData.scheduledTime)) {
                    toast.error('Please select date and time for scheduled campaign');
                    return;
                  }

                  try {
                    const scheduledAt = campaignFormData.scheduleType === 'scheduled'
                      ? new Date(`${campaignFormData.scheduledDate}T${campaignFormData.scheduledTime}`).toISOString()
                      : null;

                    const res = await fetch('/api/campaigns', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        name: campaignFormData.name,
                        accountId: viewingGroupsAccount.id,
                        groupIds: selectedGroupsForCampaign,
                        messageTemplate: campaignFormData.messageTemplate,
                        recipientType: 'groups',
                        segmentId: null,
                        scheduledAt,
                        maxPerHour: campaignFormData.maxPerHour,
                        maxPerDay: campaignFormData.maxPerDay,
                        delayMinMs: campaignFormData.delayMinMs,
                        delayMaxMs: campaignFormData.delayMaxMs
                      })
                    });

                    if (!res.ok) {
                      const err = await res.json();
                      throw new Error(err.error || 'Failed to create campaign');
                    }

                    toast.success('Campaign created successfully!');
                    setIsCampaignDialogOpen(false);
                    queryClient.invalidateQueries({ queryKey: ['campaigns'] });
                  } catch (error) {
                    toast.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
                  }
                }}
                className="flex-1 bg-[#10B981] hover:bg-[#059669] text-white"
              >
                Create Campaign
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteConfirmDialog.open} onOpenChange={(open) => setDeleteConfirmDialog({ ...deleteConfirmDialog, open })}>
        <AlertDialogContent className="bg-[#1A1A2E] border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#F1F5F9]">حذف حساب</AlertDialogTitle>
            <AlertDialogDescription className="text-[#94A3B8]">
              آیا مطمئن هستید که می‌خواهید حساب <strong>{deleteConfirmDialog.accountName}</strong> را حذف کنید؟
              <br />
              <span className="text-[#EF4444] text-sm mt-2 block">این عملیات قابل بازگشت نیست!</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-3 justify-end">
            <AlertDialogCancel className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9] hover:bg-[#0F0F1A]/80">
              انصراف
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => {
                if (deleteConfirmDialog.accountId) {
                  deleteAccountMutation.mutate(deleteConfirmDialog.accountId);
                }
                setDeleteConfirmDialog({ open: false, accountId: null, accountName: '' });
              }}
              className="bg-[#EF4444] hover:bg-[#DC2626]"
            >
              حذف
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
