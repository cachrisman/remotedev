'use client';

export default function GlobalErrorContent({
  reset,
}: {
  reset: () => void;
}) {
  return (
    <div className="text-center space-y-4">
      <h2 className="text-xl font-semibold">Something went wrong</h2>
      <button
        onClick={reset}
        className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-500 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
