'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, Trash2, Edit, Zap, RefreshCw, Paperclip, ImageIcon, FileVideo, FileAudio, FileText } from 'lucide-react';
import { toast } from 'sonner';

function detectAutoReplyMediaKind(mediaPath: string) {
  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return { label: 'تصویر', icon: ImageIcon, mediaType: 'image' };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return { label: 'ویدیو', icon: FileVideo, mediaType: 'video' };
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) return { label: 'صوت / ویس', icon: FileAudio, mediaType: 'audio' };
  return { label: 'فایل / سند', icon: FileText, mediaType: 'document' };
}

export default function AutoReplyPage() {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'rules' | 'logs'>('rules');
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; ruleId: string | null; ruleName: string }>({ open: false, ruleId: null, ruleName: '' });
  
  // Form state
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [triggerType, setTriggerType] = useState<'keyword' | 'regex' | 'all'>('keyword');
  const [triggerValue, setTriggerValue] = useState('');
  const [activeHourStart, setActiveHourStart] = useState('09');
  const [activeHourEnd, setActiveHourEnd] = useState('18');
  const [aiProvider, setAiProvider] = useState('openai');
  const [aiModel, setAiModel] = useState('gpt-3.5-turbo');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedMediaFile, setSelectedMediaFile] = useState<File | null>(null);
  const [mediaPath, setMediaPath] = useState('');
  const [mediaFileName, setMediaFileName] = useState('');
  const [mediaMimeType, setMediaMimeType] = useState('');
  const [sendAsVoiceNote, setSendAsVoiceNote] = useState(false);
  const [delayMin, setDelayMin] = useState('3');
  const [delayMax, setDelayMax] = useState('8');
  const [isEnabled, setIsEnabled] = useState(true);

  // Fetch auto-reply rules
  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['auto-reply-rules'],
    queryFn: async () => {
      const res = await fetch('/api/auto-reply/rules');
      if (!res.ok) throw new Error('Failed to fetch rules');
      return res.json();
    }
  });

  // Fetch auto-reply logs
  const { data: logs = [] } = useQuery({
    queryKey: ['auto-reply-logs'],
    queryFn: async () => {
      const res = await fetch('/api/auto-reply/logs');
      if (!res.ok) throw new Error('Failed to fetch logs');
      return res.json();
    }
  });

  // Fetch accounts
  const { data: accounts = [] } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json();
    }
  });

  // Save rule
  const saveRuleMutation = useMutation({
    mutationFn: async () => {
      const detectedMedia = mediaPath ? detectAutoReplyMediaKind(mediaPath) : null;
      const res = await fetch('/api/auto-reply/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          triggerType,
          triggerValue: triggerType === 'all' ? 'all' : triggerValue,
          activeHourStart: parseInt(activeHourStart),
          activeHourEnd: parseInt(activeHourEnd),
          aiProvider,
          aiModel,
          systemPrompt,
          mediaPath: mediaPath || null,
          mediaType: detectedMedia?.mediaType || null,
          mediaMimeType: mediaMimeType || null,
          mediaFileName: mediaFileName || null,
          sendAsVoiceNote,
          delayMin: parseInt(delayMin),
          delayMax: parseInt(delayMax),
          isEnabled
        })
      });
      if (!res.ok) throw new Error('Failed to save rule');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auto-reply-rules'] });
      toast.success('قانون خودکار ذخیره شد ✅');
      resetForm();
      setIsAddDialogOpen(false);
    },
    onError: () => {
      toast.error('خطا در ذخیره قانون');
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
      if (!res.ok) throw new Error(data?.error || 'Failed to upload media');
      return data;
    },
    onSuccess: (data) => {
      setMediaPath(data.mediaPath || '');
      setMediaFileName(data.originalName || data.fileName || '');
      setMediaMimeType(data.mimeType || '');
      toast.success('فایل برای پاسخ خودکار آپلود شد');
    },
    onError: (error: any) => {
      toast.error(`خطا در آپلود فایل: ${error.message}`);
    }
  });

  // Delete rule
  const deleteRuleMutation = useMutation({
    mutationFn: async (ruleId: string) => {
      const res = await fetch(`/api/auto-reply/rules/${ruleId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete rule');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auto-reply-rules'] });
      toast.success('قانون حذف شد');
      setDeleteDialog({ open: false, ruleId: null, ruleName: '' });
    },
    onError: () => {
      toast.error('خطا در حذف قانون');
    }
  });

  // Toggle rule
  const toggleRuleMutation = useMutation({
    mutationFn: async (data: { ruleId: string; isEnabled: boolean }) => {
      const res = await fetch(`/api/auto-reply/rules/${data.ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: data.isEnabled })
      });
      if (!res.ok) throw new Error('Failed to toggle rule');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auto-reply-rules'] });
      toast.success('وضعیت به‌روزشد');
    }
  });

  const resetForm = () => {
    setSelectedAccountId('');
    setTriggerType('keyword');
    setTriggerValue('');
    setActiveHourStart('09');
    setActiveHourEnd('18');
    setAiProvider('openai');
    setAiModel('gpt-3.5-turbo');
    setSystemPrompt('');
    setSelectedMediaFile(null);
    setMediaPath('');
    setMediaFileName('');
    setMediaMimeType('');
    setSendAsVoiceNote(false);
    setDelayMin('3');
    setDelayMax('8');
    setIsEnabled(true);
  };

  const aiProviders = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'gemini', label: 'Google Gemini' },
    { value: 'claude', label: 'Anthropic Claude' }
  ];

  const modelsByProvider: Record<string, string[]> = {
    openai: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4-turbo'],
    gemini: ['gemini-pro', 'gemini-ultra'],
    claude: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku']
  };

  const selectedMediaInfo = mediaPath ? detectAutoReplyMediaKind(mediaPath) : null;
  const SelectedMediaIcon = selectedMediaInfo?.icon;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Zap className="w-8 h-8 text-blue-600" />
          قوانین پاسخ خودکار
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          تنظیم قوانین پاسخ‌های خودکار هوشمند برای پیام‌های دریافتی
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700 mb-6">
        <button
          onClick={() => setActiveTab('rules')}
          className={`px-4 py-2 font-medium border-b-2 transition ${
            activeTab === 'rules'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-300'
          }`}
        >
          قوانین
        </button>
        <button
          onClick={() => setActiveTab('logs')}
          className={`px-4 py-2 font-medium border-b-2 transition ${
            activeTab === 'logs'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-300'
          }`}
        >
          لاگ‌های پاسخ
        </button>
      </div>

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <div className="space-y-6">
          {/* Add Rule Button */}
          <div className="flex justify-end">
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-blue-600 hover:bg-blue-700 text-white">
                  <Plus className="w-4 h-4 mr-2" />
                  قانون جدید
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>افزودن قانون پاسخ خودکار</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  {/* Account Selection */}
                  <div>
                    <Label>اکانت واتساپ</Label>
                    <select
                      value={selectedAccountId}
                      onChange={(e) => setSelectedAccountId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    >
                      <option value="">انتخاب اکانت</option>
                      {accounts.map((acc: any) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.phone_number} - {acc.display_name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Trigger Type */}
                  <div>
                    <Label>نوع Trigger</Label>
                    <select
                      value={triggerType}
                      onChange={(e) => setTriggerType(e.target.value as 'keyword' | 'regex' | 'all')}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    >
                      <option value="keyword">کلمه کلیدی</option>
                      <option value="regex">عبارت منظم</option>
                      <option value="all">تمام پیام‌ها</option>
                    </select>
                  </div>

                  {/* Trigger Value */}
                  {triggerType !== 'all' && (
                    <div>
                      <Label>{triggerType === 'keyword' ? 'کلمه کلیدی' : 'عبارت منظم'}</Label>
                      <Input
                        value={triggerValue}
                        onChange={(e) => setTriggerValue(e.target.value)}
                        placeholder={triggerType === 'keyword' ? 'مثل: سلام' : 'مثل: /^hello.*/i'}
                      />
                    </div>
                  )}

                  {/* Active Hours */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>ساعت شروع</Label>
                      <Input
                        type="number"
                        min="0"
                        max="23"
                        value={activeHourStart}
                        onChange={(e) => setActiveHourStart(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>ساعت پایان</Label>
                      <Input
                        type="number"
                        min="0"
                        max="23"
                        value={activeHourEnd}
                        onChange={(e) => setActiveHourEnd(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* AI Provider */}
                  <div>
                    <Label>تامین‌کننده AI</Label>
                    <select
                      value={aiProvider}
                      onChange={(e) => {
                        setAiProvider(e.target.value);
                        setAiModel(modelsByProvider[e.target.value][0]);
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    >
                      {aiProviders.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* AI Model */}
                  <div>
                    <Label>مدل</Label>
                    <select
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600"
                    >
                      {modelsByProvider[aiProvider].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* System Prompt */}
                  <div>
                    <Label>System Prompt</Label>
                    <textarea
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      placeholder="مثلاً: شما یک دستیار مشتری‌سرویس هستید. به سؤالات به صورت کوتاه و مفید پاسخ دهید."
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg dark:bg-gray-700 dark:border-gray-600 min-h-24"
                    />
                  </div>

                  {/* Media Attachment */}
                  <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center gap-2">
                      <Paperclip className="w-4 h-4 text-blue-600" />
                      <Label className="m-0">مدیا / فایل پاسخ خودکار (اختیاری)</Label>
                    </div>

                    <Input
                      value={mediaPath}
                      onChange={(e) => setMediaPath(e.target.value)}
                      placeholder="مثال: uploads/campaign-media/catalog.pdf"
                    />

                    <div className="flex flex-col gap-2 md:flex-row">
                      <Input
                        type="file"
                        onChange={(e) => setSelectedMediaFile(e.target.files?.[0] || null)}
                        className="file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1 file:text-white"
                      />
                      <Button
                        type="button"
                        onClick={() => selectedMediaFile && uploadMediaMutation.mutate(selectedMediaFile)}
                        disabled={!selectedMediaFile || uploadMediaMutation.isPending}
                        className="bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        {uploadMediaMutation.isPending ? 'در حال آپلود...' : 'آپلود فایل'}
                      </Button>
                    </div>

                    {selectedMediaInfo && SelectedMediaIcon && (
                      <div className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-sm dark:bg-gray-800">
                        <SelectedMediaIcon className="w-4 h-4 text-blue-600" />
                        <span>نوع فایل: {selectedMediaInfo.label}</span>
                        {mediaFileName ? <span className="text-gray-500">| {mediaFileName}</span> : null}
                      </div>
                    )}

                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={sendAsVoiceNote}
                        onChange={(e) => setSendAsVoiceNote(e.target.checked)}
                        className="rounded"
                      />
                      در صورت صوت بودن فایل، به شکل ویس نوت ارسال شود
                    </label>
                  </div>

                  {/* Delay */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>حداقل تأخیر (ثانیه)</Label>
                      <Input
                        type="number"
                        min="1"
                        value={delayMin}
                        onChange={(e) => setDelayMin(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label>حداکثر تأخیر (ثانیه)</Label>
                      <Input
                        type="number"
                        min="1"
                        value={delayMax}
                        onChange={(e) => setDelayMax(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Save Button */}
                  <Button
                    onClick={() => saveRuleMutation.mutate()}
                    disabled={!selectedAccountId || (triggerType !== 'all' && !triggerValue) || !systemPrompt}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    ذخیره قانون
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Rules Table */}
          <Card>
            <CardHeader>
              <CardTitle>قوانین فعال</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8 text-gray-500">درحال بارگذاری...</div>
              ) : rules.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  هیچ قانونی تعریف‌شده‌ای وجود ندارد
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-200 dark:border-gray-700">
                        <th className="text-right px-4 py-3 font-semibold">اکانت</th>
                        <th className="text-right px-4 py-3 font-semibold">Trigger</th>
                        <th className="text-right px-4 py-3 font-semibold">ساعات</th>
                        <th className="text-right px-4 py-3 font-semibold">وضعیت</th>
                        <th className="text-right px-4 py-3 font-semibold">تاریخ ساخت</th>
                        <th className="text-center px-4 py-3 font-semibold">عملیات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((rule: any) => (
                        <tr key={rule.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-sm">{rule.accountPhone}</td>
                          <td className="px-4 py-3 text-sm">
                            <div className="flex flex-col gap-1">
                              <span className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 px-2 py-1 rounded text-xs inline-flex w-fit">
                                {rule.triggerType === 'all' ? 'همه' : rule.triggerType} {rule.triggerValue && `: ${rule.triggerValue}`}
                              </span>
                              {rule.mediaPath ? (
                                <span className="text-xs text-gray-500 dark:text-gray-400">مدیا: {rule.mediaPath}</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {rule.workingHours || `${rule.activeHourStart}:00 - ${rule.activeHourEnd}:00`}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <button
                              onClick={() => toggleRuleMutation.mutate({ ruleId: rule.id, isEnabled: !rule.isEnabled })}
                              className={`px-3 py-1 rounded-full text-xs font-medium ${
                                rule.isEnabled
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {rule.isEnabled ? 'فعال' : 'غیرفعال'}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                            {new Date(rule.createdAt).toLocaleDateString('fa-IR')}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={() => setDeleteDialog({ open: true, ruleId: rule.id, ruleName: `Rule ${rule.id.substring(0, 8)}` })}
                              className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Logs Tab */}
      {activeTab === 'logs' && (
        <Card>
          <CardHeader>
            <CardTitle>لاگ‌های پاسخ‌های خودکار</CardTitle>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                هنوز هیچ پاسخی ثبت‌نشده‌ای
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-right px-4 py-3 font-semibold">آن</th>
                      <th className="text-right px-4 py-3 font-semibold">پیام</th>
                      <th className="text-right px-4 py-3 font-semibold">پاسخ</th>
                      <th className="text-right px-4 py-3 font-semibold">وضعیت</th>
                      <th className="text-right px-4 py-3 font-semibold">تاریخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log: any) => (
                      <tr key={log.id} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="px-4 py-3 text-sm">{log.fromPhone}</td>
                        <td className="px-4 py-3 text-sm truncate max-w-xs">{log.incomingMessage}</td>
                        <td className="px-4 py-3 text-sm max-w-xs">
                          <div className="truncate">{log.autoReply}</div>
                          {log.mediaPath ? (
                            <a href={`/${log.mediaPath}`} target="_blank" rel="noreferrer" className="text-xs text-blue-600 underline">
                              فایل پیوست پاسخ
                            </a>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${
                            log.status === 'sent'
                              ? 'bg-green-100 text-green-800 dark:bg-green-900/30'
                              : 'bg-red-100 text-red-800 dark:bg-red-900/30'
                          }`}>
                            {log.status === 'sent' ? 'ارسال‌شد' : 'خطا'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                          {new Date(log.createdAt).toLocaleDateString('fa-IR')}
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

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => setDeleteDialog({ ...deleteDialog, open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>حذف قانون</AlertDialogTitle>
            <AlertDialogDescription>
              آیا مطمئن هستید که می‌خواهید این قانون را حذف کنید؟ این عمل قابل‌برگشت نیست.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>انصراف</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteDialog.ruleId && deleteRuleMutation.mutate(deleteDialog.ruleId)}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              حذف
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
