'use client';

import { ChangeEvent, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Settings, Smartphone, Info, Globe, Download, Upload } from 'lucide-react';
import { toast } from 'sonner';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'appearance' | 'rate-limit' | 'warmup' | 'about'>('appearance');

  // Warmup settings
  const triggerWarmupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/warmup/trigger', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to run warmup');
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success(data.message || 'Warump started successfully');
      } else {
        toast.error(data.error || 'Failed to start warmup');
      }
    },
    onError: (err: any) => {
      toast.error(err.message);
    }
  });
  const [language, setLanguage] = useState('fa');
  const [theme, setTheme] = useState('dark');
  
  // Rate limiting settings
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [rateLimitMinMs, setRateLimitMinMs] = useState('1000');
  const [rateLimitMaxMs, setRateLimitMaxMs] = useState('5000');
  const [rateLimitEnabled, setRateLimitEnabled] = useState(true);

  // Fetch accounts
  const { data: accounts } = useQuery({
    queryKey: ['accounts'],
    queryFn: async () => {
      const res = await fetch('/api/accounts');
      if (!res.ok) throw new Error('Failed to fetch accounts');
      return res.json();
    }
  });

  // Fetch rate limit config for selected account
  const { data: rateLimitConfig } = useQuery({
    queryKey: ['rate-limit', selectedAccountId],
    queryFn: async () => {
      if (!selectedAccountId) return null;
      const res = await fetch(`/api/settings/rate-limit/${selectedAccountId}`);
      if (!res.ok) throw new Error('Failed to fetch rate limit config');
      const data = await res.json();
      setRateLimitMinMs(data.minMs?.toString() || '1000');
      setRateLimitMaxMs(data.maxMs?.toString() || '5000');
      setRateLimitEnabled(data.enabled !== false);
      return data;
    },
    enabled: !!selectedAccountId
  });

  // Update rate limit
  const updateRateLimitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/settings/rate-limit/${selectedAccountId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          minMs: parseInt(rateLimitMinMs),
          maxMs: parseInt(rateLimitMaxMs),
          enabled: rateLimitEnabled
        })
      });
      if (!res.ok) throw new Error('Failed to update rate limit');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Rate limit settings updated');
      queryClient.invalidateQueries({ queryKey: ['rate-limit', selectedAccountId] });
    },
    onError: (error: any) => {
      toast.error(`Error: ${error.message}`);
    }
  });

  const handleApplyAppearance = () => {
    localStorage.setItem('theme', theme);
    localStorage.setItem('language', language);
    toast.success('Appearance settings saved');
  };

  const exportSettingsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/settings/backup');
      if (!res.ok) throw new Error('Failed to export settings');
      return res.json();
    },
    onSuccess: (data) => {
      const payload = {
        ...data,
        appearance: {
          theme: localStorage.getItem('theme') || theme,
          language: localStorage.getItem('language') || language,
        },
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `settings-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('فایل تنظیمات با موفقیت خروجی گرفته شد');
    },
    onError: (error: any) => {
      toast.error(`خطا در خروجی گرفتن: ${error.message}`);
    }
  });

  const importSettingsMutation = useMutation({
    mutationFn: async (backup: any) => {
      const res = await fetch('/api/settings/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup })
      });
      if (!res.ok) throw new Error('Failed to restore settings');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['rate-limit'] });
      toast.success('تنظیمات با موفقیت ایمپورت شد');
    },
    onError: (error: any) => {
      toast.error(`خطا در ایمپورت: ${error.message}`);
    }
  });

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const backup = JSON.parse(text);

      if (backup.appearance) {
        if (backup.appearance.theme) {
          localStorage.setItem('theme', backup.appearance.theme);
          setTheme(backup.appearance.theme);
        }
        if (backup.appearance.language) {
          localStorage.setItem('language', backup.appearance.language);
          setLanguage(backup.appearance.language);
        }
      }

      importSettingsMutation.mutate(backup);
    } catch (error: any) {
      toast.error(`فایل نامعتبر است: ${error.message}`);
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-[#F1F5F9] flex items-center gap-2">
          <Settings className="w-8 h-8" />
          Settings
        </h2>
        <p className="text-[#94A3B8] mt-1">مدیریت تنظیمات کاربردی و سیستمی</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-white/10 overflow-x-auto">
        <button
          onClick={() => setActiveTab('appearance')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'appearance'
              ? 'border-[#7C3AED] text-[#7C3AED]'
              : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
          }`}
        >
          <Globe className="w-4 h-4 inline mr-2" />
          Appearance
        </button>
        <button
          onClick={() => setActiveTab('rate-limit')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'rate-limit'
              ? 'border-[#7C3AED] text-[#7C3AED]'
              : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
          }`}
        >
          <Smartphone className="w-4 h-4 inline mr-2" />
          Rate Limiting
        </button>
        <button
          onClick={() => setActiveTab('warmup')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'warmup'
              ? 'border-[#7C3AED] text-[#7C3AED]'
              : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
          }`}
        >
          <Smartphone className="w-4 h-4 inline mr-2" />
          Warmup
        </button>
        <button
          onClick={() => setActiveTab('about')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'about'
              ? 'border-[#7C3AED] text-[#7C3AED]'
              : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
          }`}
        >
          <Info className="w-4 h-4 inline mr-2" />
          About
        </button>
        <button
          onClick={() => setActiveTab('backup')}
          className={`px-4 py-3 font-medium border-b-2 transition-colors ${
            activeTab === 'backup'
              ? 'border-[#7C3AED] text-[#7C3AED]'
              : 'border-transparent text-[#94A3B8] hover:text-[#F1F5F9]'
          }`}
        >
          <Download className="w-4 h-4 inline mr-2" />
          Backup / Restore
        </button>
      </div>

      {/* Warmup Tab */}
      {activeTab === 'warmup' && (
        <Card className="bg-[#1A1A2E]/50 border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">سیستم دمی (Warmup)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <p className="text-[#94A3B8] text-sm">
              برای جلوگیری از بن شدن، خطوط خود را با یکدیگر گرم کنید و اعتبار سنجی ایجاد کنید.
              سیستم به صورت خودکار پیام‌هایی بین شماره‌هایی که متصل کرده‌اید ارسال می‌کند.
            </p>
            <Button 
                onClick={() => triggerWarmupMutation.mutate()} 
                disabled={triggerWarmupMutation.isPending}
                className="bg-[#22C55E] hover:bg-[#22C55E]/80 text-white"
            >
                {triggerWarmupMutation.isPending ? 'در حال اجرا...' : 'شروع عملیات Warmup'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Appearance Tab */}
      {activeTab === 'appearance' && (
        <Card className="bg-[#1A1A2E]/50 border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">Appearance Settings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Language */}
            <div className="space-y-3">
              <Label className="text-[#F1F5F9]">Language / زبان</Label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full bg-[#0F0F1A] border border-white/10 rounded-md px-3 py-2 text-[#F1F5F9] focus:border-[#7C3AED] focus:outline-none"
              >
                <option value="fa">فارسی (Persian)</option>
                <option value="en">English</option>
                <option value="ar">العربية (Arabic)</option>
              </select>
            </div>

            {/* Theme */}
            <div className="space-y-3">
              <Label className="text-[#F1F5F9]">Theme</Label>
              <div className="grid grid-cols-3 gap-3">
                {['light', 'dark', 'auto'].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`p-4 rounded-lg border-2 transition-all ${
                      theme === t
                        ? 'border-[#7C3AED] bg-[#7C3AED]/10'
                        : 'border-white/10 hover:border-white/20'
                    }`}
                  >
                    <div className="h-8 w-8 rounded mb-2 mx-auto" style={{
                      backgroundColor: t === 'light' ? '#F1F5F9' : t === 'dark' ? '#1A1A2E' : '#7C3AED'
                    }}></div>
                    <p className="text-sm text-[#F1F5F9] capitalize">{t}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-4 border-t border-white/10">
              <Button
                onClick={handleApplyAppearance}
                className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
              >
                Apply Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rate Limiting Tab */}
      {activeTab === 'rate-limit' && (
        <Card className="bg-[#1A1A2E]/50 border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">Rate Limiting Settings</CardTitle>
            <p className="text-sm text-[#94A3B8] mt-2">تنظیم سرعت ارسال پیام برای جلوگیری از بن شدن حساب</p>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Account Selection */}
            <div className="space-y-3">
              <Label className="text-[#F1F5F9]">Select Account</Label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full bg-[#0F0F1A] border border-white/10 rounded-md px-3 py-2 text-[#F1F5F9] focus:border-[#7C3AED] focus:outline-none"
              >
                <option value="">انتخاب حساب...</option>
                {accounts?.map((account: any) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName} ({account.phoneNumber})
                  </option>
                ))}
              </select>
            </div>

            {selectedAccountId && (
              <>
                {/* Enable/Disable Toggle */}
                <div className="space-y-3">
                  <Label className="text-[#F1F5F9] flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={rateLimitEnabled}
                      onChange={(e) => setRateLimitEnabled(e.target.checked)}
                      className="rounded border-white/30 bg-gray-700 w-4 h-4 accent-[#7C3AED]"
                    />
                    Enable Rate Limiting
                  </Label>
                </div>

                {rateLimitEnabled && (
                  <>
                    {/* Min Delay */}
                    <div className="space-y-3">
                      <Label className="text-[#F1F5F9]">
                        Minimum Delay (milliseconds)
                        <span className="text-[#94A3B8] text-xs ml-2">حداقل تاخیر میان پیام‌ها</span>
                      </Label>
                      <Input
                        type="number"
                        value={rateLimitMinMs}
                        onChange={(e) => setRateLimitMinMs(e.target.value)}
                        placeholder="1000"
                        className="bg-[#0F0F1A] border-white/10"
                        min="100"
                        step="100"
                      />
                      <p className="text-xs text-[#64748B]">پیشنهاد: 1000-3000ms برای حسابات عادی</p>
                    </div>

                    {/* Max Delay */}
                    <div className="space-y-3">
                      <Label className="text-[#F1F5F9]">
                        Maximum Delay (milliseconds)
                        <span className="text-[#94A3B8] text-xs ml-2">حداکثر تاخیر میان پیام‌ها</span>
                      </Label>
                      <Input
                        type="number"
                        value={rateLimitMaxMs}
                        onChange={(e) => setRateLimitMaxMs(e.target.value)}
                        placeholder="5000"
                        className="bg-[#0F0F1A] border-white/10"
                        min="100"
                        step="100"
                      />
                      <p className="text-xs text-[#64748B]">پیشنهاد: 5000-10000ms برای حسابات جدید</p>
                    </div>

                    {/* Info Box */}
                    <div className="bg-[#0F0F1A] border border-[#94A3B8]/20 rounded-lg p-4">
                      <p className="text-sm text-[#94A3B8]">
                        <span className="font-medium text-[#F1F5F9]">نحوه کار:</span> هر پیام بعد از پیام قبل، تاخیری تصادفی بین حداقل و حداکثر داده شده صبر می‌کند.
                      </p>
                    </div>
                  </>
                )}

                {/* Save Button */}
                <div className="pt-4 border-t border-white/10">
                  <Button
                    onClick={() => updateRateLimitMutation.mutate()}
                    disabled={updateRateLimitMutation.isPending}
                    className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                  >
                    {updateRateLimitMutation.isPending ? 'Saving...' : 'Save Rate Limit Settings'}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'backup' && (
        <Card className="bg-[#1A1A2E]/50 border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">Backup / Restore Settings</CardTitle>
            <p className="text-sm text-[#94A3B8] mt-2">
              تمام تنظیمات برنامه در یک فایل JSON خروجی گرفته می‌شود و بعداً می‌توانید همان فایل را دوباره ایمپورت کنید.
            </p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-[#0F0F1A] p-5 space-y-4">
                <div>
                  <h3 className="text-[#F1F5F9] font-medium">خروجی کامل تنظیمات</h3>
                  <p className="text-sm text-[#94A3B8] mt-2">
                    شامل ظاهر برنامه، تنظیمات Rate Limit، تنظیمات اکانت‌ها، پراکسی‌ها، کلیدهای API، Auto Reply و Warmup.
                  </p>
                </div>
                <Button
                  onClick={() => exportSettingsMutation.mutate()}
                  disabled={exportSettingsMutation.isPending}
                  className="bg-[#7C3AED] hover:bg-[#6D28D9] text-white"
                >
                  <Download className="w-4 h-4 mr-2" />
                  {exportSettingsMutation.isPending ? 'درحال خروجی گرفتن...' : 'دانلود فایل تنظیمات'}
                </Button>
              </div>

              <div className="rounded-lg border border-white/10 bg-[#0F0F1A] p-5 space-y-4">
                <div>
                  <h3 className="text-[#F1F5F9] font-medium">ایمپورت تنظیمات</h3>
                  <p className="text-sm text-[#94A3B8] mt-2">
                    فایل JSON قبلی را انتخاب کنید تا همه تنظیمات ذخیره‌شده دوباره روی سیستم اعمال شوند.
                  </p>
                </div>
                <input
                  id="settings-backup-file"
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportFile}
                />
                <Button
                  onClick={() => document.getElementById('settings-backup-file')?.click()}
                  disabled={importSettingsMutation.isPending}
                  variant="outline"
                  className="border-white/10 hover:bg-white/10 text-[#F1F5F9]"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  {importSettingsMutation.isPending ? 'درحال ایمپورت...' : 'انتخاب فایل و ایمپورت'}
                </Button>
              </div>
            </div>

            <div className="rounded-lg border border-[#7C3AED]/20 bg-[#7C3AED]/5 p-4 text-sm text-[#C4B5FD]">
              نکته: این بخش فقط تنظیمات را جابه‌جا می‌کند و اطلاعاتی مثل مخاطبین، لاگ پیام‌ها و کمپین‌ها را حذف یا بازنویسی نمی‌کند.
            </div>
          </CardContent>
        </Card>
      )}

      {/* About Tab */}
      {activeTab === 'about' && (
        <Card className="bg-[#1A1A2E]/50 border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">About WhatsApp Turbo CRM</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <p className="text-sm text-[#94A3B8]">Version</p>
                <p className="text-lg font-medium text-[#F1F5F9]">1.0.0</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-[#94A3B8]">Release Date</p>
                <p className="text-lg font-medium text-[#F1F5F9]">2026-03-01</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-[#94A3B8]">Framework</p>
                <p className="text-lg font-medium text-[#F1F5F9]">Next.js 15.0.4</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-[#94A3B8]">Database</p>
                <p className="text-lg font-medium text-[#F1F5F9]">SQLite</p>
              </div>
            </div>

            {/* Features */}
            <div className="space-y-4 pt-6 border-t border-white/10">
              <h3 className="text-[#F1F5F9] font-medium">Features</h3>
              <ul className="space-y-2 text-[#94A3B8]">
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>WhatsApp Account Management & Connection</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Bulk Campaign Creation & Execution</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Contact Management & Segmentation</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Message Personalization</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Analytics & Reporting</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Group Extraction & Management</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[#10B981] mt-1">✓</span>
                  <span>Rate Limiting & Account Protection</span>
                </li>
              </ul>
            </div>

            {/* Support */}
            <div className="mt-8 pt-6 border-t border-white/10">
              <div className="bg-[#0F0F1A] border border-white/10 rounded-lg p-4">
                <p className="text-[#94A3B8] text-sm">
                  برای گزارش مشکلات یا پیشنهادات، لطفاً با تیم پشتیبانی تماس بگیرید.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
