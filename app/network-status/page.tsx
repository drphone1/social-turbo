'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter } from 'recharts';
import { ArrowUpDown, Activity, Wifi, WifiOff, AlertCircle, CheckCircle, Clock, Globe } from 'lucide-react';

interface DiagnosticData {
  id: string;
  timestamp: string;
  endpoint: string;
  latency: number;
  status: 'online' | 'offline';
  packetLoss: number;
  jitter: number;
}

interface NetworkStatus {
  overallStatus: 'healthy' | 'degraded' | 'offline';
  avgLatency: number;
  currentAvgLatency?: number;
  minLatency: number;
  maxLatency: number;
  packetLoss: number;
  uptime: number;
  currentPacketLoss?: number;
  currentUptime?: number;
  currentSampleCount?: number;
  freshnessMinutes?: number;
  lastChecked: string;
  onlineChecks?: number;
  offlineChecks?: number;
  endpoints: {
    name: string;
    latency: number;
    status: 'online' | 'offline';
    packetLoss: number;
    lastChecked?: string | null;
  }[];
  queue?: {
    pending: number;
    retry: number;
    processing: number;
    failed: number;
    actionableFailed?: number;
    historicalFailed?: number;
    resolvedHistoricalFailed?: number;
    orphanedFailed?: number;
    staleProcessing: number;
    corruptedPayloads: number;
    oldestReadyJobMinutes: number;
  };
  accounts?: {
    total: number;
    managedTotal?: number;
    placeholderTotal?: number;
    connected: number;
    connecting: number;
    disconnected: number;
    withLastError: number;
    managedConnected?: number;
    managedConnecting?: number;
    managedDisconnected?: number;
    managedWithLastError?: number;
  };
  worker?: {
    startedAt: string | null;
    lastHeartbeatAt: string | null;
    lastSuccessfulRunAt: string | null;
    consecutiveFailures: number;
    lastRecoveredJobs: number;
    lastError: string | null;
  };
  alerts?: {
    id: string;
    severity: 'info' | 'warning' | 'critical';
    category: 'queue' | 'account' | 'network' | 'worker';
    title: string;
    message: string;
    metric?: number | null;
    createdAt: string;
  }[];
}

export default function NetworkStatusPage() {
  const [dateRange, setDateRange] = useState<'today' | '7days' | '30days' | '90days'>('7days');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch network status
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery({
    queryKey: ['networkStatus', dateRange],
    queryFn: async () => {
      const response = await fetch(`/api/network/status?range=${dateRange}`);
      if (!response.ok) throw new Error('Failed to fetch network status');
      return response.json() as Promise<NetworkStatus>;
    },
    refetchInterval: autoRefresh ? 30000 : false // Auto-refresh every 30 seconds
  });

  // Fetch diagnostics
  const { data: diagnostics = [], isLoading: diagLoading } = useQuery({
    queryKey: ['networkDiagnostics', dateRange],
    queryFn: async () => {
      const response = await fetch(`/api/network/diagnostics?range=${dateRange}`);
      if (!response.ok) throw new Error('Failed to fetch diagnostics');
      return response.json();
    }
  });

  // Fetch latency history
  const { data: latencyHistory = [], isLoading: historyLoading } = useQuery({
    queryKey: ['networkLatency', dateRange],
    queryFn: async () => {
      const response = await fetch(`/api/network/latency?range=${dateRange}`);
      if (!response.ok) throw new Error('Failed to fetch latency history');
      return response.json();
    }
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'bg-green-100 text-green-800';
      case 'degraded': return 'bg-yellow-100 text-yellow-800';
      case 'offline': return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy': return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'degraded': return <AlertCircle className="w-5 h-5 text-yellow-500" />;
      case 'offline': return <WifiOff className="w-5 h-5 text-red-500" />;
      default: return <Wifi className="w-5 h-5 text-gray-500" />;
    }
  };

  const currentUptime = status?.currentUptime ?? status?.uptime ?? 0;
  const currentPacketLoss = status?.currentPacketLoss ?? status?.packetLoss ?? 0;
  const currentAvgLatency = status?.currentAvgLatency ?? status?.avgLatency ?? 0;
  const historicalPacketLoss = status?.packetLoss ?? 0;
  const historicalUptime = status?.uptime ?? 0;
  const historicalAvgLatency = status?.avgLatency ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-4xl font-bold text-white mb-2 flex items-center gap-3">
                <Globe className="w-8 h-8 text-blue-400" />
                وضعیت شبکه
              </h1>
              <p className="text-gray-400">نظارت بر کارایی و تشخیص مشکلات شبکه</p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`border-slate-600 ${autoRefresh ? 'bg-green-700' : 'bg-slate-700'}`}
              >
                <Activity className="w-4 h-4 mr-2" />
                {autoRefresh ? 'خودکار: روشن' : 'خودکار: خاموش'}
              </Button>
              <Button
                onClick={() => refetchStatus()}
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <ArrowUpDown className="w-4 h-4 mr-2" />
                بروز رسانی
              </Button>
            </div>
          </div>

          {/* Date Range Selector */}
          <div className="flex gap-2 mb-6">
            {(['today', '7days', '30days', '90days'] as const).map((range) => (
              <Button
                key={range}
                variant={dateRange === range ? 'default' : 'outline'}
                onClick={() => setDateRange(range)}
                className={dateRange === range ? 'bg-blue-600' : 'border-slate-600'}
              >
                {{
                  'today': 'امروز',
                  '7days': '7 روز',
                  '30days': '30 روز',
                  '90days': '90 روز'
                }[range]}
              </Button>
            ))}
          </div>

          {/* Overall Status Card */}
          {status && (
            <Card className="bg-gradient-to-r from-slate-800/50 to-slate-700/50 border-slate-700 mb-6">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {getStatusIcon(status.overallStatus)}
                    <div>
                      <CardTitle className="text-2xl text-white">وضعیت کلی شبکه</CardTitle>
                      <CardDescription className="text-gray-400">آخرین چک: {new Date(status.lastChecked).toLocaleTimeString('fa-IR')}</CardDescription>
                    </div>
                  </div>
                  <Badge className={getStatusColor(status.overallStatus)}>
                    {{
                      'healthy': '✅ سالم',
                      'degraded': '⚠️ تضعیف‌شده',
                      'offline': '❌ آفلاین'
                    }[status.overallStatus]}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">تاخیر لحظه‌ای</div>
                  <div className="text-2xl font-bold text-cyan-300">{currentAvgLatency.toFixed(0)}ms</div>
                </div>
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">اپ‌تایم لحظه‌ای</div>
                  <div className="text-2xl font-bold text-emerald-300">{currentUptime.toFixed(1)}%</div>
                </div>
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">packet loss لحظه‌ای</div>
                  <div className="text-2xl font-bold text-amber-300">{currentPacketLoss.toFixed(2)}%</div>
                </div>
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">تاخیر تاریخی</div>
                  <div className="text-2xl font-bold text-blue-400">{historicalAvgLatency.toFixed(0)}ms</div>
                </div>
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">فاصله از آخرین چک</div>
                  <div className="text-2xl font-bold text-violet-300">{status.freshnessMinutes?.toFixed(1) || 0}m</div>
                </div>
                <div className="bg-slate-700/30 rounded p-3">
                  <div className="text-sm text-gray-400">تعداد نمونه‌های جاری</div>
                  <div className="text-2xl font-bold text-white">{status.currentSampleCount || 0}</div>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">خوانش لحظه‌ای</CardTitle>
                <CardDescription className="text-gray-500">این بخش برای تصمیم عملیاتی همین الان مهم‌تر است.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm text-gray-300">
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">تاخیر جاری</div><div className="mt-1 text-xl font-bold text-cyan-300">{currentAvgLatency.toFixed(0)}ms</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">اپ‌تایم جاری</div><div className="mt-1 text-xl font-bold text-emerald-300">{currentUptime.toFixed(1)}%</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">packet loss جاری</div><div className="mt-1 text-xl font-bold text-amber-300">{currentPacketLoss.toFixed(2)}%</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">نمونه جاری</div><div className="mt-1 text-xl font-bold text-white">{status?.currentSampleCount || 0}</div></div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">روند تاریخی</CardTitle>
                <CardDescription className="text-gray-500">این بخش تصویر کلی بازه‌ی انتخاب‌شده را نشان می‌دهد.</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm text-gray-300">
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">تاخیر تاریخی</div><div className="mt-1 text-xl font-bold text-blue-400">{historicalAvgLatency.toFixed(0)}ms</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">اپ‌تایم تاریخی</div><div className="mt-1 text-xl font-bold text-yellow-300">{historicalUptime.toFixed(1)}%</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">packet loss تاریخی</div><div className="mt-1 text-xl font-bold text-orange-300">{historicalPacketLoss.toFixed(2)}%</div></div>
                <div className="rounded bg-slate-700/30 p-3"><div className="text-gray-400">آخرین بروزرسانی</div><div className="mt-1 text-xl font-bold text-violet-300">{status?.freshnessMinutes?.toFixed(1) || 0}m</div></div>
              </CardContent>
            </Card>
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">بهترین تاخیر تاریخی</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-green-400">{status?.minLatency.toFixed(0) || 0}ms</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">بدترین تاخیر تاریخی</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-400">{status?.maxLatency.toFixed(0) || 0}ms</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">چک آنلاین</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-yellow-400">{status?.onlineChecks || 0}</div>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-300">چک آفلاین</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-purple-400">{status?.offlineChecks || 0}</div>
              </CardContent>
            </Card>
          </div>

          {status && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-gray-300">سلامت صف اجرا</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-300">
                  <div className="flex items-center justify-between"><span>در انتظار</span><span className="text-white">{status.queue?.pending || 0}</span></div>
                  <div className="flex items-center justify-between"><span>در retry</span><span className="text-yellow-400">{status.queue?.retry || 0}</span></div>
                  <div className="flex items-center justify-between"><span>fail عملیاتی</span><span className="text-red-400">{status.queue?.actionableFailed || 0}</span></div>
                  <div className="flex items-center justify-between"><span>fail تاریخی</span><span className="text-orange-300">{status.queue?.historicalFailed || 0}</span></div>
                  <div className="flex items-center justify-between"><span>fail حل‌شده</span><span className="text-emerald-300">{status.queue?.resolvedHistoricalFailed || 0}</span></div>
                  <div className="flex items-center justify-between"><span>stale processing</span><span className="text-red-300">{status.queue?.staleProcessing || 0}</span></div>
                  <div className="flex items-center justify-between"><span>payload خراب</span><span className="text-amber-300">{status.queue?.corruptedPayloads || 0}</span></div>
                </CardContent>
              </Card>

              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-gray-300">سلامت اکانت‌ها</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-300">
                  <div className="flex items-center justify-between"><span>کل اکانت‌ها</span><span className="text-white">{status.accounts?.total || 0}</span></div>
                  <div className="flex items-center justify-between"><span>اکانت عملیاتی</span><span className="text-white">{status.accounts?.managedTotal || 0}</span></div>
                  <div className="flex items-center justify-between"><span>placeholder</span><span className="text-slate-300">{status.accounts?.placeholderTotal || 0}</span></div>
                  <div className="flex items-center justify-between"><span>متصل عملیاتی</span><span className="text-green-400">{status.accounts?.managedConnected || 0}</span></div>
                  <div className="flex items-center justify-between"><span>در حال اتصال عملیاتی</span><span className="text-blue-400">{status.accounts?.managedConnecting || 0}</span></div>
                  <div className="flex items-center justify-between"><span>قطع عملیاتی</span><span className="text-red-400">{status.accounts?.managedDisconnected || 0}</span></div>
                  <div className="flex items-center justify-between"><span>lastError عملیاتی</span><span className="text-amber-300">{status.accounts?.managedWithLastError || 0}</span></div>
                </CardContent>
              </Card>

              <Card className="bg-slate-800/50 border-slate-700">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-gray-300">وضعیت worker</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-300">
                  <div className="flex items-center justify-between"><span>آخرین heartbeat</span><span className="text-white">{status.worker?.lastHeartbeatAt ? new Date(status.worker.lastHeartbeatAt).toLocaleTimeString('fa-IR') : '-'}</span></div>
                  <div className="flex items-center justify-between"><span>آخرین run موفق</span><span className="text-green-400">{status.worker?.lastSuccessfulRunAt ? new Date(status.worker.lastSuccessfulRunAt).toLocaleTimeString('fa-IR') : '-'}</span></div>
                  <div className="flex items-center justify-between"><span>recover شده</span><span className="text-blue-300">{status.worker?.lastRecoveredJobs || 0}</span></div>
                  <div className="flex items-center justify-between"><span>خطاهای متوالی</span><span className="text-red-300">{status.worker?.consecutiveFailures || 0}</span></div>
                  <div className="text-xs text-amber-200 break-words">{status.worker?.lastError || 'بدون خطای فعال'}</div>
                </CardContent>
              </Card>
            </div>
          )}

          {status?.alerts && status.alerts.length > 0 && (
            <Card className="bg-slate-800/50 border-slate-700 mb-6">
              <CardHeader>
                <CardTitle className="text-white">هشدارهای عملیاتی</CardTitle>
                <CardDescription className="text-gray-400">خروجی مستقیم runtime، queue و connection health</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {status.alerts.map((alert) => (
                  <div key={alert.id} className={`rounded-lg border px-4 py-3 ${
                    alert.severity === 'critical'
                      ? 'border-red-500/40 bg-red-500/10'
                      : alert.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10'
                        : 'border-emerald-500/30 bg-emerald-500/10'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-white">{alert.title}</div>
                      <Badge className={alert.severity === 'critical' ? 'bg-red-700 text-red-100' : alert.severity === 'warning' ? 'bg-amber-700 text-amber-100' : 'bg-emerald-700 text-emerald-100'}>
                        {alert.severity === 'critical' ? 'بحرانی' : alert.severity === 'warning' ? 'هشدار' : 'اطلاعی'}
                      </Badge>
                    </div>
                    <div className="mt-2 text-sm text-gray-300">{alert.message}</div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Latency Trend */}
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">روند تاخیر</CardTitle>
            </CardHeader>
            <CardContent>
              {historyLoading ? (
                <div className="h-64 flex items-center justify-center text-gray-400">در حال بارگذاری...</div>
              ) : latencyHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={latencyHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="time" stroke="#9ca3af" />
                    <YAxis stroke="#9ca3af" />
                    <Tooltip contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155' }} />
                    <Legend />
                    <Line type="monotone" dataKey="latency" stroke="#3b82f6" strokeWidth={2} dot={false} name="تاخیر (ms)" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-64 flex items-center justify-center text-gray-400">داده‌ای موجود نیست</div>
              )}
            </CardContent>
          </Card>

          {/* Endpoint Status Distribution */}
          <Card className="bg-slate-800/50 border-slate-700">
            <CardHeader>
              <CardTitle className="text-white">وضعیت نقاط پایانی</CardTitle>
            </CardHeader>
            <CardContent>
              {statusLoading ? (
                <div className="h-64 flex items-center justify-center text-gray-400">در حال بارگذاری...</div>
              ) : status && status.endpoints.length > 0 ? (
                <div className="space-y-3">
                  {status.endpoints.map((endpoint, index) => (
                    <div key={index} className="flex items-center justify-between bg-slate-700/30 rounded p-3">
                      <div>
                        <div className="font-semibold text-white">{endpoint.name}</div>
                        <div className="text-sm text-gray-400">تاخیر: {endpoint.latency.toFixed(0)}ms</div>
                      </div>
                      <Badge className={endpoint.status === 'online' ? 'bg-green-700 text-green-100' : 'bg-red-700 text-red-100'}>
                        {endpoint.status === 'online' ? '✅ آنلاین' : '❌ آفلاین'}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-gray-400">داده‌ای موجود نیست</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Diagnostics Table */}
        <Card className="bg-slate-800/50 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">تشخیص و جزئیات</CardTitle>
            <CardDescription className="text-gray-400">تاریخچه و جزئیات تمام بررسی‌های شبکه</CardDescription>
          </CardHeader>
          <CardContent>
            {diagLoading ? (
              <div className="text-center py-8 text-gray-400">در حال بارگذاری...</div>
            ) : diagnostics.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-700">
                    <tr>
                      <th className="text-left py-2 text-gray-300">زمان</th>
                      <th className="text-left py-2 text-gray-300">نقطه پایانی</th>
                      <th className="text-left py-2 text-gray-300">تاخیر (ms)</th>
                      <th className="text-left py-2 text-gray-300">وضعیت</th>
                      <th className="text-left py-2 text-gray-300">از‌دست رفتگی</th>
                      <th className="text-left py-2 text-gray-300">تلاطم</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {diagnostics.slice(0, 20).map((diag: DiagnosticData, index: number) => (
                      <tr key={index} className="hover:bg-slate-700/20 transition">
                        <td className="py-3 text-gray-400">{new Date(diag.timestamp).toLocaleTimeString('fa-IR')}</td>
                        <td className="py-3 text-gray-300">{diag.endpoint}</td>
                        <td className="py-3">
                          <span className={diag.latency > 100 ? 'text-red-400' : 'text-green-400'}>
                            {diag.latency.toFixed(0)}
                          </span>
                        </td>
                        <td className="py-3">
                          <Badge className={diag.status === 'online' ? 'bg-green-700' : 'bg-red-700'}>
                            {diag.status === 'online' ? 'آنلاین' : 'آفلاین'}
                          </Badge>
                        </td>
                        <td className="py-3 text-gray-400">{diag.packetLoss.toFixed(2)}%</td>
                        <td className="py-3 text-gray-400">{diag.jitter.toFixed(2)}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-center py-8 text-gray-400">هیچ داده‌ای موجود نیست</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
