'use client';

interface WarningBannerProps {
  subtype: string;
  onDismiss?: () => void;
}

const MESSAGES: Record<string, string> = {
  client_slow: 'Connection is slow — buffering output.',
  parse_degraded: 'Output parse errors detected — streaming raw lines.',
  persistence_degraded: 'Database write failed — gap recovery may use ring buffer only.',
  offline_budget_exceeded: 'Offline transcript budget exceeded — some output may not be recoverable.',
  stale_epoch: 'Session control was taken by another tab.',
};

export function WarningBanner({ subtype, onDismiss }: WarningBannerProps) {
  const message = MESSAGES[subtype] || `Bridge warning: ${subtype}`;

  return (
    <div className="bg-amber-50 dark:bg-amber-900/60 border border-amber-300 dark:border-amber-700 rounded-xl mx-4 px-4 py-3 flex items-center gap-3">
      <span className="text-amber-500 dark:text-amber-400 text-lg">⚠</span>
      <span className="text-sm text-amber-800 dark:text-amber-200 flex-1">{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-amber-500 dark:text-amber-400 text-sm hover:text-amber-700 dark:hover:text-amber-200"
        >
          ✕
        </button>
      )}
    </div>
  );
}
