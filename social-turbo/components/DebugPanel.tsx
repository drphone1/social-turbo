'use client';

import { useState, useEffect, useRef } from 'react';
import { Terminal, X } from 'lucide-react';
import { Button } from './ui/button';

export function DebugPanel() {
  const [showLogPanel, setShowLogPanel] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('whatsapp_turbo_showLogPanel') === 'true';
  });
  const [logPanelHeight, setLogPanelHeight] = useState(() => {
    if (typeof window === 'undefined') return 200;
    const savedHeight = window.localStorage.getItem('whatsapp_turbo_logPanelHeight');
    const parsedHeight = savedHeight ? parseInt(savedHeight, 10) : 200;
    return Number.isFinite(parsedHeight) ? parsedHeight : 200;
  });
  const [isDebugMode, setIsDebugMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('whatsapp_turbo_debugMode') === 'true';
  });
  const [logs, setLogs] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [wsReadyState, setWsReadyState] = useState<number | null>(null);
  const logPanelRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  // Save preferences to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('whatsapp_turbo_debugMode', isDebugMode.toString());
      localStorage.setItem('whatsapp_turbo_logPanelHeight', logPanelHeight.toString());
      localStorage.setItem('whatsapp_turbo_showLogPanel', showLogPanel.toString());
    } catch (error) {
      console.warn('Failed to save debug settings to localStorage:', error);
    }
  }, [isDebugMode, logPanelHeight, showLogPanel]);

  // WebSocket connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket connected for debug panel');
      setWsReadyState(socket.readyState);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.event === 'log') {
          console.log('DebugPanel: WebSocket log event received:', message);
          if (isDebugMode) {
            const logData = message.data;
            const logEntry = `${new Date().toISOString().split('T')[1].slice(0, -1)} - [${logData.level?.toUpperCase() || 'INFO'}] ${logData.message || JSON.stringify(logData)}`;
            console.log('DebugPanel: Adding to log panel:', logEntry);
            setLogs(prev => {
              const newLogs = [...prev, logEntry];
              if (newLogs.length > 500) {
                return newLogs.slice(newLogs.length - 500);
              }
              return newLogs;
            });
          }
        }
      } catch (error) {
        console.error('DebugPanel: Error parsing WebSocket message:', error);
      }
    };

    socket.onclose = () => {
      console.log('DebugPanel: WebSocket disconnected');
      setWsReadyState(socket.readyState);
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, [isDebugMode]);

  // Drag handlers for resizable log panel
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    const startY = e.clientY;
    const startHeight = logPanelHeight;

    const handleDrag = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(100, Math.min(600, startHeight + deltaY));
      setLogPanelHeight(newHeight);
    };

    const handleDragEnd = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleDrag);
      document.removeEventListener('mouseup', handleDragEnd);
    };

    document.addEventListener('mousemove', handleDrag);
    document.addEventListener('mouseup', handleDragEnd);
  };

  const handleClearLogs = () => {
    setLogs([]);
  };

  return (
    <>
      {/* Debug Log Panel */}
      {showLogPanel && (
        <div
          ref={logPanelRef}
          className="fixed bottom-4 right-4 z-[100] w-[calc(100vw-32px)] max-w-[800px] rounded-lg border border-white/10 bg-gray-900/95 backdrop-blur-md shadow-2xl overflow-hidden transition-all duration-200"
          style={{ height: `${logPanelHeight}px` }}
        >
          {/* Drag handle and header */}
          <div 
            className="h-6 bg-gray-800 border-b border-white/10 cursor-ns-resize flex items-center justify-center hover:bg-gray-700 transition-colors"
            onMouseDown={handleDragStart}
          >
            <div className="w-16 h-1 bg-white/30 rounded-full"></div>
          </div>
          
          {/* Header controls */}
          <div className="flex items-center justify-between p-3 border-b border-white/10 bg-gray-800/80">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <Terminal className="w-5 h-5 text-green-400" />
                <span className="font-medium text-white">System Debug Logs</span>
                <button
                  onClick={() => setIsDebugMode(!isDebugMode)}
                  className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                    isDebugMode 
                      ? 'bg-green-600 hover:bg-green-700 text-white' 
                      : 'bg-red-600 hover:bg-red-700 text-white'
                  }`}
                >
                  {isDebugMode ? 'Logs ON' : 'Logs OFF'}
                </button>
                <span className="px-2 py-0.5 bg-gray-700 text-gray-300 text-xs rounded-full border border-gray-600">
                  {logs.length} logs
                </span>
              </div>
              
              <label className="flex items-center space-x-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  className="rounded border-white/30 bg-gray-700 w-4 h-4 accent-green-500"
                  checked={isDebugMode}
                  onChange={(e) => setIsDebugMode(e.target.checked)}
                />
                <span className="text-sm text-gray-300">Enable real-time logs</span>
              </label>
            </div>
            
            <div className="flex items-center space-x-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-xs text-gray-300 hover:text-white hover:bg-gray-700"
                onClick={handleClearLogs}
              >
                Clear All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 text-xs text-gray-300 hover:text-white hover:bg-gray-700"
                onClick={() => setShowLogPanel(false)}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
          
          {/* Log content */}
          <div className="h-[calc(100%-80px)] overflow-y-auto bg-gray-900 font-mono text-sm">
            {logs.length === 0 ? (
              <div className="p-4 text-center text-gray-500 italic">
                {isDebugMode 
                  ? 'Waiting for logs... Enable real-time logs and perform actions.'
                  : 'Logs disabled. Enable real-time logs to see system activity.'}
              </div>
            ) : (
              <div className="p-3 space-y-1">
                {logs.map((log, index) => (
                  <div 
                    key={index} 
                    className={`p-2 rounded hover:bg-gray-800/50 transition-colors ${
                      log.includes('ERROR') || log.includes('error') || log.toLowerCase().includes('fail') ? 'text-red-300' :
                      log.includes('WARN') || log.includes('warning') ? 'text-yellow-300' :
                      log.includes('INFO') || log.includes('info') || log.includes('connected') ? 'text-blue-300' :
                      'text-gray-300'
                    }`}
                  >
                    <span className="text-gray-500 mr-3 select-none">[{index + 1}]</span>
                    {log}
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {/* Footer */}
          <div className="h-8 bg-gray-800/80 border-t border-white/10 px-3 flex items-center justify-between">
            <span className="text-xs text-gray-400">
              WebSocket: {wsReadyState === 1 ? 'Connected' : wsReadyState === 0 ? 'Connecting' : 'Disconnected'}
            </span>
            <span className="text-xs text-gray-400">
              Height: {logPanelHeight}px | {isDragging ? 'Resizing...' : 'Ready'} | {isDebugMode ? 'Live' : 'Paused'}
            </span>
          </div>
        </div>
      )}
      
      {/* Log toggle button (always visible) */}
      <div className="fixed bottom-4 right-4 z-[99]">
        <button
          onClick={() => setShowLogPanel(!showLogPanel)}
          className="bg-gradient-to-r from-red-600 to-red-500 border border-white/10 hover:from-red-700 hover:to-red-600 text-white px-3 py-2 rounded-lg flex items-center gap-2 transition-all duration-200 shadow-lg hover:shadow-xl"
        >
          <Terminal className="w-4 h-4" />
          <span>DEBUG LOGS ({showLogPanel ? 'ON' : 'OFF'})</span>
        </button>
      </div>
    </>
  );
}