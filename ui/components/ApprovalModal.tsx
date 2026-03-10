'use client';

import { useState, useRef, useEffect } from 'react';
import type { PendingApproval } from '../lib/protocol';

interface ApprovalModalProps {
  approval: PendingApproval;
  onApprove: () => void;
  onDeny: () => void;
}

const APPROVE_WORD = 'APPROVE';

function isBashTool(data: Record<string, unknown>): boolean {
  return data.name === 'Bash' || data.type === 'bash';
}

export function ApprovalModal({ approval, onApprove, onDeny }: ApprovalModalProps) {
  const [confirmText, setConfirmText] = useState('');
  const [timeLeft, setTimeLeft] = useState(
    Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000))
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const isBash = isBashTool(approval.data);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0) onDeny();
    }, 1000);
    return () => clearInterval(interval);
  }, [approval.expiresAt, onDeny]);

  const canApprove = isBash ? confirmText === APPROVE_WORD : true;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canApprove) onApprove();
  };

  const toolData = approval.data as {
    name?: string;
    input?: Record<string, unknown>;
    command?: string;
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-end justify-center p-4 z-50">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-lg p-6 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Tool Approval Required
          </h2>
          <span className={`text-sm font-mono ${timeLeft < 10 ? 'text-red-400' : 'text-gray-500 dark:text-gray-400'}`}>
            {timeLeft}s
          </span>
        </div>

        {/* Tool info */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tool</span>
            <span className={`px-2 py-0.5 rounded text-sm font-mono ${
              isBash ? 'bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300' : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
            }`}>
              {toolData.name || 'Unknown'}
            </span>
          </div>

          {/* Command (for Bash) */}
          {isBash && (toolData.input as { command?: string })?.command && (
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Command
              </span>
              <pre className="mt-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm font-mono text-green-700 dark:text-green-300 overflow-x-auto whitespace-pre-wrap break-all">
                {(toolData.input as { command?: string }).command}
              </pre>
            </div>
          )}

          {/* Generic tool input */}
          {!isBash && toolData.input && (
            <div>
              <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                Input
              </span>
              <pre className="mt-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-3 text-sm font-mono text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap break-all text-xs max-h-48">
                {JSON.stringify(toolData.input, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Bash confirmation input */}
        {isBash && (
          <form onSubmit={handleSubmit} className="space-y-2">
            <p className="text-sm text-amber-400">
              Type <span className="font-mono font-bold">APPROVE</span> to confirm execution of this Bash command.
            </p>
            <input
              ref={inputRef}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="Type APPROVE to confirm"
              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-white font-mono placeholder-gray-500 focus:outline-none focus:border-amber-500"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </form>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={onDeny}
            className="flex-1 py-3 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 active:bg-gray-300 dark:active:bg-gray-600 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={canApprove ? onApprove : undefined}
            disabled={!canApprove}
            className={`flex-1 py-3 rounded-xl font-medium transition-colors ${
              canApprove
                ? 'bg-green-700 text-white hover:bg-green-600 active:bg-green-500'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
            }`}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
