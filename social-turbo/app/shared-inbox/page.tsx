'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { MessageSquare, Send, Archive, Inbox, Pin, MoreVertical, Search, Filter, Paperclip, ImageIcon, FileAudio, FileVideo, FileText } from 'lucide-react';

function detectInboxMediaKind(mediaPath: string) {
  const ext = mediaPath.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) return { label: 'تصویر', icon: ImageIcon };
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return { label: 'ویدیو', icon: FileVideo };
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) return { label: 'صوت', icon: FileAudio };
  return { label: 'فایل', icon: FileText };
}

interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  mediaPath?: string | null;
  messageType?: string;
  timestamp: string;
  isRead: boolean;
  type: 'sent' | 'received';
}

interface Conversation {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
  status: 'open' | 'closed' | 'pending';
  unreadCount: number;
  lastMessage?: string;
  lastMessageAt: string;
  assignedTo?: string;
  isPinned: boolean;
  createdAt: string;
}

export default function SharedInboxPage() {
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed' | 'pending'>('all');
  const [messageInput, setMessageInput] = useState('');
  const [selectedMediaFile, setSelectedMediaFile] = useState<File | null>(null);
  const [selectedMediaPath, setSelectedMediaPath] = useState('');
  const queryClient = useQueryClient();

  // Fetch conversations
  const { data: conversations = [], isLoading: convLoading } = useQuery({
    queryKey: ['conversations', statusFilter],
    queryFn: async () => {
      const url = statusFilter === 'all' 
        ? '/api/conversations' 
        : `/api/conversations?status=${statusFilter}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch conversations');
      return response.json();
    }
  });

  // Fetch messages for selected conversation
  const { data: messages = [], isLoading: msgLoading } = useQuery({
    queryKey: ['messages', selectedConvId],
    queryFn: async () => {
      if (!selectedConvId) return [];
      const response = await fetch(`/api/conversations/${selectedConvId}/messages`);
      if (!response.ok) throw new Error('Failed to fetch messages');
      return response.json();
    },
    enabled: !!selectedConvId
  });

  // Send message
  const uploadMediaMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/uploads/campaign-media', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || 'Failed to upload media');
      return data;
    },
    onSuccess: (data) => {
      setSelectedMediaPath(data.mediaPath || '');
    }
  });

  const { mutate: sendMessage } = useMutation({
    mutationFn: async ({ content, mediaPath }: { content: string; mediaPath?: string }) => {
      if (!selectedConvId) return;
      const response = await fetch(`/api/conversations/${selectedConvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, mediaPath })
      });
      if (!response.ok) throw new Error('Failed to send message');
      return response.json();
    },
    onSuccess: () => {
      setMessageInput('');
      setSelectedMediaFile(null);
      setSelectedMediaPath('');
      queryClient.invalidateQueries({ queryKey: ['messages', selectedConvId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  });

  // Close conversation
  const { mutate: closeConversation } = useMutation({
    mutationFn: async (convId: string) => {
      const response = await fetch(`/api/conversations/${convId}/close`, { method: 'PATCH' });
      if (!response.ok) throw new Error('Failed to close conversation');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setSelectedConvId(null);
    }
  });

  // Pin conversation
  const { mutate: togglePin } = useMutation({
    mutationFn: async (convId: string) => {
      const response = await fetch(`/api/conversations/${convId}/pin`, { method: 'PATCH' });
      if (!response.ok) throw new Error('Failed to toggle pin');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  });

  const selectedConv = conversations.find((c: Conversation) => c.id === selectedConvId);
  const filteredConversations = conversations.filter((c: Conversation) =>
    c.contactName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.contactPhone.includes(searchTerm)
  );

  const selectedUploadedMediaKind = selectedMediaPath ? detectInboxMediaKind(selectedMediaPath) : null;
  const SelectedUploadedMediaIcon = selectedUploadedMediaKind?.icon;

  const pinnedConvs = filteredConversations.filter((c: Conversation) => c.isPinned);
  const unpinnedConvs = filteredConversations.filter((c: Conversation) => !c.isPinned);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-950 to-gray-900 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-4xl font-bold text-white mb-2 flex items-center gap-3">
            <MessageSquare className="w-8 h-8 text-blue-400" />
            صندوق پیام‌های مشترک
          </h1>
          <p className="text-gray-400">مدیریت گفتگوها و پیام‌های مشتری</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Conversations List */}
          <div className="lg:col-span-1">
            <Card className="bg-slate-800/50 border-slate-700 h-[calc(100vh-200px)]">
              <CardHeader>
                <CardTitle className="text-white">گفتگوها</CardTitle>
                <CardDescription className="text-gray-400">{conversations.length} گفتگو</CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col h-full">
                {/* Search */}
                <div className="px-4 py-3 border-b border-slate-700">
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 w-4 h-4 text-gray-400" />
                    <Input
                      placeholder="جستجو..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="bg-slate-700/50 border-slate-600 text-white pl-8"
                    />
                  </div>
                </div>

                {/* Status Filter */}
                <div className="px-4 py-3 border-b border-slate-700 flex gap-2 flex-wrap">
                  {(['all', 'open', 'closed', 'pending'] as const).map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={statusFilter === status ? 'default' : 'outline'}
                      onClick={() => setStatusFilter(status)}
                      className={statusFilter === status ? 'bg-blue-600' : 'border-slate-600'}
                    >
                      {{
                        'all': 'همه',
                        'open': 'باز',
                        'closed': 'بسته',
                        'pending': 'معلق'
                      }[status]}
                    </Button>
                  ))}
                </div>

                {/* Conversations */}
                <div className="flex-1 overflow-y-auto">
                  <div className="space-y-2 p-4">
                    {convLoading ? (
                      <div className="text-center py-8 text-gray-400">در حال بارگذاری...</div>
                    ) : pinnedConvs.length > 0 || unpinnedConvs.length > 0 ? (
                      <>
                        {/* Pinned */}
                        {pinnedConvs.length > 0 && (
                          <>
                            <div className="text-xs text-gray-500 font-semibold px-2 py-1">سنجاق شده</div>
                            {pinnedConvs.map((conv: Conversation) => (
                              <ConversationItem
                                key={conv.id}
                                conv={conv}
                                isSelected={selectedConvId === conv.id}
                                onClick={() => setSelectedConvId(conv.id)}
                              />
                            ))}
                          </>
                        )}

                        {/* Unpinned */}
                        {unpinnedConvs.length > 0 && (
                          <>
                            {pinnedConvs.length > 0 && <div className="h-px bg-slate-700 my-2" />}
                            <div className="text-xs text-gray-500 font-semibold px-2 py-1">دیگر</div>
                            {unpinnedConvs.map((conv: Conversation) => (
                              <ConversationItem
                                key={conv.id}
                                conv={conv}
                                isSelected={selectedConvId === conv.id}
                                onClick={() => setSelectedConvId(conv.id)}
                              />
                            ))}
                          </>
                        )}
                      </>
                    ) : (
                      <div className="text-center py-8 text-gray-400">هیچ گفتگویی نیست</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Chat Area */}
          <div className="lg:col-span-2">
            {selectedConv ? (
              <Card className="bg-slate-800/50 border-slate-700 h-[calc(100vh-200px)] flex flex-col">
                {/* Conversation Header */}
                <CardHeader className="border-b border-slate-700 pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <CardTitle className="text-xl text-white">{selectedConv.contactName}</CardTitle>
                      <CardDescription className="text-gray-400">
                        {selectedConv.contactPhone}
                      </CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={
                        selectedConv.status === 'open' ? 'bg-green-700' :
                        selectedConv.status === 'closed' ? 'bg-gray-700' :
                        'bg-yellow-700'
                      }>
                        {selectedConv.status === 'open' && '✅ باز'}
                        {selectedConv.status === 'closed' && '❌ بسته'}
                        {selectedConv.status === 'pending' && '⏳ معلق'}
                      </Badge>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" className="border-slate-600">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent className="bg-slate-900 border-slate-700">
                          <AlertDialogHeader>
                            <AlertDialogTitle className="text-white">گزینه‌ها</AlertDialogTitle>
                          </AlertDialogHeader>
                          <div className="space-y-2">
                            <Button
                              onClick={() => togglePin(selectedConv.id)}
                              variant="outline"
                              className="w-full border-slate-600"
                            >
                              <Pin className="w-4 h-4 mr-2" />
                              {selectedConv.isPinned ? 'لغو سنجاق' : 'سنجاق کردن'}
                            </Button>
                            <Button
                              onClick={() => closeConversation(selectedConv.id)}
                              variant="outline"
                              className="w-full border-slate-600 text-red-400"
                            >
                              <Archive className="w-4 h-4 mr-2" />
                              بستن گفتگو
                            </Button>
                          </div>
                          <AlertDialogCancel className="border-slate-600">لغو</AlertDialogCancel>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </CardHeader>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="space-y-4">
                    {msgLoading ? (
                      <div className="text-center py-8 text-gray-400">در حال بارگذاری...</div>
                    ) : messages.length > 0 ? (
                      messages.map((msg: Message) => (
                        <div
                          key={msg.id}
                          className={`flex ${msg.type === 'sent' ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
                              msg.type === 'sent'
                                ? 'bg-blue-600 text-white'
                                : 'bg-slate-700 text-gray-200'
                            }`}
                          >
                            {msg.content ? <p>{msg.content}</p> : null}
                            {msg.mediaPath && (() => {
                              const mediaKind = detectInboxMediaKind(msg.mediaPath);
                              const MediaIcon = mediaKind.icon;
                              return (
                                <a
                                  href={`/${msg.mediaPath}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 flex items-center gap-2 rounded-md bg-black/20 px-3 py-2 text-sm underline"
                                >
                                  <MediaIcon className="w-4 h-4" />
                                  <span>{mediaKind.label}</span>
                                </a>
                              );
                            })()}
                            <p className="text-xs text-gray-300 mt-1">
                              {new Date(msg.timestamp).toLocaleTimeString('fa-IR')}
                            </p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-8 text-gray-400">هیچ پیامی نیست</div>
                    )}
                  </div>
                </div>

                {/* Message Input */}
                <div className="border-t border-slate-700 p-4 space-y-3">
                  <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Paperclip className="w-4 h-4 text-blue-400" />
                      <span className="text-sm text-gray-300">ارسال فایل / مدیا</span>
                    </div>
                    <div className="flex flex-col gap-2 lg:flex-row">
                      <Input
                        type="file"
                        onChange={(e) => setSelectedMediaFile(e.target.files?.[0] || null)}
                        className="bg-slate-700/50 border-slate-600 text-white file:mr-3 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1 file:text-white"
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
                    {selectedUploadedMediaKind && SelectedUploadedMediaIcon && (
                      <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-gray-200">
                        <SelectedUploadedMediaIcon className="w-4 h-4 text-blue-400" />
                        <span>فایل آماده ارسال: {selectedUploadedMediaKind.label}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="پیام بنویسید..."
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && (messageInput.trim() || selectedMediaPath)) {
                          sendMessage({ content: messageInput, mediaPath: selectedMediaPath || undefined });
                        }
                      }}
                      className="bg-slate-700/50 border-slate-600 text-white"
                    />
                    <Button
                      onClick={() => (messageInput.trim() || selectedMediaPath) && sendMessage({ content: messageInput, mediaPath: selectedMediaPath || undefined })}
                      className="bg-blue-600 hover:bg-blue-700 text-white"
                    >
                      <Send className="w-4 h-4" />
                    </Button>
                  </div>

                  {/* Quick Replies */}
                  <div className="space-y-2">
                    <p className="text-xs text-gray-400">پاسخ‌های سریع:</p>
                    <div className="grid grid-cols-2 gap-2">
                      {['سلام! چطور می‌تونم کمکتون کنم؟', 'درخواستتون رو دریافت کردم', 'لطفاً کمی صبر کنید', 'متشکریم!'].map((reply, idx) => (
                        <Button
                          key={idx}
                          size="sm"
                          variant="outline"
                          onClick={() => sendMessage({ content: reply })}
                          className="border-slate-600 text-xs h-auto py-2 text-right"
                        >
                          {reply}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="bg-slate-800/50 border-slate-700 h-[calc(100vh-200px)] flex items-center justify-center">
                <div className="text-center">
                  <Inbox className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                  <p className="text-gray-400">گفتگویی را انتخاب کنید</p>
                </div>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Conversation Item Component
function ConversationItem({
  conv,
  isSelected,
  onClick
}: {
  conv: Conversation;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-right p-3 rounded-lg transition ${
        isSelected
          ? 'bg-blue-600/20 border border-blue-500'
          : 'bg-slate-700/20 border border-slate-600 hover:bg-slate-700/40'
      }`}
    >
      <div className="flex items-start justify-between mb-1">
        <div className="flex-1">
          <p className="font-semibold text-white">{conv.contactName}</p>
          <p className="text-xs text-gray-400">{conv.contactPhone}</p>
        </div>
        {conv.unreadCount > 0 && (
          <Badge className="bg-red-600 text-white">
            {conv.unreadCount}
          </Badge>
        )}
      </div>
      <p className="text-sm text-gray-300 truncate">{conv.lastMessage || 'بدون پیام'}</p>
      <p className="text-xs text-gray-500 mt-1">
        {new Date(conv.lastMessageAt).toLocaleTimeString('fa-IR')}
      </p>
    </button>
  );
}
