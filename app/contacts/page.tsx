'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Users, Plus, Trash2, Search, Download, FileSpreadsheet, RefreshCw, Activity, Filter, CheckSquare, Clock } from 'lucide-react';
import { toast } from 'sonner';

type TabType = 'contacts' | 'activity' | 'segmentation' | 'tasks';

export default function ContactsPage() {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    if (typeof window === 'undefined') {
      return 'contacts';
    }

    const savedTab = window.localStorage.getItem('crm_activeTab');
    return savedTab && ['contacts', 'activity', 'segmentation', 'tasks'].includes(savedTab)
      ? (savedTab as TabType)
      : 'contacts';
  });
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [segmentBy, setSegmentBy] = useState<'tag' | 'source' | 'date'>('tag');
  const [isAddTaskDialogOpen, setIsAddTaskDialogOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [taskPriority, setTaskPriority] = useState('medium');
  const [taskDueDate, setTaskDueDate] = useState('');
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{ open: boolean; contactId: string | null; contactName: string }>({ open: false, contactId: null, contactName: '' });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('crm_activeTab', activeTab);
    }
  }, [activeTab]);
  
  // Form state
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');

  const { data: contacts, isLoading } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const res = await fetch('/api/contacts');
      if (!res.ok) throw new Error('Failed to fetch contacts');
      return res.json();
    }
  });

  // Fetch activity history
  const { data: activities, isLoading: isLoadingActivities, refetch: refetchActivities } = useQuery({
    queryKey: ['contact-activities', selectedContactId],
    queryFn: async () => {
      if (selectedContactId) {
        const res = await fetch(`/api/contacts/${selectedContactId}/activities`);
        if (!res.ok) throw new Error('Failed to fetch activities');
        return res.json();
      }
      const res = await fetch('/api/contacts/activities');
      if (!res.ok) throw new Error('Failed to fetch activities');
      return res.json();
    },
    enabled: activeTab === 'activity'
  });

  // Fetch segmentation data
  const { data: segmentedData, isLoading: isLoadingSegmentation } = useQuery({
    queryKey: ['contact-segments', segmentBy],
    queryFn: async () => {
      const res = await fetch(`/api/contacts/segments/by-${segmentBy}`);
      if (!res.ok) throw new Error('Failed to fetch segments');
      return res.json();
    },
    enabled: activeTab === 'segmentation'
  });

  // Fetch tasks
  const { data: tasks, isLoading: isLoadingTasks } = useQuery({
    queryKey: ['contact-tasks', selectedContactId],
    queryFn: async () => {
      if (selectedContactId) {
        const res = await fetch(`/api/contacts/${selectedContactId}/tasks`);
        if (!res.ok) throw new Error('Failed to fetch tasks');
        return res.json();
      }
      const res = await fetch('/api/contacts/tasks');
      if (!res.ok) throw new Error('Failed to fetch tasks');
      return res.json();
    },
    enabled: activeTab === 'tasks'
  });

  // Add task mutation
  const addTaskMutation = useMutation({
    mutationFn: async (data: any) => {
      const contactId = selectedContactId || contacts?.[0]?.id;
      if (!contactId) throw new Error('لطفاً یک مخاطب انتخاب کنید');
      
      const res = await fetch(`/api/contacts/${contactId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('Failed to add task');
      return res.json();
    },
    onSuccess: () => {
      toast.success('تسک اضافه شد');
      setIsAddTaskDialogOpen(false);
      setTaskTitle('');
      setTaskDescription('');
      setTaskPriority('medium');
      setTaskDueDate('');
      queryClient.invalidateQueries({ queryKey: ['contact-tasks'] });
    },
    onError: (error) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  // Update task mutation
  const updateTaskMutation = useMutation({
    mutationFn: async ({ taskId, status }: any) => {
      const contactId = selectedContactId;
      if (!contactId) throw new Error('مخاطب انتخاب نشده است');

      const res = await fetch(`/api/contacts/${contactId}/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error('Failed to update task');
      return res.json();
    },
    onSuccess: () => {
      toast.success('تسک بروزرسانی شد');
      queryClient.invalidateQueries({ queryKey: ['contact-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['contact-activities'] });
    },
    onError: (error) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  // Delete task mutation
  const deleteTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const contactId = selectedContactId;
      if (!contactId) throw new Error('مخاطب انتخاب نشده است');

      const res = await fetch(`/api/contacts/${contactId}/tasks/${taskId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete task');
      return res.json();
    },
    onSuccess: () => {
      toast.success('تسک حذف شد');
      queryClient.invalidateQueries({ queryKey: ['contact-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['contact-activities'] });
    },
    onError: (error) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  const addContactMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to add contact');
      return res.json();
    },
    onSuccess: () => {
      toast.success('مخاطب با موفقیت اضافه شد');
      setIsAddDialogOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (error) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete contact');
      return res.json();
    },
    onSuccess: () => {
      toast.success('مخاطب حذف شد');
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (error) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  const resetForm = () => {
    setFullName('');
    setPhone('');
    setEmail('');
    setCountry('');
    setTags('');
    setNotes('');
  };

  const handleAddContact = (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) {
      toast.error('شماره تلفن الزامی است');
      return;
    }
    
    const tagsArray = tags.split(',').map(t => t.trim()).filter(t => t);
    
    addContactMutation.mutate({
      fullName,
      phone,
      email,
      country,
      tags: tagsArray,
      notes
    });
  };

  const handleExportCSV = () => {
    if (!contacts || contacts.length === 0) return;
    
    const headers = ['Full Name', 'Phone', 'Email', 'Country', 'Tags', 'Source', 'Created At'];
    const csvContent = [
      headers.join(','),
      ...contacts.map((c: any) => {
        const safeName = (c.fullName || '').replace(/"/g, '""');
        const safeEmail = (c.email || '').replace(/"/g, '""');
        const safeCountry = (c.country || '').replace(/"/g, '""');
        let parsedTags = [];
        try {
          parsedTags = JSON.parse(c.tags || '[]');
        } catch (e) {}
        const safeTags = parsedTags.join('; ').replace(/"/g, '""');
        const safeSource = (c.source || '').replace(/"/g, '""');
        const date = new Date(c.createdAt).toLocaleDateString();
        
        return `"${safeName}","${c.phone}","${safeEmail}","${safeCountry}","${safeTags}","${safeSource}","${date}"`;
      })
    ].join('\n');
    
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `CRM_Contacts_${new Date().getTime()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('مخاطبین با موفقیت صادر شدند!');
  };

  const filteredContacts = contacts?.filter((c: any) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      (c.fullName && c.fullName.toLowerCase().includes(q)) ||
      (c.phone && c.phone.toLowerCase().includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q)) ||
      (c.tags && c.tags.toLowerCase().includes(q))
    );
  }) || [];

  // Render Contacts Tab
  const renderContactsTab = () => (
    <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
      <CardHeader className="border-b border-white/5 pb-4">
        <div className="flex items-center bg-[#0F0F1A] rounded-lg px-3 py-2 w-full max-w-md border border-white/5 focus-within:border-[#7C3AED]/50 transition-colors">
          <Search className="w-4 h-4 text-[#94A3B8] mr-2" />
          <input 
            type="text" 
            placeholder="جستجو بر اساس نام، شماره، ایمیل..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="bg-transparent border-none outline-none text-sm text-[#F1F5F9] w-full placeholder:text-[#94A3B8]"
          />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <RefreshCw className="w-8 h-8 text-[#7C3AED] animate-spin mb-4" />
            <p className="text-[#94A3B8]">درحال بارگذاری...</p>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
            <p className="text-[#F1F5F9] font-medium text-lg">مخاطبی یافت نشد</p>
            <p className="text-[#94A3B8] mt-1 max-w-md">
              {searchQuery 
                ? "مخاطبی با این جستجو پیدا نشد" 
                : "مخاطبین خود را اضافه کنید یا از گروه‌های واتساپ استخراج کنید"}
            </p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-280px)]">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-[#1A1A2E]/95 backdrop-blur-sm">
                <tr className="border-b border-white/10 text-[#94A3B8] text-sm bg-black/20">
                  <th className="p-4 font-medium">نام</th>
                  <th className="p-4 font-medium">شماره</th>
                  <th className="p-4 font-medium">تگ‌ها</th>
                  <th className="p-4 font-medium">منبع</th>
                  <th className="p-4 font-medium">تاریخ اضافه</th>
                  <th className="p-4 font-medium text-right">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filteredContacts.map((contact: any) => {
                  let parsedTags: string[] = [];
                  try {
                    parsedTags = JSON.parse(contact.tags || '[]');
                  } catch (e) {}
                  
                  return (
                    <tr key={contact.id} className="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer" onClick={() => { setSelectedContactId(contact.id); setActiveTab('activity'); }}>
                      <td className="p-4">
                        <div className="flex flex-col">
                          <span className="font-medium text-[#F1F5F9]">{contact.fullName || '-'}</span>
                          {contact.email && <span className="text-xs text-[#94A3B8]">{contact.email}</span>}
                        </div>
                      </td>
                      <td className="p-4 text-sm text-[#94A3B8] font-mono">{contact.phone}</td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-1">
                          {parsedTags.length > 0 ? parsedTags.map((tag, i) => (
                            <span key={i} className="px-2 py-0.5 rounded-full bg-[#7C3AED]/20 text-[#7C3AED] text-[10px] font-medium border border-[#7C3AED]/20">
                              {tag}
                            </span>
                          )) : (
                            <span className="text-xs text-[#94A3B8]">-</span>
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <span className="text-xs text-[#94A3B8] capitalize">
                          {(contact.source || 'دستی').replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td className="p-4 text-xs text-[#94A3B8]">
                        {new Date(contact.createdAt).toLocaleDateString('fa-IR')}
                      </td>
                      <td className="p-4 text-right">
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-400/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmDialog({
                              open: true,
                              contactId: contact.id,
                              contactName: contact.fullName || contact.phone
                            });
                          }}
                          disabled={deleteContactMutation.isPending}
                        >
                          <Trash2 className="w-4 h-4" />
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
  );

  // Render Activity Tab
  const renderActivityTab = () => {
    const selectedContact = selectedContactId 
      ? contacts?.find((c: any) => c.id === selectedContactId)
      : null;

    return (
      <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
        <CardHeader className="bg-[#1A1A2E]/95 backdrop-blur-sm border-b border-white/5 pb-4 sticky top-0 z-20 rounded-t-xl">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg font-medium text-[#F1F5F9]">تاریخچه فعالیت‌ها</CardTitle>
              {selectedContact && (
                <p className="text-sm text-[#94A3B8] mt-2">
                  مخاطب: <span className="text-[#06B6D4]">{selectedContact.fullName || selectedContact.phone}</span>
                </p>
              )}
            </div>
            {selectedContact && (
              <Button 
                variant="ghost" 
                className="text-[#94A3B8] hover:text-white" 
                onClick={() => setSelectedContactId(null)}
              >
                بازگشت
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoadingActivities ? (
            <div className="flex flex-col items-center justify-center py-16">
              <RefreshCw className="w-8 h-8 text-[#06B6D4] animate-spin mb-4" />
              <p className="text-[#94A3B8]">درحال بارگذاری...</p>
            </div>
          ) : !activities || activities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Activity className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
              <p className="text-[#F1F5F9] font-medium text-lg">هیچ فعالیتی ثبت نشده</p>
              <p className="text-[#94A3B8] mt-1">
                {selectedContact 
                  ? 'برای این مخاطب فعالیتی وجود ندارد'
                  : 'اطلاعات فعالیت بعد از اضافه کردن یا ارسال پیام ظاهر می‌شود'}
              </p>
            </div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-280px)]">
              <div className="p-6 space-y-4">
                {activities.map((activity: any, idx: number) => (
                  <div key={idx} className="border-l-2 border-[#06B6D4] pl-4 py-3 hover:bg-white/5 rounded transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="text-[#F1F5F9] font-medium">{activity.action}</p>
                        <p className="text-[#94A3B8] text-sm mt-1">{activity.description}</p>
                        {activity.details && (
                          <p className="text-[#94A3B8]/70 text-xs mt-2">{activity.details}</p>
                        )}
                      </div>
                      <span className="text-[#94A3B8] text-xs whitespace-nowrap ml-4">
                        {new Date(activity.createdAt).toLocaleDateString('fa-IR')} 
                        <br/>
                        {new Date(activity.createdAt).toLocaleTimeString('fa-IR', { 
                          hour: '2-digit', 
                          minute: '2-digit' 
                        })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  // Render Segmentation Tab
  const renderSegmentationTab = () => (
    <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
      <CardHeader className="bg-[#1A1A2E]/95 backdrop-blur-sm border-b border-white/5 pb-4 sticky top-0 z-20 rounded-t-xl">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg font-medium text-[#F1F5F9]">بخش‌بندی مخاطبین</CardTitle>
          <div className="flex items-center space-x-3">
            <span className="text-sm text-[#94A3B8]">بر اساس:</span>
            <select 
              className="bg-[#0F0F1A] border border-white/10 rounded px-3 py-1.5 text-sm text-[#F1F5F9] focus:outline-none focus:border-[#10B981]/50"
              value={segmentBy}
              onChange={(e) => setSegmentBy(e.target.value as 'tag' | 'source' | 'date')}
            >
              <option value="tag">تگ‌ها</option>
              <option value="source">منبع</option>
              <option value="date">تاریخ اضافه‌شده</option>
            </select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoadingSegmentation ? (
          <div className="flex flex-col items-center justify-center py-16">
            <RefreshCw className="w-8 h-8 text-[#10B981] animate-spin mb-4" />
            <p className="text-[#94A3B8]">درحال بارگذاری...</p>
          </div>
        ) : !segmentedData || segmentedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Filter className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
            <p className="text-[#F1F5F9] font-medium text-lg">مخاطبی درر این دسته نیست</p>
            <p className="text-[#94A3B8] mt-1">مخاطبین خود را اضافه کنید تا آن‌ها اینجا نمایش داده شوند</p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-280px)]">
            <div className="p-6 space-y-6">
              {segmentedData.map((segment: any, idx: number) => (
                <div key={idx} className="border border-white/10 rounded-lg p-4 hover:bg-white/5 transition-colors">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="text-[#F1F5F9] font-medium text-base">{segment.segment}</h3>
                      <p className="text-[#94A3B8] text-sm mt-1">{segment.count} مخاطب</p>
                    </div>
                    <div className="text-right">
                      <span className="inline-block bg-[#10B981]/20 text-[#10B981] px-3 py-1 rounded-full text-sm font-medium">
                        {segment.count}
                      </span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {segment.contacts.map((contact: any, cidx: number) => (
                      <div 
                        key={cidx} 
                        className="bg-[#0F0F1A] border border-white/5 rounded p-3 cursor-pointer hover:border-white/20 transition-colors"
                        onClick={() => { setSelectedContactId(contact.id); setActiveTab('activity'); }}
                      >
                        <p className="text-[#F1F5F9] text-sm font-medium truncate">{contact.fullName || contact.phone}</p>
                        <p className="text-[#94A3B8] text-xs font-mono mt-1 truncate">{contact.phone}</p>
                        {contact.email && (
                          <p className="text-[#94A3B8] text-xs mt-1 truncate">{contact.email}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  // Render Tasks Tab
  const renderTasksTab = () => (
    <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
      <CardHeader className="bg-[#1A1A2E]/95 backdrop-blur-sm border-b border-white/5 pb-4 sticky top-0 z-20 rounded-t-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {selectedContactId && (
              <Button 
                variant="ghost" 
                size="sm"
                className="text-[#94A3B8] hover:text-[#F1F5F9]"
                onClick={() => setSelectedContactId(null)}
              >
                ← بازگشت
              </Button>
            )}
            <CardTitle className="text-lg font-medium text-[#F1F5F9]">تسک‌ها و یادآوری‌ها</CardTitle>
            {selectedContactId && (
              <span className="text-xs bg-[#7C3AED]/20 text-[#B39DDB] px-2 py-1 rounded-full">
                {contacts?.find((c: any) => c.id === selectedContactId)?.fullName || 'مخاطب'}
              </span>
            )}
          </div>
          {selectedContactId && (
            <Dialog open={isAddTaskDialogOpen} onOpenChange={setIsAddTaskDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-[#F59E0B] hover:bg-[#D97706] text-black">
                  <Plus className="w-4 h-4 mr-1" />
                  اضافه کردن تسک
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[#1A1A2E] border-white/10 text-[#F1F5F9] sm:max-w-[400px]">
                <DialogHeader>
                  <DialogTitle>اضافه کردن تسک جدید</DialogTitle>
                </DialogHeader>
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTaskMutation.mutate({
                      title: taskTitle,
                      description: taskDescription,
                      priority: taskPriority,
                      dueDate: taskDueDate || null
                    });
                  }}
                  className="space-y-4 mt-4"
                >
                  <div>
                    <Label className="text-[#94A3B8] text-sm">عنوان</Label>
                    <Input 
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder="مثال: تماس گرفتن با مشتری"
                      className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9] placeholder-[#64748B] mt-1"
                      required
                    />
                  </div>

                  <div>
                    <Label className="text-[#94A3B8] text-sm">توضیحات</Label>
                    <textarea 
                      value={taskDescription}
                      onChange={(e) => setTaskDescription(e.target.value)}
                      placeholder="توضیحات تسک..."
                      className="bg-[#0F0F1A] border border-white/10 rounded px-3 py-2 text-[#F1F5F9] placeholder-[#64748B] text-sm w-full focus:outline-none focus:border-[#06B6D4]/50 mt-1 h-24"
                    />
                  </div>

                  <div>
                    <Label className="text-[#94A3B8] text-sm">اولویت</Label>
                    <select 
                      value={taskPriority}
                      onChange={(e) => setTaskPriority(e.target.value)}
                      className="bg-[#0F0F1A] border border-white/10 rounded px-3 py-2 text-[#F1F5F9] text-sm w-full focus:outline-none focus:border-[#06B6D4]/50 mt-1"
                    >
                      <option value="low">کم</option>
                      <option value="medium">متوسط</option>
                      <option value="high">زیاد</option>
                    </select>
                  </div>

                  <div>
                    <Label className="text-[#94A3B8] text-sm">تاریخ موعد</Label>
                    <input 
                      type="date" 
                      value={taskDueDate}
                      onChange={(e) => setTaskDueDate(e.target.value)}
                      className="bg-[#0F0F1A] border border-white/10 rounded px-3 py-2 text-[#F1F5F9] text-sm w-full focus:outline-none focus:border-[#06B6D4]/50 mt-1"
                    />
                  </div>

                  <div className="flex space-x-2 pt-2">
                    <Button type="submit" disabled={addTaskMutation.isPending} className="bg-[#F59E0B] hover:bg-[#D97706] text-black flex-1">
                      {addTaskMutation.isPending ? 'در حال ذخیره...' : 'اضافه کردن'}
                    </Button>
                    <Button type="button" variant="outline" className="border-white/10 flex-1" onClick={() => setIsAddTaskDialogOpen(false)}>
                      انصراف
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {!selectedContactId ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <CheckSquare className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
            <p className="text-[#F1F5F9] font-medium text-lg">لطفاً یک مخاطب انتخاب کنید</p>
            <p className="text-[#94A3B8] mt-1">برای مشاهده و مدیریت تسک‌های یک مخاطب، ابتدا آن را از برگه مخاطبین انتخاب کنید</p>
          </div>
        ) : isLoadingTasks ? (
          <div className="flex flex-col items-center justify-center py-16">
            <RefreshCw className="w-8 h-8 text-[#F59E0B] animate-spin mb-4" />
            <p className="text-[#94A3B8]">درحال بارگذاری تسک‌ها...</p>
          </div>
        ) : !tasks || tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <CheckSquare className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
            <p className="text-[#F1F5F9] font-medium text-lg">تسکی وجود ندارد</p>
            <p className="text-[#94A3B8] mt-1">تسک جدید اضافه کنید تا اینجا نمایش داده شود</p>
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-280px)]">
            <div className="p-6 space-y-4">
              {tasks.map((task: any) => (
                <div 
                  key={task.id} 
                  className="bg-[#0F0F1A]/50 border border-white/10 rounded-lg p-4 hover:border-white/20 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h4 className={`font-medium text-base ${
                          task.status === 'completed' 
                            ? 'text-[#94A3B8] line-through' 
                            : 'text-[#F1F5F9]'
                        }`}>
                          {task.title}
                        </h4>
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          task.priority === 'high' 
                            ? 'bg-red-500/20 text-red-400' 
                            : task.priority === 'medium'
                            ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
                            : 'bg-green-500/20 text-green-400'
                        }`}>
                          {task.priority === 'high' ? 'زیاد' : task.priority === 'medium' ? 'متوسط' : 'کم'}
                        </span>
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          task.status === 'completed'
                            ? 'bg-[#10B981]/20 text-[#10B981]'
                            : task.status === 'in-progress'
                            ? 'bg-[#06B6D4]/20 text-[#06B6D4]'
                            : 'bg-[#7C3AED]/20 text-[#B39DDB]'
                        }`}>
                          {task.status === 'completed' ? 'تکمیل شده' : task.status === 'in-progress' ? 'درحال انجام' : 'منتظر'}
                        </span>
                      </div>

                      {task.description && (
                        <p className="text-[#94A3B8] text-sm mt-2">{task.description}</p>
                      )}

                      {task.dueDate && (
                        <div className="flex items-center gap-2 mt-3 text-sm text-[#94A3B8]">
                          <Clock className="w-4 h-4" />
                          <span>موعد: {new Date(task.dueDate).toLocaleDateString('fa-IR')}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {task.status !== 'completed' && (
                        <Button 
                          size="sm" 
                          variant="ghost"
                          className="text-[#10B981] hover:bg-[#10B981]/20"
                          onClick={() => updateTaskMutation.mutate({ taskId: task.id, status: 'completed' })}
                          disabled={updateTaskMutation.isPending}
                        >
                          <CheckSquare className="w-4 h-4" />
                        </Button>
                      )}
                      <Button 
                        size="sm" 
                        variant="ghost"
                        className="text-red-500 hover:bg-red-500/20"
                        onClick={() => deleteTaskMutation.mutate(task.id)}
                        disabled={deleteTaskMutation.isPending}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-[#F1F5F9]">مخاطبین / CRM</h2>
          <p className="text-[#94A3B8] mt-1">مدیریت مخاطبین، مشتریان و استخراج شده‌ها</p>
        </div>
        
        <div className="flex space-x-3">
          <Button 
            variant="outline" 
            className="border-white/10 hover:bg-white/10 text-[#F1F5F9]"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['contacts'] })}
          >
            <RefreshCw className="w-4 h-4 mr-2 text-[#06B6D4]" />
            تازه‌سازی
          </Button>
          
          <Button 
            variant="outline" 
            className="border-white/10 hover:bg-white/10 text-[#F1F5F9]"
            onClick={handleExportCSV}
            disabled={!contacts || contacts.length === 0}
          >
            <FileSpreadsheet className="w-4 h-4 mr-2 text-[#10B981]" />
            صادر CSV
          </Button>
          
          <Dialog open={isAddDialogOpen} onOpenChange={(open) => {
            setIsAddDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white">
                <Plus className="w-4 h-4 mr-2" />
                اضافه کردن
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-[#1A1A2E] border-white/10 text-[#F1F5F9] sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle>اضافه کردن مخاطب</DialogTitle>
              </DialogHeader>
              
              <form onSubmit={handleAddContact} className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="fullName">نام کامل</Label>
                    <Input 
                      id="fullName" 
                      placeholder="John Doe" 
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">شماره تلفن *</Label>
                    <Input 
                      id="phone" 
                      placeholder="+1234567890" 
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10"
                      required
                    />
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">ایمیل</Label>
                    <Input 
                      id="email" 
                      type="email"
                      placeholder="john@example.com" 
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="country">کشور / شهر</Label>
                    <Input 
                      id="country" 
                      placeholder="ایران, تهران" 
                      value={country}
                      onChange={(e) => setCountry(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10"
                    />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="tags">تگ‌ها (جدا شده با کاما)</Label>
                  <Input 
                    id="tags" 
                    placeholder="VIP, Lead, Extracted" 
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="notes">یادداشت‌ها</Label>
                  <Input 
                    id="notes" 
                    placeholder="اطلاعات اضافی..." 
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10"
                  />
                </div>
                
                <div className="pt-4 flex justify-end">
                  <Button 
                    type="submit" 
                    className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                    disabled={addContactMutation.isPending}
                  >
                    {addContactMutation.isPending ? 'ذخیره...' : 'ذخیره'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex space-x-4 border-b border-white/10 pb-px">
        <button 
          className={`px-4 py-2 font-medium text-sm transition-colors relative flex items-center gap-2 ${activeTab === 'contacts' ? 'text-[#7C3AED]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
          onClick={() => setActiveTab('contacts')}
        >
          <Users className="w-4 h-4" />
          مخاطبین
          {activeTab === 'contacts' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#7C3AED] rounded-t-full" />}
        </button>
        <button 
          className={`px-4 py-2 font-medium text-sm transition-colors relative flex items-center gap-2 ${activeTab === 'activity' ? 'text-[#06B6D4]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
          onClick={() => setActiveTab('activity')}
        >
          <Clock className="w-4 h-4" />
          تاریخچه
          {activeTab === 'activity' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#06B6D4] rounded-t-full" />}
        </button>
        <button 
          className={`px-4 py-2 font-medium text-sm transition-colors relative flex items-center gap-2 ${activeTab === 'segmentation' ? 'text-[#10B981]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
          onClick={() => setActiveTab('segmentation')}
        >
          <Filter className="w-4 h-4" />
          بخش‌بندی
          {activeTab === 'segmentation' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#10B981] rounded-t-full" />}
        </button>
        <button 
          className={`px-4 py-2 font-medium text-sm transition-colors relative flex items-center gap-2 ${activeTab === 'tasks' ? 'text-[#F59E0B]' : 'text-[#94A3B8] hover:text-[#F1F5F9]'}`}
          onClick={() => setActiveTab('tasks')}
        >
          <CheckSquare className="w-4 h-4" />
          تسک‌ها
          {activeTab === 'tasks' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#F59E0B] rounded-t-full" />}
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'contacts' && renderContactsTab()}
      {activeTab === 'activity' && renderActivityTab()}
      {activeTab === 'segmentation' && renderSegmentationTab()}
      {activeTab === 'tasks' && renderTasksTab()}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteConfirmDialog.open} onOpenChange={(open) => setDeleteConfirmDialog({ ...deleteConfirmDialog, open })}>
        <AlertDialogContent className="bg-[#1A1A2E] border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#F1F5F9]">حذف مخاطب</AlertDialogTitle>
            <AlertDialogDescription className="text-[#94A3B8]">
              آیا مطمئن هستید که می‌خواهید <strong>{deleteConfirmDialog.contactName}</strong> را حذف کنید؟
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
                if (deleteConfirmDialog.contactId) {
                  deleteContactMutation.mutate(deleteConfirmDialog.contactId);
                }
                setDeleteConfirmDialog({ open: false, contactId: null, contactName: '' });
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
