'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { RefreshCw, TrendingUp, MessageSquare, CheckCircle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function AnalyticsPage() {
  const [dateRange, setDateRange] = useState('7days');

  // Fetch message stats
  const { data: messageStats = {}, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: ['analytics', 'messages', dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/messages?range=${dateRange}`);
      if (!res.ok) throw new Error('Failed to fetch messages');
      return res.json();
    }
  });

  // Fetch auto-reply stats
  const { data: autoReplyStats = {}, isLoading: autoReplyLoading, refetch: refetchAutoReply } = useQuery({
    queryKey: ['analytics', 'auto-reply', dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/auto-reply?range=${dateRange}`);
      if (!res.ok) throw new Error('Failed to fetch auto-reply');
      return res.json();
    }
  });

  // Fetch campaigns stats
  const { data: campaignStats = {}, isLoading: campaignLoading, refetch: refetchCampaigns } = useQuery({
    queryKey: ['analytics', 'campaigns', dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/campaigns?range=${dateRange}`);
      if (!res.ok) throw new Error('Failed to fetch campaigns');
      return res.json();
    }
  });

  // Fetch keywords stats
  const { data: keywordsStats = [], isLoading: keywordsLoading } = useQuery({
    queryKey: ['analytics', 'keywords', dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/keywords?range=${dateRange}`);
      if (!res.ok) throw new Error('Failed to fetch keywords');
      return res.json();
    }
  });

  const handleRefresh = () => {
    refetchMessages();
    refetchAutoReply();
    refetchCampaigns();
  };

  const isLoading = messagesLoading || autoReplyLoading || campaignLoading || keywordsLoading;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 flex items-center gap-3">
              <TrendingUp className="text-blue-600" size={32} />
              تحلیل‌ها و آمار
            </h1>
            <p className="text-gray-600 mt-2">مشاهده عملکرد سیستم و آماری‌ها</p>
          </div>
          <div className="flex gap-3">
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="today">امروز</option>
              <option value="7days">7 روز گذشته</option>
              <option value="30days">30 روز گذشته</option>
              <option value="90days">90 روز گذشته</option>
            </select>
            <Button onClick={handleRefresh} disabled={isLoading} className="gap-2">
              <RefreshCw size={20} />
              بروزرسانی
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Total Messages */}
          <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-blue-100">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-600 text-sm">کل پیام‌های ارسالی</p>
                  <p className="text-3xl font-bold text-blue-600 mt-2">
                    {messageStats.totalMessages || 0}
                  </p>
                  <p className="text-green-600 text-sm mt-1">
                    ↑ {messageStats.messageIncrease || 0}% نسبت به دوره قبل
                  </p>
                </div>
                <MessageSquare className="text-blue-600" size={40} />
              </div>
            </CardContent>
          </Card>

          {/* Auto-Reply Count */}
          <Card className="border-0 shadow-sm bg-gradient-to-br from-purple-50 to-purple-100">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-600 text-sm">پاسخ‌های خودکار ارسال شده</p>
                  <p className="text-3xl font-bold text-purple-600 mt-2">
                    {autoReplyStats.totalAutoReplies || 0}
                  </p>
                  <p className="text-green-600 text-sm mt-1">
                    {((autoReplyStats.totalAutoReplies || 0) / (messageStats.totalMessages || 1) * 100).toFixed(1)}% پاسخ رات
                  </p>
                </div>
                <CheckCircle className="text-purple-600" size={40} />
              </div>
            </CardContent>
          </Card>

          {/* Delivery Success Rate */}
          <Card className="border-0 shadow-sm bg-gradient-to-br from-green-50 to-green-100">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-600 text-sm">میزان موفقیت</p>
                  <p className="text-3xl font-bold text-green-600 mt-2">
                    {campaignStats.successRate || 0}%
                  </p>
                  <p className="text-sm text-gray-600 mt-1">
                    {campaignStats.successCount || 0} از {campaignStats.totalSent || 0}
                  </p>
                </div>
                <CheckCircle className="text-green-600" size={40} />
              </div>
            </CardContent>
          </Card>

          {/* Avg Response Time */}
          <Card className="border-0 shadow-sm bg-gradient-to-br from-orange-50 to-orange-100">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-600 text-sm">میانگین زمان پاسخ</p>
                  <p className="text-3xl font-bold text-orange-600 mt-2">
                    {autoReplyStats.avgResponseTime || 0}s
                  </p>
                  <p className="text-sm text-gray-600 mt-1">
                    Delay: {autoReplyStats.minDelay || 0}s - {autoReplyStats.maxDelay || 0}s
                  </p>
                </div>
                <Clock className="text-orange-600" size={40} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Message Trend */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <CardTitle>الگوی پیام‌های روزانه</CardTitle>
            </CardHeader>
            <CardContent>
              {messagesLoading ? (
                <div className="h-80 flex items-center justify-center text-gray-500">
                  درحال بارگذاری...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={messageStats.dailyData || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="sent" stroke="#3b82f6" name="ارسال شده" />
                    <Line type="monotone" dataKey="delivered" stroke="#10b981" name="تحویل شده" />
                    <Line type="monotone" dataKey="failed" stroke="#ef4444" name="ناموفق" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Auto-Reply Success Rate */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <CardTitle>نسبت موفقیت پاسخ‌های خودکار</CardTitle>
            </CardHeader>
            <CardContent>
              {autoReplyLoading ? (
                <div className="h-80 flex items-center justify-center text-gray-500">
                  درحال بارگذاری...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'موفق', value: autoReplyStats.successCount || 0 },
                        { name: 'ناموفق', value: autoReplyStats.failedCount || 0 }
                      ]}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }: any) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
                      outerRadius={120}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      <Cell fill="#10b981" />
                      <Cell fill="#ef4444" />
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Performance by Provider */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Campaign Performance */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <CardTitle>عملکرد کمپین‌ها</CardTitle>
            </CardHeader>
            <CardContent>
              {campaignLoading ? (
                <div className="h-80 flex items-center justify-center text-gray-500">
                  درحال بارگذاری...
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={campaignStats.campaignData || []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" angle={-45} textAnchor="end" height={100} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="sent" fill="#3b82f6" name="ارسال شده" />
                    <Bar dataKey="delivered" fill="#10b981" name="تحویل شده" />
                    <Bar dataKey="failed" fill="#ef4444" name="ناموفق" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Top Keywords */}
          <Card className="border-0 shadow-sm">
            <CardHeader>
              <CardTitle>کلمات کلیدی پرتکرار</CardTitle>
            </CardHeader>
            <CardContent>
              {keywordsLoading ? (
                <div className="h-80 flex items-center justify-center text-gray-500">
                  درحال بارگذاری...
                </div>
              ) : keywordsStats.length > 0 ? (
                <div className="space-y-3">
                  {keywordsStats.slice(0, 10).map((keyword: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-blue-600 bg-blue-100 px-2 py-1 rounded">
                          #{idx + 1}
                        </span>
                        <span className="font-medium text-gray-900">{keyword.keyword}</span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold text-gray-900">{keyword.count} بار</p>
                        <p className="text-xs text-gray-500">{keyword.percentage}%</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-80 flex items-center justify-center text-gray-500">
                  داده‌ای موجود نیست
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Summary Stats */}
        <Card className="border-0 shadow-sm">
          <CardHeader>
            <CardTitle>خلاصه عملکرد</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 bg-blue-50 rounded-lg">
                <p className="text-gray-600 text-sm">تعداد Rules فعال</p>
                <p className="text-2xl font-bold text-blue-600 mt-2">
                  {autoReplyStats.activeRules || 0}
                </p>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg">
                <p className="text-gray-600 text-sm">تعداد Accounts متصل</p>
                <p className="text-2xl font-bold text-purple-600 mt-2">
                  {messageStats.connectedAccounts || 0}
                </p>
              </div>
              <div className="p-4 bg-green-50 rounded-lg">
                <p className="text-gray-600 text-sm">کل Contacts</p>
                <p className="text-2xl font-bold text-green-600 mt-2">
                  {messageStats.totalContacts || 0}
                </p>
              </div>
              <div className="p-4 bg-orange-50 rounded-lg">
                <p className="text-gray-600 text-sm">کل کمپین‌ها</p>
                <p className="text-2xl font-bold text-orange-600 mt-2">
                  {campaignStats.totalCampaigns || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
