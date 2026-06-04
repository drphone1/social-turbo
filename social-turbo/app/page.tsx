'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Smartphone, MessageSquare, Megaphone, Users } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export default function Dashboard() {
  const { data: overview, isLoading } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: async () => {
      const res = await fetch('/api/analytics/overview');
      return res.json();
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight text-[#F1F5F9]">Dashboard</h2>
        <p className="text-[#94A3B8] mt-1">Overview of your WhatsApp CRM performance.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-[#1A1A2E]/50 backdrop-blur-md border-white/10 hover:bg-[#16213E] transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[#94A3B8]">Connected Accounts</CardTitle>
            <Smartphone className="h-4 w-4 text-[#06B6D4]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#F1F5F9]">{isLoading ? '...' : overview?.accounts || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-[#1A1A2E]/50 backdrop-blur-md border-white/10 hover:bg-[#16213E] transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[#94A3B8]">Messages Today</CardTitle>
            <MessageSquare className="h-4 w-4 text-[#10B981]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#F1F5F9]">{isLoading ? '...' : overview?.messagesToday || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-[#1A1A2E]/50 backdrop-blur-md border-white/10 hover:bg-[#16213E] transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[#94A3B8]">Active Campaigns</CardTitle>
            <Megaphone className="h-4 w-4 text-[#F59E0B]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#F1F5F9]">{isLoading ? '...' : overview?.campaigns || 0}</div>
          </CardContent>
        </Card>
        <Card className="bg-[#1A1A2E]/50 backdrop-blur-md border-white/10 hover:bg-[#16213E] transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-[#94A3B8]">Total Contacts</CardTitle>
            <Users className="h-4 w-4 text-[#7C3AED]" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-[#F1F5F9]">{isLoading ? '...' : overview?.contacts || 0}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 bg-[#1A1A2E]/50 backdrop-blur-md border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">Messages Overview (Last 7 Days)</CardTitle>
          </CardHeader>
          <CardContent className="pl-2">
            {isLoading ? (
              <div className="h-[300px] flex items-center justify-center text-[#94A3B8]">Loading chart...</div>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={overview?.chartData || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="date" stroke="#94A3B8" style={{ fontSize: '12px' }} />
                  <YAxis stroke="#94A3B8" style={{ fontSize: '12px' }} />
                  <Tooltip 
                    contentStyle={{ 
                      background: '#1A1A2E', 
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: '8px'
                    }}
                    labelStyle={{ color: '#F1F5F9' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="messages" 
                    stroke="#10B981" 
                    isAnimationActive={true}
                    strokeWidth={2}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
        <Card className="col-span-3 bg-[#1A1A2E]/50 backdrop-blur-md border-white/10">
          <CardHeader>
            <CardTitle className="text-[#F1F5F9]">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-[#94A3B8]">Loading...</div>
            ) : overview?.recentActivity && overview.recentActivity.length > 0 ? (
              <div className="space-y-4">
                {overview.recentActivity.map((activity: any) => (
                  <div key={activity.id} className="flex items-start">
                    <span className="relative flex h-2 w-2 mr-4 mt-1">
                      <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-[#7C3AED] opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[#7C3AED]"></span>
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-[#F1F5F9]">{activity.action}</p>
                      <p className="text-xs text-[#94A3B8]">{activity.description}</p>
                      <p className="text-xs text-[#64748B] mt-1">
                        {new Date(activity.createdAt).toLocaleString('fa-IR')}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[#94A3B8] text-center py-8">No recent activity</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
