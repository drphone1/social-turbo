'use client';

import { Fragment, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Megaphone, Plus, Trash2, Edit, Play, Pause, RefreshCw, Copy, ImageIcon, FileAudio, FileVideo, FileText } from 'lucide-react';
import { toast } from 'sonner';

type TextIntegrityWarning = {
  field: string;
  message: string;
  suspiciousSequenceCount: number;
  questionMarkRatio: number;
};

function parseIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function analyzeSuspiciousText(value: string, field: string): TextIntegrityWarning | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const suspiciousSequenceCount = (trimmed.match(/\?{3,}/g) || []).length;
  const questionMarkCount = (trimmed.match(/\?/g) || []).length;
  const questionMarkRatio = questionMarkCount / Math.max(trimmed.length, 1);
  const hasArabicOrPersianChars = /[\u0600-\u06FF]/.test(trimmed);

  if ((suspiciousSequenceCount === 0 && questionMarkRatio < 0.25) || hasArabicOrPersianChars) {
    return null;
  }

  return {
    field,
    message: `متن ${field === 'messageTemplate' ? 'پیام' : 'نام کمپین'} مشکوک به خرابی encoding است و ممکن است به صورت علامت سؤال ذخیره شود.`,
    suspiciousSequenceCount,
    questionMarkRatio: Number(questionMarkRatio.toFixed(3)),
  };
}

function collectClientTextWarnings(input: { name: string; messageTemplate: string }) {
  return [
    analyzeSuspiciousText(input.name, 'name'),
    analyzeSuspiciousText(input.messageTemplate, 'messageTemplate'),
  ].filter((warning): warning is TextIntegrityWarning => Boolean(warning));
}

function detectMediaKind(mediaPath: string) {
  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
    return { label: 'تصویر', icon: ImageIcon };
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
    return { label: 'ویدیو', icon: FileVideo };
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) {
    return { label: 'صوت / ویس', icon: FileAudio };
  }
  return { label: 'فایل / سند', icon: FileText };
}

export default function CampaignsPage() {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recipientType, setRecipientType] = useState<'contacts' | 'segment' | 'group'>('contacts');
  const [deleteConfirmDialog, setDeleteConfirmDialog] = useState<{ open: boolean; campaignId: string | null; campaignName: string }>({ open: false, campaignId: null, campaignName: '' });
  const [selectedMediaFile, setSelectedMediaFile] = useState<File | null>(null);
  const [expandedCampaignIds, setExpandedCampaignIds] = useState<string[]>([]);
  
  // Form state
  const [name, setName] = useState('');
  const [messageTemplate, setMessageTemplate] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState('');
  const [mediaPath, setMediaPath] = useState('');
  const [scheduleType, setScheduleType] = useState<'immediate' | 'scheduled'>('immediate');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [maxPerHour, setMaxPerHour] = useState('');
  const [maxPerDay, setMaxPerDay] = useState('');
  const [delayMin, setDelayMin] = useState('');
  const [delayMax, setDelayMax] = useState('');
  const [lastSaveWarnings, setLastSaveWarnings] = useState<TextIntegrityWarning[]>([]);

  // Pre-made templates
  const templates = [
    { id: 'greeting', label: 'سلام ساده', value: 'سلام {{name}}، چطور می‌تونم کمکتون کنم؟' },
    { id: 'promo', label: 'پیشنهاد ویژه', value: 'سلام {{name}}!\nما یک پیشنهاد ویژه برای شما داریم 🎉' },
    { id: 'reminder', label: 'یادآوری', value: 'سلام {{name}}, این یک یادآوری است که برای شما منتظر تصادی وجود دارد!' },
    { id: 'followup', label: 'پیگیری', value: 'سلام {{name}}, امیدوارم حالتون خوب باشه! برای جزئیات بیشتر با ما تماس بگیرید.' },
    { id: 'custom', label: 'دلخواه', value: '' }
  ];

  // Fetch campaigns
  const { data: campaigns, isLoading, isError, error } = useQuery({
    queryKey: ['campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error('Failed to fetch campaigns');
      return res.json();
    }
  });

  const { data: campaignStatuses = {} } = useQuery({
    queryKey: ['campaign-statuses', (campaigns || []).map((campaign: any) => campaign.id).join(',')],
    enabled: Array.isArray(campaigns) && campaigns.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        (campaigns || []).map(async (campaign: any) => {
          const res = await fetch(`/api/campaigns/${campaign.id}/status`);
          if (!res.ok) {
            throw new Error(`Failed to fetch status for ${campaign.name}`);
          }

          return [campaign.id, await res.json()] as const;
        })
      );

      return Object.fromEntries(entries);
    },
    refetchInterval: () => {
      const hasActiveCampaign = (campaigns || []).some((campaign: any) => {
        const liveStatus = (campaignStatuses as any)?.[campaign.id]?.status || campaign.status;
        return ['queued', 'in-progress', 'paused'].includes(liveStatus);
      });

      return hasActiveCampaign ? 3000 : 10000;
    }
  });

  // Fetch accounts for dropdown
  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json();
    }
  });
  const normalizedAccounts = Array.isArray(accounts) ? accounts : [];
  const accountMap = new Map(normalizedAccounts.map((account: any) => [account.id, account]));

  // Fetch contacts for selection
  const { data: contacts } = useQuery({
    queryKey: ['contacts'],
    queryFn: async () => {
      const res = await fetch('/api/contacts');
      if (!res.ok) throw new Error('Failed to fetch contacts');
      return res.json();
    }
  });

  // Fetch segments for selection
  const { data: segments } = useQuery({
    queryKey: ['contact-segments'],
    queryFn: async () => {
      const res = await fetch('/api/contacts/segments/by-tag');
      if (!res.ok) throw new Error('Failed to fetch segments');
      return res.json();
    }
  });

  // Add/Update campaign
  const saveMainMutation = useMutation({
    mutationFn: async (data: any) => {
      const url = editingId ? `/api/campaigns/${editingId}` : '/api/campaigns';
      const method = editingId ? 'PUT' : 'POST';
      const sanitizedAccountIds = normalizedAccounts.length > 0
        ? Array.from(new Set(selectedAccountIds.filter((accountId) => accountMap.has(accountId))))
        : Array.from(new Set(selectedAccountIds.filter(Boolean)));
      
      const scheduledAt = scheduleType === 'scheduled' && scheduledDate && scheduledTime 
        ? `${scheduledDate}T${scheduledTime}:00`
        : null;
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          messageTemplate: messageTemplate || selectedTemplate,
          mediaPath: mediaPath || null,
          accountIds: sanitizedAccountIds,
          contactIds: recipientType === 'contacts' ? selectedContactIds : [],
          segmentId: recipientType === 'segment' ? selectedSegmentId : null,
          scheduleType,
          scheduledAt,
          maxPerHour: maxPerHour ? parseInt(maxPerHour) : null,
          maxPerDay: maxPerDay ? parseInt(maxPerDay) : null,
          delayMinMs: delayMin ? parseInt(delayMin) : null,
          delayMaxMs: delayMax ? parseInt(delayMax) : null
        }),
      });
      
      const responseData = await res.json().catch(() => null);
      if (!res.ok) throw new Error(responseData?.error || 'Failed to save campaign');
      return responseData;
    },
    onSuccess: (data) => {
      const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
      setLastSaveWarnings(warnings);
      toast.success(editingId ? 'Campaign updated' : 'Campaign created');
      if (warnings.length > 0) {
        toast.warning('هشدار encoding برای متن کمپین شناسایی شد. قبل از اجرای نهایی متن را دوباره بررسی کنید.');
      }
      resetForm();
      setIsAddDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-statuses'] });
    },
    onError: (error) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  // Delete campaign
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete campaign');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Campaign deleted');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (error) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  // Execute campaign
  const executeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/execute/${id}`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Failed to execute campaign');
      return data;
    },
    onSuccess: (data) => {
      toast.success(data?.message || `Campaign queued for execution! Job ID: ${data.jobId}`);
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-statuses'] });
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  const pauseMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/${id}/pause`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to pause campaign');
      return data;
    },
    onSuccess: () => {
      toast.success('کمپین با موفقیت متوقف شد');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-statuses'] });
    },
    onError: (error: any) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  const resumeMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/campaigns/${id}/resume`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to resume campaign');
      return data;
    },
    onSuccess: () => {
      toast.success('کمپین دوباره در صف اجرا قرار گرفت');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-statuses'] });
    },
    onError: (error: any) => {
      toast.error(`خطا: ${error.message}`);
    }
  });

  const uploadMediaMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/uploads/campaign-media', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'آپلود فایل انجام نشد');
      }

      return data;
    },
    onSuccess: (data) => {
      setMediaPath(data.mediaPath || '');
      toast.success('فایل با موفقیت آپلود شد و به کمپین متصل شد');
    },
    onError: (error: any) => {
      toast.error(`خطا در آپلود: ${error.message}`);
    }
  });

  const resetForm = () => {
    setName('');
    setMessageTemplate('');
    setSelectedTemplate('');
    setSelectedAccountIds([]);
    setSelectedContactIds([]);
    setSelectedSegmentId('');
    setMediaPath('');
    setSelectedMediaFile(null);
    setRecipientType('contacts');
    setScheduleType('immediate');
    setScheduledDate('');
    setScheduledTime('');
    setMaxPerHour('');
    setMaxPerDay('');
    setDelayMin('');
    setDelayMax('');
    setEditingId(null);
    setLastSaveWarnings([]);
  };

  const handleEdit = (campaign: any) => {
    const parsedAccountIds = parseIdList(campaign.accountIds);
    const sanitizedAccountIds = normalizedAccounts.length > 0
      ? parsedAccountIds.filter((accountId) => accountMap.has(accountId))
      : parsedAccountIds;
    const missingAccountIds = normalizedAccounts.length > 0
      ? parsedAccountIds.filter((accountId) => !accountMap.has(accountId))
      : [];

    setEditingId(campaign.id);
    setName(campaign.name);
    setMessageTemplate(campaign.messageTemplate);
    setSelectedAccountIds(sanitizedAccountIds);
    setSelectedContactIds(JSON.parse(campaign.contactIds || '[]'));
    setSelectedSegmentId(campaign.segmentId || '');
    setMediaPath(campaign.mediaPath || '');
    setSelectedMediaFile(null);
    setRecipientType(campaign.segmentId ? 'segment' : 'contacts');
    setScheduleType(campaign.scheduleType || 'immediate');
    if (campaign.scheduledAt) {
      const date = new Date(campaign.scheduledAt);
      setScheduledDate(date.toISOString().split('T')[0]);
      setScheduledTime(date.toTimeString().slice(0, 5));
    }
    setMaxPerHour(campaign.maxPerHour?.toString() || '');
    setMaxPerDay(campaign.maxPerDay?.toString() || '');
    setDelayMin(campaign.delayMinMs?.toString() || '');
    setDelayMax(campaign.delayMaxMs?.toString() || '');
    if (missingAccountIds.length > 0) {
      toast.warning(`اکانت‌های حذف‌شده از فرم این کمپین کنار گذاشته شدند: ${missingAccountIds.join(', ')}`);
    }
    setIsAddDialogOpen(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const finalMessage = messageTemplate || selectedTemplate;
    const sanitizedAccountIds = normalizedAccounts.length > 0
      ? Array.from(new Set(selectedAccountIds.filter((accountId) => accountMap.has(accountId))))
      : Array.from(new Set(selectedAccountIds.filter(Boolean)));
    const hasRecipients = recipientType === 'contacts' 
      ? selectedContactIds.length > 0 
      : selectedSegmentId;
    
    if (!name || sanitizedAccountIds.length === 0 || !hasRecipients) {
      toast.error('لطفاً تمام فیلدهای الزامی را پر کنید');
      return;
    }

    if (sanitizedAccountIds.length !== Array.from(new Set(selectedAccountIds.filter(Boolean))).length) {
      setSelectedAccountIds(sanitizedAccountIds);
      toast.error('بعضی از اکانت‌های انتخاب‌شده دیگر وجود ندارند. قبل از ذخیره فقط اکانت‌های معتبر نگه داشته شدند.');
      return;
    }

    if (!finalMessage && !mediaPath) {
      toast.error('برای کمپین باید متن پیام یا مسیر فایل مدیا را وارد کنید');
      return;
    }
    
    if (scheduleType === 'scheduled' && (!scheduledDate || !scheduledTime)) {
      toast.error('لطفاً تاریخ و زمان را برای کمپین زمان‌بندی شده وارد کنید');
      return;
    }
    
    saveMainMutation.mutate(null);
  };

  const handleDialogChange = (open: boolean) => {
    setIsAddDialogOpen(open);
    if (!open) resetForm();
  };

  const handleUploadSelectedMedia = async () => {
    if (!selectedMediaFile) {
      toast.error('ابتدا یک فایل انتخاب کنید');
      return;
    }

    await uploadMediaMutation.mutateAsync(selectedMediaFile);
  };

  const mediaKind = mediaPath ? detectMediaKind(mediaPath) : null;
  const MediaKindIcon = mediaKind?.icon;
  const clientTextWarnings = collectClientTextWarnings({
    name,
    messageTemplate: messageTemplate || selectedTemplate,
  });
  const normalizedCampaigns = Array.isArray(campaigns) ? campaigns : [];

  const toggleExpanded = (campaignId: string) => {
    setExpandedCampaignIds((current) => current.includes(campaignId)
      ? current.filter((id) => id !== campaignId)
      : [...current, campaignId]);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-[#F1F5F9]">Campaigns</h2>
          <p className="text-[#94A3B8] mt-1">Create and manage bulk messaging campaigns.</p>
        </div>
        
        <Dialog open={isAddDialogOpen} onOpenChange={handleDialogChange}>
          <DialogTrigger asChild>
            <Button className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white">
              <Plus className="w-4 h-4 mr-2" />
              New Campaign
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-[#1A1A2E] border-white/10 text-[#F1F5F9] sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingId ? 'ویرایش کمپین' : 'ایجاد کمپین جدید'}</DialogTitle>
            </DialogHeader>
            
            <form onSubmit={handleSave} className="space-y-4 mt-4">
              {/* نام کمپین */}
              <div className="space-y-2">
                <Label htmlFor="campaignName">نام کمپین *</Label>
                <Input 
                  id="campaignName" 
                  placeholder="مثال: فروش تابستانی 1405" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-[#0F0F1A] border-white/10"
                  required
                />
              </div>

              {/* الگوهای پیام */}
              <div className="space-y-2">
                <Label>الگوی پیام *</Label>
                <select 
                  value={selectedTemplate}
                  onChange={(e) => {
                    const template = templates.find(t => t.id === e.target.value);
                    if (template) {
                      setSelectedTemplate(template.value);
                      setMessageTemplate('');
                    }
                  }}
                  className="w-full bg-[#0F0F1A] border border-white/10 rounded-md px-3 py-2 text-[#F1F5F9] focus:border-[#7C3AED] focus:outline-none"
                >
                  <option value="">انتخاب الگوی پی‌فرض...</option>
                  {templates.map(template => (
                    <option key={template.id} value={template.value}>{template.label}</option>
                  ))}
                </select>
              </div>

              {/* متن پیام دلخواه */}
              <div className="space-y-2">
                <Label htmlFor="messageTemplate">متن پیام</Label>
                <textarea 
                  id="messageTemplate"
                  placeholder="سلام {{name}}، این یک پیام تجربی است..." 
                  value={messageTemplate || selectedTemplate}
                  onChange={(e) => setMessageTemplate(e.target.value)}
                  rows={4}
                  className="w-full bg-[#0F0F1A] border border-white/10 rounded-md px-3 py-2 text-[#F1F5F9] placeholder:text-[#94A3B8] focus:border-[#7C3AED] focus:outline-none"
                />
                <p className="text-xs text-[#94A3B8]">استفاده کنید از {`{{name}}`} برای نام، {`{{phone}}`} برای شماره</p>
              </div>

              {(clientTextWarnings.length > 0 || lastSaveWarnings.length > 0) && (
                <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <div className="text-sm font-medium text-amber-300">هشدار سلامت متن</div>
                  <div className="space-y-1 text-xs text-amber-100">
                    {[...clientTextWarnings, ...lastSaveWarnings].map((warning, index) => (
                      <div key={`${warning.field}-${index}`}>
                        • {warning.message}
                      </div>
                    ))}
                  </div>
                  <div className="text-[11px] text-amber-200/80">
                    اگر متن را از ترمینال یا اسکریپت وارد می‌کنید، مسیر UTF-8-safe را استفاده کنید تا فارسی به `????` تبدیل نشود.
                  </div>
                </div>
              )}

              {/* مسیر فایل مدیا */}
              <div className="space-y-2">
                <Label htmlFor="mediaPath">مسیر فایل مدیا (اختیاری)</Label>
                <Input
                  id="mediaPath"
                  placeholder="مثال: uploads/campaigns/spring-offer.jpg یا C:\\media\\promo.mp4"
                  value={mediaPath}
                  onChange={(e) => setMediaPath(e.target.value)}
                  className="bg-[#0F0F1A] border-white/10"
                />
                <p className="text-xs text-[#94A3B8]">
                  اگر این فیلد را پر کنید، متن پیام به عنوان کپشن مدیا استفاده می‌شود. این مرحله فقط مسیر فایل موجود را ثبت می‌کند.
                </p>
                <div className="rounded-md border border-white/10 bg-[#0F0F1A] p-3 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="campaignMediaUpload">آپلود فایل برای همین کمپین</Label>
                    <Input
                      id="campaignMediaUpload"
                      type="file"
                      onChange={(e) => setSelectedMediaFile(e.target.files?.[0] || null)}
                      className="bg-[#0F0F1A] border-white/10 file:mr-3 file:rounded file:border-0 file:bg-[#7C3AED] file:px-3 file:py-1 file:text-white"
                    />
                    <p className="text-xs text-[#94A3B8]">
                      فرمت‌های مجاز: تصویر، ویدیو، صوت، PDF، Office، ZIP تا سقف 25MB
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      onClick={handleUploadSelectedMedia}
                      disabled={!selectedMediaFile || uploadMediaMutation.isPending}
                      className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                    >
                      {uploadMediaMutation.isPending ? 'در حال آپلود...' : 'آپلود و اتصال به کمپین'}
                    </Button>
                    {selectedMediaFile && (
                      <span className="text-xs text-[#94A3B8]">
                        فایل انتخاب‌شده: {selectedMediaFile.name}
                      </span>
                    )}
                  </div>
                </div>
                {mediaKind && MediaKindIcon && (
                  <div className="flex items-center gap-2 rounded-md border border-white/10 bg-[#0F0F1A] px-3 py-2 text-sm text-[#F1F5F9]">
                    <MediaKindIcon className="w-4 h-4 text-[#7C3AED]" />
                    <span>نوع شناسایی‌شده: {mediaKind.label}</span>
                  </div>
                )}
              </div>

              {/* انتخاب حسابها */}
              <div className="space-y-2">
                <Label>انتخاب حساب‌های واتس‌اپ *</Label>
                <div className="bg-[#0F0F1A] border border-white/10 rounded-md p-3 max-h-24 overflow-y-auto">
                  {accounts?.map((account: any) => (
                    <label key={account.id} className="flex items-center space-x-2 p-2 hover:bg-white/5 rounded cursor-pointer">
                      <input 
                        type="checkbox"
                        checked={selectedAccountIds.includes(account.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedAccountIds([...selectedAccountIds, account.id]);
                          } else {
                            setSelectedAccountIds(selectedAccountIds.filter(id => id !== account.id));
                          }
                        }}
                        className="rounded border-white/30 bg-gray-700 w-4 h-4 accent-[#7C3AED]"
                      />
                      <span className="text-sm">
                        {account.displayName}
                        <span className={`ml-2 text-xs ${account.status === 'connected' ? 'text-emerald-300' : 'text-amber-300'}`}>
                          {account.status === 'connected' ? 'connected' : account.status || 'unknown'}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* انتخاب مخاطبین */}
              <div className="space-y-2">
                <Label>نوع مخاطبین *</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRecipientType('contacts')}
                    className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      recipientType === 'contacts'
                        ? 'bg-[#7C3AED] text-white'
                        : 'bg-[#0F0F1A] border border-white/10 text-[#94A3B8] hover:bg-white/5'
                    }`}
                  >
                    مخاطبین
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecipientType('segment')}
                    className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      recipientType === 'segment'
                        ? 'bg-[#7C3AED] text-white'
                        : 'bg-[#0F0F1A] border border-white/10 text-[#94A3B8] hover:bg-white/5'
                    }`}
                  >
                    بخش‌بندی
                  </button>
                  <button
                    type="button"
                    onClick={() => setRecipientType('group')}
                    className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      recipientType === 'group'
                        ? 'bg-[#7C3AED] text-white'
                        : 'bg-[#0F0F1A] border border-white/10 text-[#94A3B8] hover:bg-white/5'
                    }`}
                    disabled
                  >
                    گروه‌ها
                  </button>
                </div>
              </div>

              {/* انتخاب تفصیلی */}
              {recipientType === 'contacts' && (
                <div className="space-y-2">
                  <Label>انتخاب مخاطبین *</Label>
                  <div className="bg-[#0F0F1A] border border-white/10 rounded-md p-3 max-h-24 overflow-y-auto">
                    {contacts?.length ? contacts.map((contact: any) => (
                      <label key={contact.id} className="flex items-center space-x-2 p-2 hover:bg-white/5 rounded cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={selectedContactIds.includes(contact.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedContactIds([...selectedContactIds, contact.id]);
                            } else {
                              setSelectedContactIds(selectedContactIds.filter(id => id !== contact.id));
                            }
                          }}
                          className="rounded border-white/30 bg-gray-700 w-4 h-4 accent-[#7C3AED]"
                        />
                        <span className="text-sm">{contact.fullName || contact.phone}</span>
                      </label>
                    )) : (
                      <p className="text-sm text-[#94A3B8]">مخاطبی یافت نشد. ابتدا مخاطبین اضافه کنید.</p>
                    )}
                  </div>
                </div>
              )}

              {recipientType === 'segment' && (
                <div className="space-y-2">
                  <Label>انتخاب بخش‌بندی *</Label>
                  <select 
                    value={selectedSegmentId}
                    onChange={(e) => setSelectedSegmentId(e.target.value)}
                    className="w-full bg-[#0F0F1A] border border-white/10 rounded-md px-3 py-2 text-[#F1F5F9] focus:border-[#7C3AED] focus:outline-none"
                  >
                    <option value="">انتخاب بخش...</option>
                    {segments?.map((segment: any) => (
                      <option key={segment.segment} value={segment.segment}>
                        {segment.segment} ({segment.count} مخاطب)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* زمان‌بندی */}
              <div className="space-y-2">
                <Label>زمان‌بندی</Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setScheduleType('immediate')}
                    className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      scheduleType === 'immediate'
                        ? 'bg-[#10B981] text-white'
                        : 'bg-[#0F0F1A] border border-white/10 text-[#94A3B8] hover:bg-white/5'
                    }`}
                  >
                    فوری
                  </button>
                  <button
                    type="button"
                    onClick={() => setScheduleType('scheduled')}
                    className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      scheduleType === 'scheduled'
                        ? 'bg-[#F59E0B] text-white'
                        : 'bg-[#0F0F1A] border border-white/10 text-[#94A3B8] hover:bg-white/5'
                    }`}
                  >
                    زمان‌بندی شده
                  </button>
                </div>
              </div>

              {scheduleType === 'scheduled' && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="scheduledDate" className="text-xs">تاریخ *</Label>
                    <Input 
                      id="scheduledDate"
                      type="date" 
                      value={scheduledDate}
                      onChange={(e) => setScheduledDate(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10 text-sm"
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="scheduledTime" className="text-xs">زمان *</Label>
                    <Input 
                      id="scheduledTime"
                      type="time" 
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10 text-sm"
                      required
                    />
                  </div>
                </div>
              )}

              {/* محدودیت نرخ */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="maxPerHour" className="text-xs">حداکثر/ساعت</Label>
                  <Input 
                    id="maxPerHour"
                    type="number" 
                    placeholder="مثال: 50"
                    value={maxPerHour}
                    onChange={(e) => setMaxPerHour(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10 text-sm"
                    min="0"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="maxPerDay" className="text-xs">حداکثر/روز</Label>
                  <Input 
                    id="maxPerDay"
                    type="number" 
                    placeholder="مثال: 500"
                    value={maxPerDay}
                    onChange={(e) => setMaxPerDay(e.target.value)}
                    className="bg-[#0F0F1A] border-white/10 text-sm"
                    min="0"
                  />
                </div>
              </div>

              {/* تأخیر بین پیام‌ها */}
              <div className="space-y-2">
                <Label className="text-xs">تأخیر بین پیام‌ها (میلی‌ثانیه)</Label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <span className="text-xs text-[#94A3B8]">حداقل</span>
                    <Input 
                      type="number" 
                      placeholder="مثال: 1000"
                      value={delayMin}
                      onChange={(e) => setDelayMin(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10 text-sm"
                      min="0"
                    />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs text-[#94A3B8]">حداکثر</span>
                    <Input 
                      type="number" 
                      placeholder="مثال: 5000"
                      value={delayMax}
                      onChange={(e) => setDelayMax(e.target.value)}
                      className="bg-[#0F0F1A] border-white/10 text-sm"
                      min="0"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 flex justify-end space-x-2 border-t border-white/10">
                <Button 
                  type="button"
                  variant="outline"
                  className="border-white/10"
                  onClick={() => setIsAddDialogOpen(false)}
                >
                  انصراف
                </Button>
                <Button 
                  type="submit" 
                  className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                  disabled={saveMainMutation.isPending}
                >
                  {saveMainMutation.isPending ? 'درحال ذخیره...' : 'ذخیره کمپین'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="bg-[#1A1A2E]/50 border-white/10 shadow-xl">
        <CardHeader className="border-b border-white/5 pb-4">
          <CardTitle className="text-[#F1F5F9]">Active Campaigns</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <RefreshCw className="w-8 h-8 text-[#7C3AED] animate-spin mb-4" />
              <p className="text-[#94A3B8]">Loading campaigns...</p>
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Megaphone className="w-12 h-12 text-red-400 opacity-60 mb-4" />
              <p className="text-[#F1F5F9] font-medium text-lg">Campaigns failed to load</p>
              <p className="text-[#94A3B8] mt-1 max-w-xl px-4">
                {(error as Error)?.message || 'An unexpected error occurred while loading campaigns.'}
              </p>
            </div>
          ) : normalizedCampaigns.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Megaphone className="w-12 h-12 text-[#94A3B8] opacity-20 mb-4" />
              <p className="text-[#F1F5F9] font-medium text-lg">No campaigns yet</p>
              <p className="text-[#94A3B8] mt-1">Create your first campaign to start bulk messaging</p>
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-[#1A1A2E]/95 backdrop-blur-sm">
                  <tr className="border-b border-white/10 text-[#94A3B8] text-sm bg-black/20">
                    <th className="p-4 font-medium">Name</th>
                    <th className="p-4 font-medium">Accounts</th>
                    <th className="p-4 font-medium">Contacts</th>
                    <th className="p-4 font-medium">Status</th>
                    <th className="p-4 font-medium">Created</th>
                    <th className="p-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {normalizedCampaigns.map((campaign: any) => {
                    const campaignAccountIds = parseIdList(campaign.accountIds);
                    const missingAccountIds = normalizedAccounts.length > 0
                      ? campaignAccountIds.filter((accountId) => !accountMap.has(accountId))
                      : [];
                    const disconnectedAccounts = normalizedAccounts.length > 0
                      ? campaignAccountIds
                        .map((accountId) => accountMap.get(accountId))
                        .filter((account: any) => Boolean(account) && account.status !== 'connected')
                      : [];
                    const accountCount = campaignAccountIds.length;
                    const contactCount = parseIdList(campaign.contactIds).length;
                    const liveStatus = (campaignStatuses as any)?.[campaign.id] || null;
                    const statusLabel = liveStatus?.status || campaign.status || 'draft';
                    const isExpanded = expandedCampaignIds.includes(campaign.id) || ['queued', 'in-progress', 'paused'].includes(statusLabel);
                    const progressPercent = liveStatus?.progressPercent || 0;
                    const textIntegrityEvent = liveStatus?.recentEvents?.find((event: any) => event.eventType === 'text-integrity-warning');
                    const hasAccountIssues = missingAccountIds.length > 0 || disconnectedAccounts.length > 0;
                    const statusTone = statusLabel === 'draft'
                      ? 'bg-[#94A3B8]/20 text-[#94A3B8]'
                      : statusLabel === 'scheduled'
                      ? 'bg-[#F59E0B]/20 text-[#F59E0B]'
                      : statusLabel === 'queued'
                      ? 'bg-sky-500/20 text-sky-400'
                      : statusLabel === 'paused'
                      ? 'bg-amber-500/20 text-amber-400'
                      : statusLabel === 'failed'
                      ? 'bg-red-500/20 text-red-400'
                      : 'bg-[#10B981]/20 text-[#10B981]';
                    
                    return (
                      <Fragment key={campaign.id}>
                        <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
                          <td className="p-4">
                            <div className="flex flex-col gap-1">
                              <span className="font-medium text-[#F1F5F9]">{campaign.name}</span>
                              {campaign.mediaPath && (
                                <span className="text-xs text-[#94A3B8]">مدیا متصل: {campaign.mediaPath}</span>
                              )}
                              {textIntegrityEvent && (
                                <span className="text-xs text-amber-300">
                                  هشدار متن: این کمپین احتمال خرابی encoding دارد
                                </span>
                              )}
                              {missingAccountIds.length > 0 && (
                                <span className="text-xs text-red-300">
                                  اکانت حذف‌شده در کمپین: {missingAccountIds.join(', ')}
                                </span>
                              )}
                              {disconnectedAccounts.length > 0 && (
                                <span className="text-xs text-amber-300">
                                  اکانت غیرفعال برای اجرا: {disconnectedAccounts.map((account: any) => account.displayName || account.phoneNumber || account.id).join(', ')}
                                </span>
                              )}
                              {liveStatus && (
                                <span className="text-xs text-[#7DD3FC]">
                                  پیشرفت زنده: {liveStatus.sentCount || 0} ارسال موفق / {liveStatus.failedCount || 0} ناموفق / {liveStatus.pendingCount || 0} در انتظار
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-sm text-[#94A3B8]">{accountCount}</td>
                          <td className="p-4 text-sm text-[#94A3B8]">{contactCount}</td>
                          <td className="p-4">
                            <div className="flex flex-col gap-2">
                              <span className={`px-2 py-1 rounded-full text-xs font-medium w-fit ${statusTone}`}>
                                {statusLabel}
                              </span>
                              {liveStatus && liveStatus.totalRecipients > 0 && (
                                <span className="text-xs text-[#94A3B8]">
                                  {progressPercent}% از {liveStatus.totalRecipients} گیرنده
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-xs text-[#94A3B8]">
                            {new Date(campaign.createdAt).toLocaleDateString()}
                          </td>
                          <td className="p-4 text-right space-x-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-[#94A3B8] hover:text-[#F1F5F9] hover:bg-white/10"
                              onClick={() => toggleExpanded(campaign.id)}
                            >
                              مانیتور
                            </Button>
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-8 w-8 p-0 text-green-400 hover:text-green-300 hover:bg-green-400/10"
                              title="Execute campaign"
                              onClick={() => {
                                if (confirm('Execute this campaign now?')) {
                                  executeMutation.mutate(campaign.id);
                                }
                              }}
                              disabled={executeMutation.isPending || !['draft', 'failed'].includes(statusLabel) || hasAccountIssues}
                            >
                              <Play className="w-4 h-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-amber-400 hover:text-amber-300 hover:bg-amber-400/10"
                              onClick={() => pauseMutation.mutate(campaign.id)}
                              disabled={pauseMutation.isPending || !['queued', 'in-progress'].includes(statusLabel)}
                              title="Pause campaign"
                            >
                              <Pause className="w-4 h-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-sky-400 hover:text-sky-300 hover:bg-sky-400/10"
                              onClick={() => resumeMutation.mutate(campaign.id)}
                              disabled={resumeMutation.isPending || statusLabel !== 'paused'}
                              title="Resume campaign"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </Button>
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-8 w-8 p-0 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"
                              onClick={() => handleEdit(campaign)}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button 
                              size="sm" 
                              variant="ghost" 
                              className="h-8 w-8 p-0 text-red-400 hover:text-red-300 hover:bg-red-400/10"
                              onClick={() => {
                                setDeleteConfirmDialog({
                                  open: true,
                                  campaignId: campaign.id,
                                  campaignName: campaign.name
                                });
                              }}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                        {isExpanded && liveStatus && (
                          <tr className="border-b border-white/5 bg-black/10">
                            <td colSpan={6} className="p-4">
                              <div className="space-y-4 rounded-lg border border-white/10 bg-[#0F0F1A]/80 p-4">
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                                    <span>پیشرفت اجرای زنده</span>
                                    <span>{progressPercent}%</span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                                    <div className="h-full rounded-full bg-[#7C3AED] transition-all" style={{ width: `${progressPercent}%` }} />
                                  </div>
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                                    <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[#F1F5F9]">کل گیرنده‌ها: {liveStatus.totalRecipients || 0}</div>
                                    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-emerald-300">ارسال موفق: {liveStatus.sentCount || 0}</div>
                                    <div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-red-300">ناموفق: {liveStatus.failedCount || 0}</div>
                                    <div className="rounded-md border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-sky-300">در انتظار: {liveStatus.pendingCount || 0}</div>
                                  </div>
                                  {liveStatus.queue && (
                                    <div className="text-xs text-[#94A3B8]">
                                      وضعیت صف: {liveStatus.queue.status} | تلاش‌ها: {liveStatus.queue.attempts}/{liveStatus.queue.maxAttempts}
                                      {liveStatus.queue.errorMessage ? ` | خطا: ${liveStatus.queue.errorMessage}` : ''}
                                    </div>
                                  )}
                                </div>

                                <div className="grid gap-3 lg:grid-cols-2">
                                  <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-[#F1F5F9]">آمار هر اکانت</h4>
                                    {liveStatus.accountBreakdown?.length ? liveStatus.accountBreakdown.map((account: any) => (
                                      <div key={account.accountId} className="rounded-md border border-white/10 bg-white/5 p-3 text-xs text-[#CBD5E1]">
                                        <div className="flex items-center justify-between gap-3">
                                          <div>
                                            <div className="font-medium text-[#F1F5F9]">{account.displayName}</div>
                                            <div className="text-[#94A3B8]">{account.phoneNumber || account.accountId}</div>
                                          </div>
                                          <span className="rounded-full bg-white/10 px-2 py-1 text-[11px] text-[#F1F5F9]">
                                            {account.connectionStatus}
                                          </span>
                                        </div>
                                        <div className="mt-3 grid grid-cols-2 gap-2">
                                          <div>موفق: <span className="text-emerald-300">{account.sentCount}</span></div>
                                          <div>ناموفق: <span className="text-red-300">{account.failedCount}</span></div>
                                          <div>کل تلاش: {account.attemptedCount}</div>
                                          <div>مصرف امروز: {account.dayUsage}</div>
                                          <div>مصرف این ساعت: {account.hourUsage}</div>
                                          <div>سقف کمپین: {account.maxPerDay || '∞'} / روز</div>
                                        </div>
                                        {account.warmUp && (
                                          <div className="mt-2 rounded bg-amber-500/10 px-2 py-1 text-amber-300">
                                            Warm-Up: روز {account.warmUp.currentDay} | سقف روزانه {account.warmUp.dailyLimit}
                                          </div>
                                        )}
                                        {account.lastEvent?.message && (
                                          <div className="mt-2 text-[#94A3B8]">آخرین رویداد: {account.lastEvent.message}</div>
                                        )}
                                      </div>
                                    )) : (
                                      <div className="rounded-md border border-dashed border-white/10 px-3 py-4 text-xs text-[#94A3B8]">
                                        هنوز داده‌ای برای تفکیک اکانت ثبت نشده است.
                                      </div>
                                    )}
                                  </div>

                                  <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-[#F1F5F9]">لاگ زنده کمپین</h4>
                                    {liveStatus.recentEvents?.length ? (
                                      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                        {liveStatus.recentEvents.slice(0, 12).map((event: any) => (
                                          <div key={event.id} className="rounded-md border border-white/10 bg-white/5 p-3 text-xs text-[#CBD5E1]">
                                            <div className="flex items-center justify-between gap-3">
                                              <span className={`rounded-full px-2 py-1 text-[11px] ${
                                                event.level === 'error'
                                                  ? 'bg-red-500/20 text-red-300'
                                                  : event.level === 'warn'
                                                  ? 'bg-amber-500/20 text-amber-300'
                                                  : event.level === 'success'
                                                  ? 'bg-emerald-500/20 text-emerald-300'
                                                  : 'bg-sky-500/20 text-sky-300'
                                              }`}>
                                                {event.eventType}
                                              </span>
                                              <span className="text-[#94A3B8]">{event.createdAt ? new Date(event.createdAt).toLocaleString('fa-IR') : '-'}</span>
                                            </div>
                                            <div className="mt-2 text-[#F1F5F9]">{event.message}</div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="rounded-md border border-dashed border-white/10 px-3 py-4 text-xs text-[#94A3B8]">
                                        هنوز لاگی برای این کمپین ثبت نشده است.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteConfirmDialog.open} onOpenChange={(open) => setDeleteConfirmDialog({ ...deleteConfirmDialog, open })}>
        <AlertDialogContent className="bg-[#1A1A2E] border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#F1F5F9]">Delete Campaign</AlertDialogTitle>
            <AlertDialogDescription className="text-[#94A3B8]">
              Are you sure you want to delete <strong>{deleteConfirmDialog.campaignName}</strong>?
              <br />
              <span className="text-[#EF4444] text-sm mt-2 block">This action cannot be undone!</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-3 justify-end">
            <AlertDialogCancel className="bg-[#0F0F1A] border-white/10 text-[#F1F5F9] hover:bg-[#0F0F1A]/80">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction 
              onClick={() => {
                if (deleteConfirmDialog.campaignId) {
                  deleteMutation.mutate(deleteConfirmDialog.campaignId);
                }
                setDeleteConfirmDialog({ open: false, campaignId: null, campaignName: '' });
              }}
              className="bg-[#EF4444] hover:bg-[#DC2626]"
            >
              Delete
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
