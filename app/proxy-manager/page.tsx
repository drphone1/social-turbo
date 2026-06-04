'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2, Plus, Edit2, Activity, Zap, Globe, RotateCw } from 'lucide-react';

interface ProxyProfile {
  id: string;
  name: string;
  type: 'http' | 'socks5' | 'socks4';
  host: string;
  port: number;
  username?: string;
  password?: string;
  rotationPolicy?: string;
  testStatus?: 'healthy' | 'unhealthy' | 'untested';
  lastTested?: string;
}

export default function ProxyManagerPage() {
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<{
    name: string;
    type: 'http' | 'socks5' | 'socks4';
    host: string;
    port: number;
    username: string;
    password: string;
  }>({
    name: '',
    type: 'http',
    host: '',
    port: 8080,
    username: '',
    password: ''
  });
  const queryClient = useQueryClient();

  // Fetch proxy profiles
  const { data: proxies = [], isLoading } = useQuery({
    queryKey: ['proxies'],
    queryFn: async () => {
      const response = await fetch('/api/proxy/profiles');
      if (!response.ok) throw new Error('Failed to fetch proxies');
      return response.json();
    }
  });

  // Create/Update proxy
  const { mutate: saveProxy } = useMutation({
    mutationFn: async (payload: any) => {
      const url = editingId ? `/api/proxy/profiles/${editingId}` : '/api/proxy/profiles';
      const method = editingId ? 'PATCH' : 'POST';
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Failed to save proxy');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxies'] });
      setIsOpen(false);
      resetForm();
    }
  });

  // Delete proxy
  const { mutate: deleteProxy } = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/proxy/profiles/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete proxy');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxies'] });
    }
  });

  // Test proxy health
  const { mutate: testProxy } = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/proxy/test/${id}`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to test proxy');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxies'] });
    }
  });

  // Toggle proxy active status
  const { mutate: toggleProxy } = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/proxy/toggle/${id}`, { method: 'PATCH' });
      if (!response.ok) throw new Error('Failed to toggle proxy');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['proxies'] });
    }
  });

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'http',
      host: '',
      port: 8080,
      username: '',
      password: ''
    });
    setEditingId(null);
  };

  const handleEdit = (proxy: ProxyProfile) => {
    setFormData({
      name: proxy.name,
      type: proxy.type as 'http' | 'socks5' | 'socks4',
      host: proxy.host,
      port: proxy.port,
      username: proxy.username || '',
      password: proxy.password || ''
    });
    setEditingId(proxy.id);
    setIsOpen(true);
  };

  const handleSave = () => {
    saveProxy(formData);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'bg-green-100 text-green-800';
      case 'unhealthy': return 'bg-red-100 text-red-800';
      case 'untested': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'healthy': return '✅ سلم';
      case 'unhealthy': return '❌ ناسالم';
      case 'untested': return '❓ آزمایش‌نشده';
      default: return '❓ نامشخص';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-4xl font-bold text-white mb-2 flex items-center gap-3">
                <Globe className="w-8 h-8 text-blue-400" />
                مدیر پروکسی
              </h1>
              <p className="text-gray-400">مدیریت و نظارت بر پروفایل‌های پروکسی</p>
            </div>
            <Dialog open={isOpen} onOpenChange={setIsOpen}>
              <DialogTrigger asChild>
                <Button 
                  onClick={() => resetForm()}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  اضافه کردن پروکسی
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-slate-900 border-slate-700">
                <DialogHeader>
                  <DialogTitle className="text-white">
                    {editingId ? 'ویرایش پروکسی' : 'اضافه کردن پروکسی جدید'}
                  </DialogTitle>
                  <DialogDescription className="text-gray-400">
                    اطلاعات پروکسی را وارد کنید
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">نام پروکسی</label>
                    <Input
                      placeholder="نام‌گذاری پروکسی"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="bg-slate-800 border-slate-700 text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">نوع پروکسی</label>
                    <Select value={formData.type} onValueChange={(value: any) => setFormData({ ...formData, type: value })}>
                      <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-800 border-slate-700">
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                        <SelectItem value="socks4">SOCKS4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">آدرس (Host)</label>
                      <Input
                        placeholder="192.168.1.1"
                        value={formData.host}
                        onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                        className="bg-slate-800 border-slate-700 text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">درگاه (Port)</label>
                      <Input
                        type="number"
                        placeholder="8080"
                        value={formData.port}
                        onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                        className="bg-slate-800 border-slate-700 text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">نام کاربری (اختیاری)</label>
                      <Input
                        placeholder="نام کاربری"
                        value={formData.username}
                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                        className="bg-slate-800 border-slate-700 text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">رمز (اختیاری)</label>
                      <Input
                        type="password"
                        placeholder="رمز عبور"
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="bg-slate-800 border-slate-700 text-white"
                      />
                    </div>
                  </div>

                  <Button
                    onClick={handleSave}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                  >
                    {editingId ? 'ذخیره تغییرات' : 'اضافه کردن پروکسی'}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">کل پروکسی</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-white">{proxies.length}</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">فعال</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-400">{proxies.filter((p: ProxyProfile) => p.rotationPolicy === 'active').length}</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">سلم</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-blue-400">{proxies.filter((p: ProxyProfile) => p.testStatus === 'healthy').length}</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">ناسالم</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-400">{proxies.filter((p: ProxyProfile) => p.testStatus === 'unhealthy').length}</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Proxies List */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {isLoading ? (
            <div className="col-span-2 text-center py-12">
              <div className="text-gray-400">در حال بارگذاری...</div>
            </div>
          ) : proxies.length === 0 ? (
            <Card className="col-span-2 bg-slate-800/50 border-slate-700">
              <CardContent className="py-12 text-center">
                <p className="text-gray-400 mb-4">هیچ پروکسی تعریف نشده است</p>
                <p className="text-sm text-gray-500">برای شروع یک پروکسی جدید اضافه کنید</p>
              </CardContent>
            </Card>
          ) : (
            proxies.map((proxy: ProxyProfile) => (
              <Card key={proxy.id} className="bg-slate-800/50 border-slate-700 hover:border-slate-600 transition">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <CardTitle className="text-lg text-white">{proxy.name}</CardTitle>
                        <Badge variant="outline" className={getStatusColor(proxy.testStatus || 'untested')}>
                          {getStatusLabel(proxy.testStatus || 'untested')}
                        </Badge>
                        {proxy.rotationPolicy === 'active' && (
                          <Badge className="bg-blue-700 text-blue-100">فعال</Badge>
                        )}
                      </div>
                      <CardDescription className="text-gray-400">
                        {proxy.type.toUpperCase()} • {proxy.host}:{proxy.port}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-slate-700/30 rounded p-2">
                      <div className="text-xs text-gray-400">نوع</div>
                      <div className="text-lg font-bold text-blue-400">{proxy.type}</div>
                    </div>
                    <div className="bg-slate-700/30 rounded p-2">
                      <div className="text-xs text-gray-400">درگاه</div>
                      <div className="text-lg font-bold text-blue-400">{proxy.port}</div>
                    </div>
                  </div>

                  {/* Details */}
                  <div className="text-sm text-gray-400 space-y-1">
                    {proxy.lastTested && (
                      <div>آخرین آزمایش: {new Date(proxy.lastTested).toLocaleDateString('fa-IR')}</div>
                    )}
                    {proxy.username && (
                      <div>کاربر: {proxy.username}</div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => testProxy(proxy.id)}
                      className="flex-1 border-slate-600 text-blue-400 hover:bg-slate-700"
                    >
                      <Zap className="w-3 h-3 mr-1" />
                      تست
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleProxy(proxy.id)}
                      className="flex-1 border-slate-600 text-green-400 hover:bg-slate-700"
                    >
                      <RotateCw className="w-3 h-3 mr-1" />
                      تغییر
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleEdit(proxy)}
                      className="flex-1 border-slate-600 text-yellow-400 hover:bg-slate-700"
                    >
                      <Edit2 className="w-3 h-3 mr-1" />
                      ویرایش
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 border-slate-600 text-red-400 hover:bg-slate-700"
                        >
                          <Trash2 className="w-3 h-3 mr-1" />
                          حذف
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="bg-slate-900 border-slate-700">
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white">حذف پروکسی</AlertDialogTitle>
                          <AlertDialogDescription className="text-gray-400">
                            آیا مطمئن‌اید که می‌خواهید {proxy.name} را حذف کنید؟
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogAction
                          onClick={() => deleteProxy(proxy.id)}
                          className="bg-red-600 hover:bg-red-700 text-white"
                        >
                          حذف
                        </AlertDialogAction>
                        <AlertDialogCancel className="border-slate-600">لغو</AlertDialogCancel>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
