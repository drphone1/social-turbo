'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Plus, Copy, Eye, EyeOff, Trash2, Zap, RefreshCw, Bot, QrCode, ShieldCheck, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

type TextIntegrityWarning = {
  field: string;
  message: string;
  suspiciousSequenceCount: number;
  questionMarkRatio: number;
};

function extractControlWarnings(controlResult: any): Array<TextIntegrityWarning & { action: string; campaignId?: string | null }> {
  if (!controlResult?.results || !Array.isArray(controlResult.results)) {
    return [];
  }

  return controlResult.results.flatMap((result: any) => {
    const warnings = Array.isArray(result?.data?.warnings) ? result.data.warnings : [];

    return warnings.map((warning: TextIntegrityWarning) => ({
      action: result?.action || 'unknown',
      campaignId: result?.data?.id || null,
      field: warning.field,
      message: warning.message,
      suspiciousSequenceCount: Number(warning.suspiciousSequenceCount || 0),
      questionMarkRatio: Number(warning.questionMarkRatio || 0),
    }));
  });
}

function extractCreatedCampaigns(controlResult: any): Array<{ id: string; name: string; status: string }> {
  if (!controlResult?.results || !Array.isArray(controlResult.results)) {
    return [];
  }

  return controlResult.results
    .filter((result: any) => result?.action === 'create_campaign' && result?.success && result?.data?.id)
    .map((result: any) => ({
      id: String(result.data.id),
      name: String(result.data.name || 'بدون نام'),
      status: String(result.data.status || 'draft'),
    }));
}

export default function AIHubPage() {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'keys' | 'test' | 'control'>('keys');
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; keyId: string | null; provider: string }>({ 
    open: false, 
    keyId: null, 
    provider: '' 
  });
  
  // Form state
  const [selectedProvider, setSelectedProvider] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('gpt-3.5-turbo');
  
  // Test state
  const [testProvider, setTestProvider] = useState('openai');
  const [testModel, setTestModel] = useState('gpt-3.5-turbo');
  const [testPrompt, setTestPrompt] = useState('سلام، من یک دستیار هستم.');

  // AI Control state
  const [controlProvider, setControlProvider] = useState('gemini');
  const [controlModel, setControlModel] = useState('gemini-2.0-flash');
  const [controlInstruction, setControlInstruction] = useState('وضعیت سلامت سیستم را بررسی کن و اگر اکانت متصل نداریم، لیست اکانت‌ها را بده.');
  const [controlResult, setControlResult] = useState<any>(null);

  // Fetch API keys
  const { data: keys = [], isLoading } = useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => {
      const res = await fetch('/api/ai/keys');
      if (!res.ok) throw new Error('Failed to fetch keys');
      return res.json();
    }
  });

  // Fetch providers
  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: async () => {
      const res = await fetch('/api/ai/providers');
      if (!res.ok) throw new Error('Failed to fetch providers');
      return res.json();
    }
  });

  const { data: controlOverview, refetch: refetchControlOverview, isFetching: isFetchingControlOverview } = useQuery({
    queryKey: ['ai-control-overview'],
    queryFn: async () => {
      const res = await fetch('/api/ai/control/overview');
      if (!res.ok) throw new Error('Failed to fetch AI control overview');
      return res.json();
    },
    staleTime: 10_000,
  });

  // Save key
  const saveKeyMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/ai/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey,
          modelName,
          isActive: true
        })
      });
      if (!res.ok) throw new Error('Failed to save key');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('کلید API ذخیره شد ✅');
      resetForm();
      setIsAddDialogOpen(false);
    },
    onError: () => {
      toast.error('خطا در ذخیره کلید API');
    }
  });

  // Delete key
  const deleteKeyMutation = useMutation({
    mutationFn: async (keyId: string) => {
      const res = await fetch(`/api/ai/keys/${keyId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete key');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('کلید حذف شد');
      setDeleteDialog({ open: false, keyId: null, provider: '' });
    },
    onError: () => {
      toast.error('خطا در حذف کلید');
    }
  });

  // Test prompt
  const testPromptMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/ai/test-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: testProvider,
          model: testModel,
          prompt: testPrompt,
          systemPrompt: 'You are a helpful assistant.'
        })
      });
      if (!res.ok) throw new Error('Failed to test prompt');
      return res.json();
    },
    onSuccess: (data) => {
      toast.success('پاسخ دریافت شد ✅');
      setTestPrompt(`پاسخ: ${data.response || 'بدون پاسخ'}`);
    },
    onError: () => {
      toast.error('خطا در تست پاسخ');
    }
  });

  const controlMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/ai/control/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: controlProvider,
          model: controlModel,
          instruction: controlInstruction,
          maxActions: 5,
        })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to execute AI control instruction');
      return data;
    },
    onSuccess: (data) => {
      setControlResult(data);
      toast.success('فرمان هوش مصنوعی اجرا شد ✅');
      const warningCount = extractControlWarnings(data).length;
      if (warningCount > 0) {
        toast.warning(`هوش مصنوعی کمپین را ساخت اما ${warningCount} هشدار سلامت متن گزارش شد. قبل از اجرای نهایی بازبینی کنید.`);
      }
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      refetchControlOverview();
    },
    onError: (error: Error) => {
      toast.error(`خطا در اجرای فرمان: ${error.message}`);
    }
  });

  const resetForm = () => {
    setSelectedProvider('openai');
    setApiKey('');
    setModelName('gpt-3.5-turbo');
  };

  const providers_list = [
    { value: 'openai', label: 'OpenAI', models: ['gpt-4', 'gpt-3.5-turbo', 'gpt-4-turbo'] },
    { value: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
    { value: 'claude', label: 'Anthropic Claude', models: ['claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307'] }
  ];

  const providerOptions = providers.length > 0 ? providers : providers_list;
  const currentProvider = providerOptions.find((p: any) => p.value === selectedProvider);
  const testCurrentProvider = providerOptions.find((p: any) => p.value === testProvider);
  const controlCurrentProvider = providerOptions.find((p: any) => p.value === controlProvider);
  const qrResults = (controlResult?.results || []).filter((item: any) => item?.data?.qr);
  const pairingResults = (controlResult?.results || []).filter((item: any) => item?.data?.pairingCode);
  const controlWarnings = extractControlWarnings(controlResult);
  const createdCampaigns = extractCreatedCampaigns(controlResult);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center mb-4">
            <Zap className="mr-3 text-blue-600" size={32} />
            <div>
              <h1 className="text-4xl font-bold text-gray-900">هاب هوش مصنوعی</h1>
              <p className="text-gray-600 mt-1">مدیریت API Keys، تست مدل‌ها و کنترل هوشمند کل اپلیکیشن</p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex gap-2 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('keys')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'keys'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            کلیدهای API
          </button>
          <button
            onClick={() => setActiveTab('test')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'test'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            تست پاسخ
          </button>
          <button
            onClick={() => setActiveTab('control')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'control'
                ? 'text-blue-600 border-b-2 border-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            کنترل AI
          </button>
        </div>

        {/* Keys Tab */}
        {activeTab === 'keys' && (
          <div className="space-y-6">
            {/* Add Key Dialog */}
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2 bg-blue-600 hover:bg-blue-700">
                  <Plus size={20} /> اضافه کردن کلید جدید
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>اضافه کردن کلید API جدید</DialogTitle>
                </DialogHeader>
                <div className="space-y-6">
                  <div>
                    <Label className="text-gray-700">انتخاب Provider</Label>
                    <select
                      value={selectedProvider}
                      onChange={(e) => {
                        setSelectedProvider(e.target.value);
                        setModelName(providerOptions.find((p: any) => p.value === e.target.value)?.models?.[0] || '');
                      }}
                      className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {providerOptions.map((p: any) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label className="text-gray-700">کلید API</Label>
                    <Input
                      type="password"
                      placeholder="sk-... یا API-KEY"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="w-full mt-2"
                    />
                    <p className="text-sm text-gray-500 mt-1">کلید شما رمزگذاری شده در دیتابیس ذخیره می‌شود</p>
                  </div>

                  <div>
                    <Label className="text-gray-700">مدل پیشفرض</Label>
                    <select
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                      className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      {currentProvider?.models.map((model: string) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex gap-3 justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsAddDialogOpen(false)}
                    >
                      انصراف
                    </Button>
                    <Button
                      onClick={() => saveKeyMutation.mutate()}
                      disabled={!apiKey || !selectedProvider}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      ذخیره کلید
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* Keys List */}
            {isLoading ? (
              <div className="text-center py-8 text-gray-500">در حال بارگذاری...</div>
            ) : keys.length === 0 ? (
              <Card className="border-0 shadow-sm bg-blue-50 border-l-4 border-blue-500">
                <CardContent className="pt-6">
                  <p className="text-gray-700">هیچ کلید API ثبت نشده است</p>
                  <p className="text-sm text-gray-600 mt-2">برای استفاده از توانایی‌های AI، یک کلید اضافه کنید</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {keys.map((key: any) => (
                  <Card key={key.id} className="border-0 shadow-sm hover:shadow-md transition-shadow">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <div className="px-3 py-1 bg-blue-100 text-blue-700 rounded text-sm font-medium">
                                {providerOptions.find((p: any) => p.value === key.provider)?.label}
                            </div>
                            {key.isActive && (
                              <div className="px-3 py-1 bg-green-100 text-green-700 rounded text-sm font-medium">
                                فعال
                              </div>
                            )}
                          </div>
                          <div className="space-y-2">
                            <p className="text-sm">
                              <span className="text-gray-600">مدل:</span>
                              <span className="font-mono text-gray-900 mr-2">{key.modelName}</span>
                            </p>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-600 text-sm">کلید:</span>
                              <code className="font-mono text-sm bg-gray-100 px-3 py-1 rounded">
                                {showSecret[key.id] ? key.apiKey : key.apiKey}
                              </code>
                              <button
                                onClick={() => setShowSecret(prev => ({ ...prev, [key.id]: !prev[key.id] }))}
                                className="text-gray-600 hover:text-gray-900"
                              >
                                {showSecret[key.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                              </button>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(key.apiKey);
                                  toast.success('کپی شد');
                                }}
                                className="text-gray-600 hover:text-gray-900"
                              >
                                <Copy size={16} />
                              </button>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => setDeleteDialog({ open: true, keyId: key.id, provider: key.provider })}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <Trash2 size={20} />
                        </button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Test Tab */}
        {activeTab === 'test' && (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Test Form */}
            <Card className="border-0 shadow-sm">
              <CardHeader>
                <CardTitle>تست مدل AI</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label className="text-gray-700">انتخاب Provider</Label>
                  <select
                    value={testProvider}
                    onChange={(e) => {
                      setTestProvider(e.target.value);
                      setTestModel(providerOptions.find((p: any) => p.value === e.target.value)?.models?.[0] || '');
                    }}
                    className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {providerOptions.map((p: any) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <Label className="text-gray-700">انتخاب مدل</Label>
                  <select
                    value={testModel}
                    onChange={(e) => setTestModel(e.target.value)}
                    className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {testCurrentProvider?.models.map((model: string) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <Label className="text-gray-700">متن برای تست</Label>
                  <textarea
                    placeholder="متنی بنویسید برای تست"
                    value={testPrompt}
                    onChange={(e) => setTestPrompt(e.target.value)}
                    className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent h-32 resize-none"
                  />
                </div>

                <Button
                  onClick={() => testPromptMutation.mutate()}
                  disabled={!testPrompt || !testProvider || testPromptMutation.isPending}
                  className="w-full bg-blue-600 hover:bg-blue-700"
                >
                  {testPromptMutation.isPending ? 'درحال پردازش...' : 'ارسال برای تست'}
                </Button>
              </CardContent>
            </Card>

            {/* Test Result */}
            <Card className="border-0 shadow-sm bg-gray-50">
              <CardHeader>
                <CardTitle>نتیجه تست</CardTitle>
              </CardHeader>
              <CardContent>
                {testPromptMutation.isPending ? (
                  <div className="flex items-center justify-center h-64">
                    <div className="text-gray-500">در حال انتظار پاسخ...</div>
                  </div>
                ) : testPrompt.startsWith('پاسخ:') ? (
                  <div className="bg-white p-4 rounded-lg border border-gray-200 h-64 overflow-auto">
                    <p className="text-gray-900 whitespace-pre-wrap">{testPrompt}</p>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-64 text-gray-500">
                    نتیجه تست اینجا نمایش داده می‌شود
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'control' && (
          <div className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-3">
              <Card className="border-0 shadow-sm lg:col-span-2">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bot className="text-blue-600" size={20} />
                    کنترل هوشمند اپلیکیشن
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <Label className="text-gray-700">Provider</Label>
                      <select
                        value={controlProvider}
                        onChange={(e) => {
                          setControlProvider(e.target.value);
                          setControlModel(providerOptions.find((p: any) => p.value === e.target.value)?.models?.[0] || '');
                        }}
                        className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {providerOptions.map((p: any) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <Label className="text-gray-700">Model</Label>
                      <select
                        value={controlModel}
                        onChange={(e) => setControlModel(e.target.value)}
                        className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {controlCurrentProvider?.models?.map((model: string) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <Label className="text-gray-700">دستور اجرایی</Label>
                    <textarea
                      value={controlInstruction}
                      onChange={(e) => setControlInstruction(e.target.value)}
                      className="w-full mt-2 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent h-36 resize-y"
                      placeholder="مثال: یک اکانت جدید با شناسه sales-tehran بساز، اگر لازم بود QR یا pairing code بده، سپس وضعیت سلامت را گزارش کن."
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {[
                      'وضعیت سلامت سیستم و اکانت‌ها را بررسی کن.',
                      'لیست اکانت‌ها را بده و اگر اکانت disconnect بود آن را connect کن.',
                      'برای اکانت sales-main آخرین QR را بگیر.',
                      'کمپین‌های فعال را لیست کن و اگر paused هستند فقط گزارش بده.',
                    ].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setControlInstruction(preset)}
                        className="px-3 py-2 rounded-full bg-blue-50 text-blue-700 text-sm hover:bg-blue-100 transition-colors"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <Button
                      onClick={() => controlMutation.mutate()}
                      disabled={!controlInstruction || controlMutation.isPending}
                      className="bg-blue-600 hover:bg-blue-700"
                    >
                      {controlMutation.isPending ? 'درحال اجرای کنترل...' : 'اجرای فرمان AI'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => refetchControlOverview()}
                      disabled={isFetchingControlOverview}
                    >
                      <RefreshCw className={`mr-2 ${isFetchingControlOverview ? 'animate-spin' : ''}`} size={16} />
                      بروزرسانی وضعیت
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm bg-slate-50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <ShieldCheck className="text-emerald-600" size={20} />
                    وضعیت سریع
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-gray-700">
                  <div className="p-3 rounded-lg bg-white border border-gray-200">
                    <div className="text-gray-500">اکانت‌ها</div>
                    <div className="text-2xl font-bold text-gray-900">{controlOverview?.summary?.totalAccounts ?? 0}</div>
                    <div className="text-xs text-gray-500 mt-1">متصل: {controlOverview?.summary?.connectedAccounts ?? 0}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-white border border-gray-200">
                    <div className="text-gray-500">کمپین‌ها</div>
                    <div className="text-2xl font-bold text-gray-900">{controlOverview?.summary?.totalCampaigns ?? 0}</div>
                    <div className="text-xs text-gray-500 mt-1">فعال/queued: {controlOverview?.summary?.queuedCampaigns ?? 0}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-white border border-gray-200">
                    <div className="text-gray-500">پروکسی‌ها</div>
                    <div className="text-2xl font-bold text-gray-900">{controlOverview?.summary?.totalProxyProfiles ?? 0}</div>
                  </div>
                  <div className="p-3 rounded-lg bg-white border border-gray-200">
                    <div className="text-gray-500">کلیدهای AI</div>
                    <div className="text-sm text-gray-900 mt-1 space-y-1">
                      {(controlOverview?.providerKeys || []).length > 0 ? (
                        controlOverview.providerKeys.map((item: any) => (
                          <div key={`${item.provider}-${item.modelName}`} className="flex items-center justify-between gap-2">
                            <span>{item.provider}</span>
                            <span className="text-xs text-gray-500">{item.modelName}</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-gray-500">هیچ کلیدی ثبت نشده است</span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {(qrResults.length > 0 || pairingResults.length > 0) && (
              <div className="grid gap-6 lg:grid-cols-2">
                {qrResults.map((item: any, index: number) => (
                  <Card key={`qr-${index}`} className="border-0 shadow-sm">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <QrCode className="text-blue-600" size={20} />
                        QR اکانت {item.data.accountId}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col items-center gap-4">
                      <div className="bg-white p-4 rounded-xl border border-gray-200">
                        <QRCodeSVG value={item.data.qr} size={220} />
                      </div>
                      <p className="text-sm text-gray-600 text-center">
                        برای اتصال نهایی، QR را با WhatsApp روی گوشی اسکن کنید.
                      </p>
                    </CardContent>
                  </Card>
                ))}

                {pairingResults.map((item: any, index: number) => (
                  <Card key={`pairing-${index}`} className="border-0 shadow-sm">
                    <CardHeader>
                      <CardTitle>Pairing Code برای {item.data.accountId}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="text-3xl font-bold tracking-[0.3em] text-center bg-slate-50 rounded-xl py-6 border border-gray-200">
                        {item.data.pairingCode}
                      </div>
                      <p className="text-sm text-gray-600 text-center">
                        این کد را داخل WhatsApp روی گوشی برای اتصال اکانت وارد کنید.
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="border-0 shadow-sm">
                <CardHeader>
                  <CardTitle>نتیجه اجرای AI</CardTitle>
                </CardHeader>
                <CardContent>
                  {controlMutation.isPending ? (
                    <div className="h-72 flex items-center justify-center text-gray-500">درحال اجرای فرمان...</div>
                  ) : controlResult ? (
                    <div className="space-y-4">
                      <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
                        {controlResult.plan?.summary || 'پلان ثبت شد.'}
                      </div>
                      {createdCampaigns.length > 0 && (
                        <div className="p-4 rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-sm space-y-3">
                          <div className="font-semibold">کمپین‌های ساخته‌شده توسط AI</div>
                          <div className="space-y-2">
                            {createdCampaigns.map((campaign) => (
                              <div key={campaign.id} className="rounded-lg bg-white border border-blue-100 px-3 py-2">
                                <div className="font-medium">{campaign.name}</div>
                                <div className="text-xs text-blue-700 mt-1">شناسه: {campaign.id}</div>
                                <div className="text-xs text-blue-700">وضعیت: {campaign.status}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {controlWarnings.length > 0 && (
                        <div className="p-4 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm space-y-3">
                          <div className="flex items-center gap-2 font-semibold">
                            <AlertTriangle size={18} className="text-amber-600" />
                            هشدار سلامت متن در خروجی AI
                          </div>
                          <p className="text-amber-800 leading-6">
                            هوش مصنوعی یک یا چند کمپین با متن مشکوک یا احتمال خرابی کاراکتر ساخته است. قبل از اجرای نهایی، متن کمپین را در بخش کمپین‌ها بازبینی کنید.
                          </p>
                          <div className="space-y-2">
                            {controlWarnings.map((warning, index) => (
                              <div key={`${warning.action}-${warning.campaignId || 'no-id'}-${warning.field}-${index}`} className="rounded-lg bg-white border border-amber-200 px-3 py-3">
                                <div className="font-medium text-amber-900">اکشن: {warning.action}</div>
                                {warning.campaignId && (
                                  <div className="text-xs text-amber-700 mt-1">شناسه کمپین: {warning.campaignId}</div>
                                )}
                                <div className="text-xs text-amber-700 mt-1">فیلد: {warning.field}</div>
                                <div className="mt-2 leading-6">{warning.message}</div>
                                <div className="mt-2 text-xs bg-amber-100 border border-amber-200 rounded-md px-2 py-2 space-y-1">
                                  <div>تعداد توالی‌های مشکوک: {warning.suspiciousSequenceCount}</div>
                                  <div>نسبت علامت سؤال: {warning.questionMarkRatio}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <pre className="bg-slate-950 text-slate-100 text-xs rounded-xl p-4 overflow-auto max-h-[24rem] whitespace-pre-wrap">
                        {JSON.stringify(controlResult, null, 2)}
                      </pre>
                    </div>
                  ) : (
                    <div className="h-72 flex items-center justify-center text-gray-500">
                      نتیجه اجرای فرمان اینجا نمایش داده می‌شود
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm bg-slate-50">
                <CardHeader>
                  <CardTitle>کانتکست عملیاتی فعلی</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="bg-white border border-gray-200 rounded-xl p-4 text-xs overflow-auto max-h-[28rem] whitespace-pre-wrap text-gray-800">
                    {JSON.stringify(controlOverview || {}, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </div>

      {/* Delete Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => 
        setDeleteDialog({ ...deleteDialog, open })
      }>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>آیا مطمئن هستید؟</AlertDialogTitle>
            <AlertDialogDescription>
              کلید API برای {deleteDialog.provider} حذف خواهد شد. این کار قابل برگشت نیست.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-3 justify-end">
            <AlertDialogCancel>انصراف</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteDialog.keyId) {
                  deleteKeyMutation.mutate(deleteDialog.keyId);
                }
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              حذف
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
